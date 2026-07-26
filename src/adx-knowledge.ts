import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { DeviceCodeCredential, InteractiveBrowserCredential, useIdentityPlugin } from "@azure/identity";
import { cachePersistencePlugin } from "@azure/identity-cache-persistence";
import { type TokenCredential } from "@azure/core-auth";
import { PublicClientApplication, type ICachePlugin } from "@azure/msal-node";
import keytar from "keytar";
import { Client as KustoClient, CloudSettings, KustoConnectionStringBuilder, type KustoResponseDataSet } from "azure-kusto-data";
import { type KnowledgeScope, type KnowledgeSnapshot } from "./knowledge-store.js";

useIdentityPlugin(cachePersistencePlugin);

export type AdxAuthMode = "device-code" | "interactive-browser" | "azure-cli" | "managed-identity" | "application";

export interface AdxKnowledgeConfig {
  clusterUrl: string;
  authMode: AdxAuthMode;
  tenantId?: string;
  managedIdentityClientId?: string;
  applicationClientId?: string;
  applicationClientSecret?: string;
}

export interface AdxPortalTarget {
  clusterUrl: string;
  database?: string;
}

export interface AdxRouteRequest {
  scope: KnowledgeScope;
  scopeId: string;
  explicitDatabase?: string;
  defaultDatabase?: string;
  aliases?: string[];
}

export interface AdxResolvedRoute {
  clusterUrl: string;
  database: string;
  source: "explicit" | "default" | "name-match" | "scope-discovery";
}

export interface AdxClientLike {
  execute(database: string | null, query: string): Promise<KustoResponseDataSet>;
  executeMgmt(database: string | null, command: string): Promise<KustoResponseDataSet>;
  close(): void;
}

const snapshotsTable = "AtslaKnowledgeSnapshots";
const maxSnapshotBytes = 16 * 1024 * 1024;
const azureDeveloperClientId = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";
const identityCacheService = "Microsoft.Developer.IdentityService";
const identityCacheAccount = "MSALCache";
const interactiveCredentials = new Map<string, TokenCredential>();
const deviceCodeCredentials = new Map<string, TokenCredential>();

export class AdxKnowledgeRepository {
  readonly clusterUrl: string;
  private readonly client: AdxClientLike;

  constructor(config: AdxKnowledgeConfig, client?: AdxClientLike) {
    this.clusterUrl = normalizeAdxClusterUrl(config.clusterUrl);
    this.client = client ?? new KustoClient(buildConnection(config, this.clusterUrl));
  }

  async listDatabases(): Promise<string[]> {
    const result = await this.client.executeMgmt(null, ".show databases | project DatabaseName");
    return resultRows<{ DatabaseName?: unknown }>(result)
      .map((row) => String(row.DatabaseName ?? "").trim())
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
  }

  async ensureSchema(database: string): Promise<void> {
    const safeDatabase = validateAdxDatabaseName(database);
    await this.client.executeMgmt(safeDatabase, `.create-merge table ${snapshotsTable} (Scope:string, ScopeId:string, Revision:string, ExportedAt:datetime, ContentHash:string, Payload:string)`);
    await this.client.executeMgmt(safeDatabase, `.show table ${snapshotsTable} cslschema`);
  }

  async pushSnapshot(database: string, snapshot: KnowledgeSnapshot): Promise<{ revision: string; bytes: number }> {
    validateRemoteSnapshot(snapshot);
    const safeDatabase = validateAdxDatabaseName(database);
    await this.ensureSchema(safeDatabase);
    const json = JSON.stringify(snapshot);
    const bytes = Buffer.byteLength(json);
    if (bytes > maxSnapshotBytes) throw new Error(`Knowledge snapshot exceeds the ${maxSnapshotBytes} byte ADX transfer limit.`);
    const contentHash = createHash("sha256").update(json).digest("hex");
    const revision = `${snapshot.exportedAt}:${contentHash.slice(0, 16)}`;
    const payload = gzipSync(Buffer.from(json)).toString("base64");
    const row = [snapshot.scope, snapshot.scopeId, revision, snapshot.exportedAt, contentHash, payload].map(csvField).join(",");
    await this.client.executeMgmt(safeDatabase, `.ingest inline into table ${snapshotsTable} with (format='csv') <|\n${row}`);
    return { revision, bytes };
  }

  async pullSnapshot(database: string, scope: KnowledgeScope, scopeId: string): Promise<KnowledgeSnapshot | undefined> {
    const safeDatabase = validateAdxDatabaseName(database);
    const query = `${snapshotsTable}
| where Scope == '${kqlString(scope)}' and ScopeId == '${kqlString(scopeId)}'
| order by ExportedAt desc, Revision desc
| take 1
| project Payload, ContentHash`;
    let rows: Array<{ Payload?: unknown; ContentHash?: unknown }>;
    try {
      rows = resultRows(await this.client.execute(safeDatabase, query));
    } catch (error) {
      if (isMissingTableError(error)) return undefined;
      throw error;
    }
    if (!rows.length) return undefined;
    const payload = String(rows[0].Payload ?? "");
    const expectedHash = String(rows[0].ContentHash ?? "");
    if (!payload || !expectedHash) throw new Error("ADX returned an incomplete knowledge snapshot record.");
    const json = gunzipSync(Buffer.from(payload, "base64")).toString("utf8");
    const actualHash = createHash("sha256").update(json).digest("hex");
    if (actualHash !== expectedHash) throw new Error("ADX knowledge snapshot failed its content hash check.");
    const snapshot = JSON.parse(json) as KnowledgeSnapshot;
    validateRemoteSnapshot(snapshot, scope, scopeId);
    return snapshot;
  }

