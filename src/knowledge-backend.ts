import { AdxKnowledgeRepository, type AdxAuthMode, type AdxResolvedRoute } from "./adx-knowledge.js";
import { type KnowledgeScope, type KnowledgeSnapshot, type KnowledgeStore, type KnowledgeStoreStats } from "./knowledge-store.js";

export type KnowledgeBackendKind = "sqlite" | "adx";

export interface KnowledgeBackendConfig {
  backend: KnowledgeBackendKind;
  adxClusterUrl: string;
  adxAuthMode: AdxAuthMode;
  adxDefaultDatabase: string;
  adxPublicDatabase: string;
}

export interface KnowledgeScopeRoute {
  scope: KnowledgeScope;
  scopeId: string;
  explicitDatabase?: string;
  aliases?: string[];
}

export interface KnowledgeSyncResult extends KnowledgeStoreStats {
  backend: KnowledgeBackendKind;
  database: string;
  routeSource: AdxResolvedRoute["source"] | "local";
  pulled: boolean;
  pushed: boolean;
}

export interface AdxRepositoryLike {
  readonly clusterUrl: string;
  listDatabases(): Promise<string[]>;
  resolveRoute(request: {
    scope: KnowledgeScope;
    scopeId: string;
    explicitDatabase?: string;
    defaultDatabase?: string;
    aliases?: string[];
  }): Promise<AdxResolvedRoute>;
  pullSnapshot(database: string, scope: KnowledgeScope, scopeId: string): Promise<KnowledgeSnapshot | undefined>;
  pushSnapshot(database: string, snapshot: KnowledgeSnapshot): Promise<{ revision: string; bytes: number }>;
  close(): void;
}

export type AdxRepositoryFactory = (config: KnowledgeBackendConfig) => AdxRepositoryLike;

export class KnowledgeBackendCoordinator {
  constructor(
    private readonly config: KnowledgeBackendConfig,
    private readonly repositoryFactory: AdxRepositoryFactory = defaultRepositoryFactory,
  ) {}

  async synchronize(store: KnowledgeStore, route: KnowledgeScopeRoute, applyLocalSources: () => KnowledgeStoreStats): Promise<KnowledgeSyncResult> {
    if (this.config.backend === "sqlite") {
      const stats = applyLocalSources();
      return { ...stats, backend: "sqlite", database: "local", routeSource: "local", pulled: false, pushed: false };
    }
    const repository = this.repository();
    try {
      const resolved = await this.resolve(repository, route);
      const remote = await repository.pullSnapshot(resolved.database, route.scope, route.scopeId);
      if (remote) store.importSnapshot(remote, "replace");
      const stats = applyLocalSources();
      await repository.pushSnapshot(resolved.database, store.exportSnapshot(route.scopeId));
      return { ...stats, backend: "adx", database: resolved.database, routeSource: resolved.source, pulled: Boolean(remote), pushed: true };
    } finally {
      repository.close();
    }
  }

  async push(store: KnowledgeStore, route: KnowledgeScopeRoute): Promise<KnowledgeSyncResult> {
    if (this.config.backend === "sqlite") {
      return { ...store.stats(), backend: "sqlite", database: "local", routeSource: "local", pulled: false, pushed: false };
    }
    const repository = this.repository();
    try {
      const resolved = await this.resolve(repository, route);
      await repository.pushSnapshot(resolved.database, store.exportSnapshot(route.scopeId));
      return { ...store.stats(), backend: "adx", database: resolved.database, routeSource: resolved.source, pulled: false, pushed: true };
    } finally {
      repository.close();
    }
  }

  async pull(store: KnowledgeStore, route: KnowledgeScopeRoute): Promise<KnowledgeSyncResult> {
    if (this.config.backend === "sqlite") {
      return { ...store.stats(), backend: "sqlite", database: "local", routeSource: "local", pulled: false, pushed: false };
    }
    const repository = this.repository();
    try {
      const resolved = await this.resolve(repository, route);
      const remote = await repository.pullSnapshot(resolved.database, route.scope, route.scopeId);
      if (!remote) throw new Error(`ADX database '${resolved.database}' has no snapshot for scope '${route.scopeId}'.`);
      const stats = store.importSnapshot(remote, "replace");
      return { ...stats, backend: "adx", database: resolved.database, routeSource: resolved.source, pulled: true, pushed: false };
    } finally {
      repository.close();
    }
  }

  async listAdxDatabases(): Promise<string[]> {
    if (!this.config.adxClusterUrl) throw new Error("ADX cluster URL is not configured.");
    const repository = this.repository();
    try {
      return await repository.listDatabases();
    } finally {
      repository.close();
    }
  }

  private repository(): AdxRepositoryLike {
    if (!this.config.adxClusterUrl) throw new Error("ADX cluster URL is required when the knowledge backend is ADX.");
    return this.repositoryFactory(this.config);
  }

  private resolve(repository: AdxRepositoryLike, route: KnowledgeScopeRoute): Promise<AdxResolvedRoute> {
    return repository.resolveRoute({
      scope: route.scope,
      scopeId: route.scopeId,
      explicitDatabase: route.explicitDatabase,
      defaultDatabase: route.scope === "public" ? this.config.adxPublicDatabase || this.config.adxDefaultDatabase : undefined,
      aliases: route.aliases,
    });
  }
}

function defaultRepositoryFactory(config: KnowledgeBackendConfig): AdxRepositoryLike {
  return new AdxKnowledgeRepository({
    clusterUrl: config.adxClusterUrl,
    authMode: config.adxAuthMode,
    tenantId: process.env.ATLAS_ADX_TENANT_ID ?? process.env.ATSLA_ADX_TENANT_ID,
    managedIdentityClientId: process.env.ATLAS_ADX_MANAGED_IDENTITY_CLIENT_ID ?? process.env.ATSLA_ADX_MANAGED_IDENTITY_CLIENT_ID,
    applicationClientId: process.env.ATLAS_ADX_APPLICATION_CLIENT_ID ?? process.env.ATSLA_ADX_APPLICATION_CLIENT_ID,
    applicationClientSecret: process.env.ATLAS_ADX_APPLICATION_CLIENT_SECRET ?? process.env.ATSLA_ADX_APPLICATION_CLIENT_SECRET,
  });
}