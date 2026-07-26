import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { type KustoResponseDataSet } from "azure-kusto-data";
import { AdxKnowledgeRepository, parseAdxPortalTarget, type AdxClientLike } from "../src/adx-knowledge.js";
import { KnowledgeBackendCoordinator } from "../src/knowledge-backend.js";
import { SqliteKnowledgeStore, type KnowledgeSnapshot } from "../src/knowledge-store.js";

class FakeAdxClient implements AdxClientLike {
  readonly management: Array<{ database: string | null; command: string }> = [];
  readonly snapshots = new Map<string, KnowledgeSnapshot>();

  constructor(readonly databases: string[]) {}

  async execute(database: string | null, query: string): Promise<KustoResponseDataSet> {
    const scope = /Scope == '([^']+)'/.exec(query)?.[1];
    const scopeId = /ScopeId == '([^']+)'/.exec(query)?.[1];
    const snapshot = database && scope && scopeId ? this.snapshots.get(`${database}:${scope}:${scopeId}`) : undefined;
    if (!snapshot) return result([]);
    const json = JSON.stringify(snapshot);
    return result([{
      Payload: gzipSync(Buffer.from(json)).toString("base64"),
      ContentHash: createHash("sha256").update(json).digest("hex"),
    }]);
  }

  async executeMgmt(database: string | null, command: string): Promise<KustoResponseDataSet> {
    this.management.push({ database, command });
    if (command.startsWith(".show databases")) return result(this.databases.map((DatabaseName) => ({ DatabaseName })));
    return result([]);
  }

  close(): void {}
}

function result(rows: Array<Record<string, unknown>>): KustoResponseDataSet {
  return {
    primaryResults: [{ toJSON: () => ({ name: "PrimaryResult", data: rows }) }],
  } as unknown as KustoResponseDataSet;
}

function snapshot(scopeId = "northwind-client"): KnowledgeSnapshot {
  return {
    format: "atsla-knowledge-snapshot",
    version: 1,
    scope: "client",
    scopeId,
    exportedAt: "2026-07-25T12:00:00.000Z",
    documents: [],
    policies: [],
    proposals: [],
  };
}