  async resolveRoute(request: AdxRouteRequest): Promise<AdxResolvedRoute> {
    const databases = await this.listDatabases();
    if (!databases.length) throw new Error("No accessible ADX databases were discovered.");
    const byLowerName = new Map(databases.map((database) => [database.toLowerCase(), database]));
    const configured = [
      [request.explicitDatabase, "explicit"],
      [request.defaultDatabase, "default"],
    ] as const;
    for (const [candidate, source] of configured) {
      if (!candidate?.trim()) continue;
      const match = byLowerName.get(candidate.trim().toLowerCase());
      if (!match) throw new Error(`Configured ADX database '${candidate.trim()}' is not accessible on the selected cluster.`);
      return { clusterUrl: this.clusterUrl, database: match, source };
    }

    const nameCandidates = [request.scopeId, ...(request.aliases ?? [])]
      .flatMap((value) => databaseNameCandidates(value));
    const nameMatches = [...new Set(nameCandidates.map((candidate) => byLowerName.get(candidate.toLowerCase())).filter((value): value is string => Boolean(value)))];
    if (nameMatches.length === 1) return { clusterUrl: this.clusterUrl, database: nameMatches[0], source: "name-match" };
    if (nameMatches.length > 1) throw new Error(`ADX database routing is ambiguous: ${nameMatches.join(", ")}. Configure an explicit database.`);

    const containing: string[] = [];
    for (const database of databases) {
      if (await this.pullSnapshot(database, request.scope, request.scopeId)) containing.push(database);
    }
    if (containing.length === 1) return { clusterUrl: this.clusterUrl, database: containing[0], source: "scope-discovery" };
    if (containing.length > 1) throw new Error(`Knowledge scope '${request.scopeId}' exists in multiple ADX databases: ${containing.join(", ")}. Configure an explicit database.`);
    throw new Error(`No ADX database could be safely matched to knowledge scope '${request.scopeId}'. Configure a default or explicit database.`);
  }

  close(): void {
    this.client.close();
  }
}

export function parseAdxPortalTarget(value: string): AdxPortalTarget {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("ADX cluster URL is required.");
  const url = new URL(trimmed);
  if (url.protocol !== "https:") throw new Error("ADX cluster URLs must use HTTPS.");
  if (url.hostname.toLowerCase() === "dataexplorer.azure.com") {
    const match = /^\/clusters\/([^/]+)(?:\/databases\/([^/]+))?\/?$/i.exec(url.pathname);
    if (!match) throw new Error("The Azure Data Explorer portal URL does not identify a cluster.");
    const clusterReference = decodeURIComponent(match[1]);
    const clusterUrl = clusterReference.startsWith("https://")
      ? normalizeAdxClusterUrl(clusterReference)
      : normalizeAdxClusterUrl(`https://${clusterReference}.kusto.windows.net`);
    return { clusterUrl, ...(match[2] ? { database: decodeURIComponent(match[2]) } : {}) };
  }
  return { clusterUrl: normalizeAdxClusterUrl(url.toString()) };
}