describe("ADX knowledge repository", () => {
  it("parses a Data Explorer portal link without persisting the portal host", () => {
    expect(parseAdxPortalTarget("https://dataexplorer.azure.com/clusters/example.southcentralus/databases/client-database")).toEqual({
      clusterUrl: "https://example.southcentralus.kusto.windows.net",
      database: "client-database",
    });
    expect(() => parseAdxPortalTarget("http://example.southcentralus.kusto.windows.net")).toThrow("HTTPS");
    expect(() => parseAdxPortalTarget("https://untrusted.example.test")).toThrow("Kusto hostname");
  });

  it("routes by explicit, default, and exact client name without model input", async () => {
    const client = new FakeAdxClient(["client-database", "northwind-client"]);
    const repository = new AdxKnowledgeRepository({ clusterUrl: "https://example.southcentralus.kusto.windows.net", authMode: "azure-cli" }, client);

    await expect(repository.resolveRoute({ scope: "client", scopeId: "northwind-client", explicitDatabase: "client-database" })).resolves.toMatchObject({ database: "client-database", source: "explicit" });
    await expect(repository.resolveRoute({ scope: "client", scopeId: "northwind-client", defaultDatabase: "client-database" })).resolves.toMatchObject({ database: "client-database", source: "default" });
    await expect(repository.resolveRoute({ scope: "client", scopeId: "northwind-client" })).resolves.toMatchObject({ database: "northwind-client", source: "name-match" });
    await expect(repository.resolveRoute({ scope: "client", scopeId: "northwind-client", explicitDatabase: "missing" })).rejects.toThrow("not accessible");
  });

  it("discovers exactly one existing scope and rejects ambiguous or absent routes", async () => {
    const client = new FakeAdxClient(["client-one", "client-two"]);
    const repository = new AdxKnowledgeRepository({ clusterUrl: "https://example.southcentralus.kusto.windows.net", authMode: "azure-cli" }, client);
    client.snapshots.set("client-two:client:northwind-client", snapshot());
    await expect(repository.resolveRoute({ scope: "client", scopeId: "northwind-client" })).resolves.toMatchObject({ database: "client-two", source: "scope-discovery" });

    client.snapshots.set("client-one:client:northwind-client", snapshot());
    await expect(repository.resolveRoute({ scope: "client", scopeId: "northwind-client" })).rejects.toThrow("multiple ADX databases");
    client.snapshots.clear();
    await expect(repository.resolveRoute({ scope: "client", scopeId: "northwind-client" })).rejects.toThrow("No ADX database could be safely matched");
  });

  it("writes compressed snapshots and verifies pulled content hashes", async () => {
    const client = new FakeAdxClient(["client-database"]);
    const repository = new AdxKnowledgeRepository({ clusterUrl: "https://example.southcentralus.kusto.windows.net", authMode: "azure-cli" }, client);
    const payload = { ...snapshot(), documents: [{
      id: "document-id",
      sourcePath: "knowledge/support.md",
      title: "Support",
      sourceKind: "file-import",
      classification: "client" as const,
      status: "approved" as const,
      contentHash: "hash",
      createdAt: "2026-07-25T12:00:00.000Z",
      updatedAt: "2026-07-25T12:00:00.000Z",
      versions: [{ content: "ADX_SNAPSHOT_CANARY", contentHash: "hash", sourceKind: "file-import", createdAt: "2026-07-25T12:00:00.000Z" }],
    }] };
    await repository.pushSnapshot("client-database", payload);
    expect(client.management.some((item) => item.command.includes(".create-merge table AtslaKnowledgeSnapshots"))).toBe(true);
    const ingestRequest = client.management.find((item) => item.command.includes(".ingest inline"));
    expect(ingestRequest?.database).toBe("client-database");
    const ingest = ingestRequest?.command ?? "";
    expect(ingest).not.toContain("ADX_SNAPSHOT_CANARY");

    client.snapshots.set("client-database:client:northwind-client", payload);
    await expect(repository.pullSnapshot("client-database", "client", "northwind-client")).resolves.toEqual(payload);
  });

  it("treats a nested Azure semantic missing-table response as an empty database", async () => {
    const client = new FakeAdxClient(["new-client"]);
    client.execute = async () => {
      const error = Object.assign(new Error("Request failed with status code 400"), {
        response: { data: { error: { "@message": "Semantic error: Failed to resolve table named 'AtslaKnowledgeSnapshots'" } } },
      });
      throw error;
    };
    const repository = new AdxKnowledgeRepository({ clusterUrl: "https://example.southcentralus.kusto.windows.net", authMode: "azure-cli" }, client);

    await expect(repository.pullSnapshot("new-client", "client", "new-client")).resolves.toBeUndefined();
  });

  it("materializes remote knowledge, refreshes local imports, and pushes the merged snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "atsla-adx-materialization-"));
    const local = new SqliteKnowledgeStore("client", join(root, "client.sqlite"));
    const remoteSource = new SqliteKnowledgeStore("client", join(root, "remote.sqlite"));
    const fakeClient = new FakeAdxClient(["client-database"]);
    const repository = new AdxKnowledgeRepository({ clusterUrl: "https://example.southcentralus.kusto.windows.net", authMode: "azure-cli" }, fakeClient);
    try {
      const proposal = remoteSource.createProposal({
        operation: "upsert",
        sourcePath: "ai/approved.md",
        title: "Approved remote",
        content: "REMOTE_APPROVED_CANARY",
      });
      remoteSource.reviewProposal(proposal.id, "approve");
      fakeClient.snapshots.set("client-database:client:northwind-client", remoteSource.exportSnapshot("northwind-client"));
      const backend = new KnowledgeBackendCoordinator({
        backend: "adx",
        adxClusterUrl: repository.clusterUrl,
        adxAuthMode: "azure-cli",
        adxDefaultDatabase: "client-database",
        adxPublicDatabase: "",
      }, () => repository);

      const synced = await backend.synchronize(local, { scope: "client", scopeId: "northwind-client", explicitDatabase: "client-database" }, () => local.sync([
        { sourcePath: "knowledge/local.md", title: "Local", content: "LOCAL_IMPORT_CANARY" },
      ], []));
      expect(synced).toMatchObject({ backend: "adx", database: "client-database", pulled: true, pushed: true });
      const recalled = local.recall("canary").map((item) => item.content).join(" ");
      expect(recalled).toContain("REMOTE_APPROVED_CANARY");
      expect(recalled).toContain("LOCAL_IMPORT_CANARY");
      expect(fakeClient.management.find((item) => item.command.includes(".ingest inline"))?.database).toBe("client-database");
    } finally {
      local.close();
      remoteSource.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reserves the configured default database for public knowledge", async () => {
    const root = mkdtempSync(join(tmpdir(), "atsla-adx-public-default-"));
    const local = new SqliteKnowledgeStore("client", join(root, "client.sqlite"));
    const publicStore = new SqliteKnowledgeStore("public", join(root, "public.sqlite"));
    const fakeClient = new FakeAdxClient(["public-default"]);
    const repository = new AdxKnowledgeRepository({ clusterUrl: "https://example.southcentralus.kusto.windows.net", authMode: "azure-cli" }, fakeClient);
    const backend = new KnowledgeBackendCoordinator({
      backend: "adx",
      adxClusterUrl: repository.clusterUrl,
      adxAuthMode: "azure-cli",
      adxDefaultDatabase: "public-default",
      adxPublicDatabase: "",
    }, () => repository);
    try {
      await expect(backend.push(local, { scope: "client", scopeId: "unknown-client" })).rejects.toThrow("No ADX database could be safely matched");
      await expect(backend.push(publicStore, { scope: "public", scopeId: "public-knowledge" })).resolves.toMatchObject({ database: "public-default", routeSource: "default" });
    } finally {
      local.close();
      publicStore.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never constructs an ADX repository in SQLite mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "atsla-sqlite-backend-"));
    const local = new SqliteKnowledgeStore("client", join(root, "client.sqlite"));
    try {
      const backend = new KnowledgeBackendCoordinator({
        backend: "sqlite",
        adxClusterUrl: "",
        adxAuthMode: "azure-cli",
        adxDefaultDatabase: "",
        adxPublicDatabase: "",
      }, () => { throw new Error("ADX repository must not be constructed"); });
      await expect(backend.synchronize(local, { scope: "client", scopeId: "northwind-client" }, () => local.sync([], []))).resolves.toMatchObject({ backend: "sqlite", database: "local" });
    } finally {
      local.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});