export function normalizeAdxClusterUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:") throw new Error("ADX cluster URLs must use HTTPS.");
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(".kusto.windows.net") && !host.endsWith(".kusto.fabric.microsoft.com")) {
    throw new Error("ADX cluster URL must use an Azure Data Explorer or Fabric Kusto hostname.");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function buildConnection(config: AdxKnowledgeConfig, clusterUrl: string): KustoConnectionStringBuilder {
  if (config.authMode === "device-code") {
    return KustoConnectionStringBuilder.withTokenCredential(clusterUrl, deviceCodeCredential(config));
  }
  if (config.authMode === "interactive-browser") {
    return KustoConnectionStringBuilder.withTokenCredential(clusterUrl, interactiveCredential(config, clusterUrl));
  }
  if (config.authMode === "azure-cli") return KustoConnectionStringBuilder.withAzLoginIdentity(clusterUrl, config.tenantId);
  if (config.authMode === "managed-identity") {
    return config.managedIdentityClientId
      ? KustoConnectionStringBuilder.withUserManagedIdentity(clusterUrl, config.managedIdentityClientId, config.tenantId)
      : KustoConnectionStringBuilder.withSystemManagedIdentity(clusterUrl, config.tenantId);
  }
  if (!config.applicationClientId || !config.applicationClientSecret || !config.tenantId) {
    throw new Error("ADX application authentication requires client ID, client secret, and tenant ID environment variables.");
  }
  return KustoConnectionStringBuilder.withAadApplicationKeyAuthentication(clusterUrl, config.applicationClientId, config.applicationClientSecret, config.tenantId);
}

function deviceCodeCredential(config: AdxKnowledgeConfig): TokenCredential {
  const tenantId = config.tenantId?.trim();
  const key = tenantId || "common";
  const cached = deviceCodeCredentials.get(key);
  if (cached) return cached;
  const fallback = new DeviceCodeCredential({
    ...(tenantId ? { tenantId } : {}),
    userPromptCallback: (info) => console.log(info.message),
    tokenCachePersistenceOptions: tokenCacheOptions(),
  });
  const msal = new PublicClientApplication({
    auth: {
      clientId: azureDeveloperClientId,
      authority: "https://login.microsoftonline.com/organizations",
    },
    cache: { cachePlugin: secureMsalCachePlugin() },
  });
  const credential: TokenCredential = {
    async getToken(scopes, options) {
      const activeScopes = Array.isArray(scopes) ? scopes : [scopes];
      const accounts = await msal.getTokenCache().getAllAccounts();
      for (const account of accounts) {
        try {
          const result = await msal.acquireTokenSilent({ account, scopes: activeScopes });
          if (result?.accessToken) {
            return { token: result.accessToken, expiresOnTimestamp: result.expiresOn?.getTime() ?? Date.now() + 3_600_000 };
          }
        } catch {}
      }
      return fallback.getToken(scopes, options);
    },
  };
  deviceCodeCredentials.set(key, credential);
  return credential;
}

function secureMsalCachePlugin(): ICachePlugin {
  return {
    async beforeCacheAccess(context) {
      const serialized = await keytar.getPassword(identityCacheService, identityCacheAccount);
      if (serialized) context.tokenCache.deserialize(serialized);
    },
    async afterCacheAccess(context) {
      if (context.cacheHasChanged) {
        await keytar.setPassword(identityCacheService, identityCacheAccount, context.tokenCache.serialize());
      }
    },
  };
}

function interactiveCredential(config: AdxKnowledgeConfig, clusterUrl: string): TokenCredential {
  const tenantId = config.tenantId?.trim() || "consumers";
  const loginHint = process.env.ATSLA_ADX_LOGIN_HINT?.trim() || "";
  const key = `${clusterUrl}\0${tenantId}\0${loginHint}`;
  const cached = interactiveCredentials.get(key);
  if (cached) return cached;
  let delegate: InteractiveBrowserCredential | undefined;
  const credential: TokenCredential = {
    async getToken(scopes, options) {
      if (!delegate) {
        const cloudInfo = await CloudSettings.getCloudInfoForCluster(clusterUrl);
        delegate = new InteractiveBrowserCredential({
          tenantId,
          clientId: cloudInfo.KustoClientAppId,
          ...(loginHint ? { loginHint } : {}),
          tokenCachePersistenceOptions: tokenCacheOptions(),
        });
      }
      return delegate.getToken(scopes, options);
    },
  };
  interactiveCredentials.set(key, credential);
  return credential;
}

function tokenCacheOptions(): { enabled: true; name: string; unsafeAllowUnencryptedStorage: boolean } {
  return {
    enabled: true,
    name: "atsla-adx",
    unsafeAllowUnencryptedStorage: process.env.ATSLA_ADX_ALLOW_UNENCRYPTED_TOKEN_CACHE === "true",
  };
}

function resultRows<T extends Record<string, unknown>>(result: KustoResponseDataSet): T[] {
  const table = result.primaryResults[0];
  return table ? table.toJSON<T>().data : [];
}

export function validateAdxDatabaseName(value: string): string {
  const database = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 _.()-]{0,127}$/.test(database)) throw new Error("ADX database name contains unsupported characters.");
  return database;
}

function databaseNameCandidates(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return [...new Set([trimmed, slug, `atsla-${slug}`].filter(Boolean))];
}

function kqlString(value: string): string {
  return value.replaceAll("'", "''");
}

function csvField(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function validateRemoteSnapshot(snapshot: KnowledgeSnapshot, expectedScope?: KnowledgeScope, expectedScopeId?: string): void {
  if (snapshot.format !== "atsla-knowledge-snapshot" || snapshot.version !== 1) throw new Error("Unsupported ADX knowledge snapshot format.");
  if (expectedScope && snapshot.scope !== expectedScope) throw new Error("ADX knowledge snapshot scope does not match the requested scope.");
  if (expectedScopeId && snapshot.scopeId !== expectedScopeId) throw new Error("ADX knowledge snapshot identifier does not match the requested scope.");
  if (!/^[a-z0-9][a-z0-9._-]{2,127}$/.test(snapshot.scopeId)) throw new Error("ADX knowledge snapshot has an invalid scope identifier.");
}

function isMissingTableError(error: unknown): boolean {
  const responseData = error && typeof error === "object" && "response" in error
    ? (error as { response?: { data?: unknown } }).response?.data
    : undefined;
  const text = `${error instanceof Error ? error.message : String(error)} ${safeErrorJson(responseData)}`;
  return /AtslaKnowledgeSnapshots|table.*not.*found|semantic error/i.test(text);
}

function safeErrorJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return ""; }
}