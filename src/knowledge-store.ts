import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type KnowledgeScope = "public" | "client";

export interface KnowledgeDocumentInput {
  sourcePath: string;
  title: string;
  content: string;
  classification?: "public" | "client" | "restricted";
}

export interface KnowledgePolicyInput {
  sourcePath: string;
  content: string;
}

export interface KnowledgeRecallItem {
  documentId: string;
  sourcePath: string;
  title: string;
  content: string;
  scope: KnowledgeScope;
}

export interface KnowledgeStoreStats {
  documents: number;
  chunks: number;
  characters: number;
}

export type KnowledgeProposalOperation = "upsert" | "retire";

export interface KnowledgeProposalPayload {
  sourcePath: string;
  title?: string;
  content?: string;
}

export interface KnowledgeProposal {
  id: string;
  scope: KnowledgeScope;
  operation: KnowledgeProposalOperation;
  payload: KnowledgeProposalPayload;
  evidenceSessionId: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  reviewedAt: string;
  reviewedBy: string;
}

export interface CreateKnowledgeProposal {
  operation: KnowledgeProposalOperation;
  sourcePath: string;
  title?: string;
  content?: string;
  evidenceSessionId?: string;
}

export interface KnowledgeDocumentVersion {
  content: string;
  contentHash: string;
  sourceKind: string;
  createdAt: string;
}

export interface PortableKnowledgeDocument {
  id: string;
  sourcePath: string;
  title: string;
  sourceKind: string;
  classification: "public" | "client" | "restricted";
  status: "approved" | "retired";
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  versions: KnowledgeDocumentVersion[];
}

export interface PortableKnowledgePolicy {
  id: string;
  sourcePath: string;
  content: string;
  contentHash: string;
  status: "active" | "retired";
  updatedAt: string;
}

export interface KnowledgeSnapshot {
  format: "atsla-knowledge-snapshot";
  version: 1;
  scope: KnowledgeScope;
  scopeId: string;
  exportedAt: string;
  documents: PortableKnowledgeDocument[];
  policies: PortableKnowledgePolicy[];
  proposals: KnowledgeProposal[];
}

export interface KnowledgeStore {
  readonly scope: KnowledgeScope;
  sync(documents: KnowledgeDocumentInput[], policies: KnowledgePolicyInput[]): KnowledgeStoreStats;
  recall(query: string, options?: { maxCharacters?: number; maxChunks?: number }): KnowledgeRecallItem[];
  policies(): string;
  stats(): KnowledgeStoreStats;
  createProposal(input: CreateKnowledgeProposal): KnowledgeProposal;
  listProposals(status?: KnowledgeProposal["status"] | "all"): KnowledgeProposal[];
  reviewProposal(id: string, decision: "approve" | "reject", reviewedBy?: string): KnowledgeProposal;
  exportSnapshot(scopeId: string): KnowledgeSnapshot;
  importSnapshot(snapshot: KnowledgeSnapshot, mode?: "merge" | "replace"): KnowledgeStoreStats;
  close(): void;
}

interface StoredChunkRow {
  id: string;
  document_id: string;
  source_path: string;
  title: string;
  content: string;
}

interface StoredProposalRow {
  id: string;
  operation: KnowledgeProposalOperation;
  payload: string;
  evidence_session_id: string;
  status: KnowledgeProposal["status"];
  created_at: string;
  reviewed_at: string;
  reviewed_by: string;
}

interface StoredDocumentRow {
  id: string;
  source_path: string;
  title: string;
  source_kind: string;
  classification: PortableKnowledgeDocument["classification"];
  content_hash: string;
  status: PortableKnowledgeDocument["status"];
  created_at: string;
  updated_at: string;
}

interface StoredVersionRow {
  document_id: string;
  content: string;
  content_hash: string;
  source_kind: string;
  created_at: string;
}

interface StoredPolicyRow {
  id: string;
  source_path: string;
  content: string;
  content_hash: string;
  status: PortableKnowledgePolicy["status"];
  updated_at: string;
}

const schemaVersion = 2;
const chunkCharacters = 1_600;

export class SqliteKnowledgeStore implements KnowledgeStore {
  private readonly database: DatabaseSync;

  constructor(readonly scope: KnowledgeScope, readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    this.database.exec("PRAGMA journal_mode=WAL;");
    this.migrate();
  }

  sync(documents: KnowledgeDocumentInput[], policies: KnowledgePolicyInput[]): KnowledgeStoreStats {
    const normalizedDocuments = documents.map((document) => ({
      ...document,
      sourcePath: normalizeSourcePath(document.sourcePath),
      title: document.title.trim() || document.sourcePath,
      content: document.content.trim(),
      classification: document.classification ?? this.scope,
    })).filter((document) => document.content);
    const normalizedPolicies = policies.map((policy) => ({
      sourcePath: normalizeSourcePath(policy.sourcePath),
      content: policy.content.trim(),
    })).filter((policy) => policy.content);
    const seenDocumentIds = new Set<string>();
    const seenPolicyIds = new Set<string>();
    const now = new Date().toISOString();

    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const document of normalizedDocuments) {
        const documentId = stableId(this.scope, document.sourcePath);
        seenDocumentIds.add(documentId);
        const contentHash = hash(document.content);
        const existing = this.database.prepare("SELECT content_hash FROM documents WHERE id = ?").get(documentId) as { content_hash?: string } | undefined;
        if (existing?.content_hash === contentHash) continue;

        this.database.prepare(`
          INSERT INTO documents (id, source_path, title, source_kind, classification, content_hash, status, created_at, updated_at)
          VALUES (?, ?, ?, 'file-import', ?, ?, 'approved', ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            source_path = excluded.source_path,
            title = excluded.title,
            classification = excluded.classification,
            content_hash = excluded.content_hash,
            status = 'approved',
            updated_at = excluded.updated_at
        `).run(documentId, document.sourcePath, document.title, document.classification, contentHash, now, now);
        this.replaceChunks(documentId, document.sourcePath, document.title, document.content);
        this.recordDocumentVersion(documentId, document.content, contentHash, "file-import", now);
        this.audit("document-imported", documentId, document.sourcePath, now);
      }

      const importedRows = this.database.prepare("SELECT id FROM documents WHERE source_kind = 'file-import'").all() as Array<{ id: string }>;
      for (const row of importedRows) {
        if (!seenDocumentIds.has(row.id)) {
          this.deleteDocument(row.id);
          this.audit("document-removed", row.id, "source file removed", now);
        }
      }

      for (const policy of normalizedPolicies) {
        const policyId = stableId(this.scope, `policy:${policy.sourcePath}`);
        seenPolicyIds.add(policyId);
        this.database.prepare(`
          INSERT INTO policies (id, source_path, content, content_hash, status, updated_at)
          VALUES (?, ?, ?, ?, 'active', ?)
          ON CONFLICT(id) DO UPDATE SET
            source_path = excluded.source_path,
            content = excluded.content,
            content_hash = excluded.content_hash,
            status = 'active',
            updated_at = excluded.updated_at
        `).run(policyId, policy.sourcePath, policy.content, hash(policy.content), now);
      }

      const policyRows = this.database.prepare("SELECT id FROM policies").all() as Array<{ id: string }>;
      for (const row of policyRows) {
        if (!seenPolicyIds.has(row.id)) this.database.prepare("DELETE FROM policies WHERE id = ?").run(row.id);
      }

      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.stats();
  }

  recall(query: string, options: { maxCharacters?: number; maxChunks?: number } = {}): KnowledgeRecallItem[] {
    const maxCharacters = Math.max(1, options.maxCharacters ?? 16_000);
    const maxChunks = Math.max(1, options.maxChunks ?? 20);
    const candidates: StoredChunkRow[] = [];
    const terms = ftsTerms(query);
    if (terms) {
      candidates.push(...this.database.prepare(`
        SELECT c.id, c.document_id, d.source_path, d.title, c.content
        FROM chunk_search
        JOIN chunks c ON c.id = chunk_search.chunk_id
        JOIN documents d ON d.id = c.document_id
        WHERE chunk_search MATCH ? AND d.status = 'approved' AND d.classification != 'restricted'
        ORDER BY rank
        LIMIT ?
      `).all(terms, maxChunks) as unknown as StoredChunkRow[]);
    }
    candidates.push(...this.database.prepare(`
      SELECT c.id, c.document_id, d.source_path, d.title, c.content
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE d.status = 'approved' AND d.classification != 'restricted'
      ORDER BY d.updated_at DESC, d.source_path, c.ordinal
      LIMIT ?
    `).all(maxChunks) as unknown as StoredChunkRow[]);

    const items: KnowledgeRecallItem[] = [];
    const seen = new Set<string>();
    let characters = 0;
    for (const row of candidates) {
      if (seen.has(row.id) || items.length >= maxChunks) continue;
      const available = maxCharacters - characters;
      if (available <= 0) break;
      const content = row.content.slice(0, available);
      if (!content) continue;
      seen.add(row.id);
      items.push({
        documentId: row.document_id,
        sourcePath: row.source_path,
        title: row.title,
        content,
        scope: this.scope,
      });
      characters += content.length;
    }
    return items;
  }

  policies(): string {
    const rows = this.database.prepare("SELECT source_path, content FROM policies WHERE status = 'active' ORDER BY source_path").all() as Array<{ source_path: string; content: string }>;
    return rows.map((row) => `[${row.source_path}]\n${row.content}`).join("\n\n");
  }

  stats(): KnowledgeStoreStats {
    const row = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM documents WHERE status = 'approved') AS documents,
        (SELECT COUNT(*) FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.status = 'approved') AS chunks,
        (SELECT COALESCE(SUM(length(c.content)), 0) FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.status = 'approved')
          + (SELECT COALESCE(SUM(length(content)), 0) FROM policies WHERE status = 'active') AS characters
    `).get() as { documents: number; chunks: number; characters: number };
    return { documents: Number(row.documents), chunks: Number(row.chunks), characters: Number(row.characters) };
  }

  createProposal(input: CreateKnowledgeProposal): KnowledgeProposal {
    const sourcePath = normalizeSourcePath(input.sourcePath);
    assertSafeSourcePath(sourcePath);
    const payload: KnowledgeProposalPayload = {
      sourcePath,
      ...(input.title?.trim() ? { title: input.title.trim().slice(0, 200) } : {}),
      ...(input.content?.trim() ? { content: input.content.trim() } : {}),
    };
    if (input.operation === "upsert" && (!payload.title || !payload.content)) {
      throw new Error("Upsert proposals require a title and content.");
    }
    const proposal: KnowledgeProposal = {
      id: randomUUID(),
      scope: this.scope,
      operation: input.operation,
      payload,
      evidenceSessionId: input.evidenceSessionId?.trim().slice(0, 200) ?? "",
      status: "pending",
      createdAt: new Date().toISOString(),
      reviewedAt: "",
      reviewedBy: "",
    };
    this.database.prepare(`
      INSERT INTO knowledge_proposals (id, operation, payload, evidence_session_id, status, created_at, reviewed_at, reviewed_by)
      VALUES (?, ?, ?, ?, ?, ?, '', '')
    `).run(proposal.id, proposal.operation, JSON.stringify(proposal.payload), proposal.evidenceSessionId, proposal.status, proposal.createdAt);
    this.audit("proposal-created", proposal.id, `${proposal.operation}:${sourcePath}`, proposal.createdAt);
    return proposal;
  }

  listProposals(status: KnowledgeProposal["status"] | "all" = "pending"): KnowledgeProposal[] {
    const rows = status === "all"
      ? this.database.prepare("SELECT * FROM knowledge_proposals ORDER BY created_at DESC").all()
      : this.database.prepare("SELECT * FROM knowledge_proposals WHERE status = ? ORDER BY created_at DESC").all(status);
    return (rows as unknown as StoredProposalRow[]).map((row) => proposalFromRow(this.scope, row));
  }

  reviewProposal(id: string, decision: "approve" | "reject", reviewedBy = "operator"): KnowledgeProposal {
    const row = this.database.prepare("SELECT * FROM knowledge_proposals WHERE id = ?").get(id) as unknown as StoredProposalRow | undefined;
    if (!row) throw new Error("Knowledge proposal was not found.");
    if (row.status !== "pending") throw new Error("Knowledge proposal has already been reviewed.");
    const proposal = proposalFromRow(this.scope, row);
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (decision === "approve") this.applyProposal(proposal, now);
      const status = decision === "approve" ? "approved" : "rejected";
      this.database.prepare("UPDATE knowledge_proposals SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?").run(status, now, reviewedBy.trim().slice(0, 120) || "operator", id);
      this.audit(`proposal-${status}`, id, `${proposal.operation}:${proposal.payload.sourcePath}`, now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.listProposals("all").find((item) => item.id === id)!;
  }

  exportSnapshot(scopeId: string): KnowledgeSnapshot {
    const cleanScopeId = normalizeScopeId(scopeId);
    const documentRows = this.database.prepare("SELECT * FROM documents ORDER BY source_path").all() as unknown as StoredDocumentRow[];
    const versionRows = this.database.prepare("SELECT document_id, content, content_hash, source_kind, created_at FROM document_versions ORDER BY created_at").all() as unknown as StoredVersionRow[];
    const versionsByDocument = new Map<string, KnowledgeDocumentVersion[]>();
    for (const row of versionRows) {
      const versions = versionsByDocument.get(row.document_id) ?? [];
      versions.push({ content: row.content, contentHash: row.content_hash, sourceKind: row.source_kind, createdAt: row.created_at });
      versionsByDocument.set(row.document_id, versions);
    }
    const policyRows = this.database.prepare("SELECT * FROM policies ORDER BY source_path").all() as unknown as StoredPolicyRow[];
    return {
      format: "atsla-knowledge-snapshot",
      version: 1,
      scope: this.scope,
      scopeId: cleanScopeId,
      exportedAt: new Date().toISOString(),
      documents: documentRows.map((row) => ({
        id: row.id,
        sourcePath: row.source_path,
        title: row.title,
        sourceKind: row.source_kind,
        classification: row.classification,
        status: row.status,
        contentHash: row.content_hash,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        versions: versionsByDocument.get(row.id) ?? [],
      })),
      policies: policyRows.map((row) => ({
        id: row.id,
        sourcePath: row.source_path,
        content: row.content,
        contentHash: row.content_hash,
        status: row.status,
        updatedAt: row.updated_at,
      })),
      proposals: this.listProposals("all"),
    };
  }

  importSnapshot(snapshot: KnowledgeSnapshot, mode: "merge" | "replace" = "replace"): KnowledgeStoreStats {
    validateSnapshot(snapshot, this.scope);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (mode === "replace") {
        this.database.exec("DELETE FROM chunk_search; DELETE FROM chunks; DELETE FROM document_versions; DELETE FROM documents; DELETE FROM policies; DELETE FROM knowledge_proposals;");
      }
      for (const document of snapshot.documents) this.importDocument(document);
      for (const policy of snapshot.policies) {
        this.database.prepare(`
          INSERT INTO policies (id, source_path, content, content_hash, status, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            source_path = excluded.source_path,
            content = excluded.content,
            content_hash = excluded.content_hash,
            status = excluded.status,
            updated_at = excluded.updated_at
        `).run(policy.id, policy.sourcePath, policy.content, policy.contentHash, policy.status, policy.updatedAt);
      }
      for (const proposal of snapshot.proposals) {
        this.database.prepare(`
          INSERT INTO knowledge_proposals (id, operation, payload, evidence_session_id, status, created_at, reviewed_at, reviewed_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            operation = excluded.operation,
            payload = excluded.payload,
            evidence_session_id = excluded.evidence_session_id,
            status = excluded.status,
            created_at = excluded.created_at,
            reviewed_at = excluded.reviewed_at,
            reviewed_by = excluded.reviewed_by
        `).run(proposal.id, proposal.operation, JSON.stringify(proposal.payload), proposal.evidenceSessionId, proposal.status, proposal.createdAt, proposal.reviewedAt, proposal.reviewedBy);
      }
      this.audit("snapshot-imported", snapshot.scopeId, `${mode}:${snapshot.documents.length} documents`, new Date().toISOString());
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.stats();
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    let version = Number((this.database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (version > schemaVersion) throw new Error(`Knowledge database schema ${version} is newer than supported schema ${schemaVersion}.`);
    if (version < 1) {
      this.database.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        classification TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        content TEXT NOT NULL,
        UNIQUE(document_id, ordinal)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_search USING fts5(
        chunk_id UNINDEXED,
        title,
        source_path,
        content
      );
      CREATE TABLE IF NOT EXISTS policies (
        id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_proposals (
        id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        payload TEXT NOT NULL,
        evidence_session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reviewed_at TEXT NOT NULL DEFAULT '',
        reviewed_by TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        detail TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
      CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id, ordinal);
      CREATE INDEX IF NOT EXISTS idx_proposals_status ON knowledge_proposals(status, created_at);
      PRAGMA user_version = 1;
      `);
      version = 1;
    }
    if (version < 2) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS document_versions (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          content TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(document_id, content_hash)
        );
        CREATE INDEX IF NOT EXISTS idx_document_versions_document ON document_versions(document_id, created_at);
        PRAGMA user_version = 2;
      `);
    }
  }

  private applyProposal(proposal: KnowledgeProposal, now: string): void {
    const sourcePath = normalizeSourcePath(proposal.payload.sourcePath);
    assertSafeSourcePath(sourcePath);
    const documentId = stableId(this.scope, sourcePath);
    if (proposal.operation === "retire") {
      const existing = this.database.prepare("SELECT id FROM documents WHERE id = ?").get(documentId);
      if (!existing) throw new Error("The proposed knowledge document does not exist.");
      this.database.prepare("UPDATE documents SET status = 'retired', updated_at = ? WHERE id = ?").run(now, documentId);
      return;
    }

    const title = proposal.payload.title?.trim();
    const content = proposal.payload.content?.trim();
    if (!title || !content) throw new Error("Approved upsert proposals require a title and content.");
    const contentHash = hash(content);
    this.database.prepare(`
      INSERT INTO documents (id, source_path, title, source_kind, classification, content_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, 'approved-proposal', ?, ?, 'approved', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        source_kind = 'approved-proposal',
        classification = excluded.classification,
        content_hash = excluded.content_hash,
        status = 'approved',
        updated_at = excluded.updated_at
    `).run(documentId, sourcePath, title, this.scope, contentHash, now, now);
    this.replaceChunks(documentId, sourcePath, title, content);
    this.recordDocumentVersion(documentId, content, contentHash, "approved-proposal", now);
  }

  private importDocument(document: PortableKnowledgeDocument): void {
    assertSafeSourcePath(document.sourcePath);
    const currentVersion = document.versions.find((version) => version.contentHash === document.contentHash) ?? document.versions.at(-1);
    if (!currentVersion) throw new Error(`Knowledge document ${document.sourcePath} has no content version.`);
    this.database.prepare(`
      INSERT INTO documents (id, source_path, title, source_kind, classification, content_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_path = excluded.source_path,
        title = excluded.title,
        source_kind = excluded.source_kind,
        classification = excluded.classification,
        content_hash = excluded.content_hash,
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(document.id, document.sourcePath, document.title, document.sourceKind, document.classification, document.contentHash, document.status, document.createdAt, document.updatedAt);
    this.replaceChunks(document.id, document.sourcePath, document.title, currentVersion.content);
    for (const version of document.versions) this.recordDocumentVersion(document.id, version.content, version.contentHash, version.sourceKind, version.createdAt);
  }

  private replaceChunks(documentId: string, sourcePath: string, title: string, content: string): void {
    const rows = this.database.prepare("SELECT id FROM chunks WHERE document_id = ?").all(documentId) as Array<{ id: string }>;
    for (const row of rows) this.database.prepare("DELETE FROM chunk_search WHERE chunk_id = ?").run(row.id);
    this.database.prepare("DELETE FROM chunks WHERE document_id = ?").run(documentId);
    for (const [ordinal, chunk] of splitIntoChunks(content).entries()) {
      const chunkId = stableId(documentId, String(ordinal));
      this.database.prepare("INSERT INTO chunks (id, document_id, ordinal, content) VALUES (?, ?, ?, ?)").run(chunkId, documentId, ordinal, chunk);
      this.database.prepare("INSERT INTO chunk_search (chunk_id, title, source_path, content) VALUES (?, ?, ?, ?)").run(chunkId, title, sourcePath, chunk);
    }
  }

  private deleteDocument(documentId: string): void {
    const rows = this.database.prepare("SELECT id FROM chunks WHERE document_id = ?").all(documentId) as Array<{ id: string }>;
    for (const row of rows) this.database.prepare("DELETE FROM chunk_search WHERE chunk_id = ?").run(row.id);
    this.database.prepare("DELETE FROM documents WHERE id = ?").run(documentId);
  }

  private recordDocumentVersion(documentId: string, content: string, contentHash: string, sourceKind: string, createdAt: string): void {
    const versionId = stableId(documentId, contentHash);
    this.database.prepare(`
      INSERT OR IGNORE INTO document_versions (id, document_id, content, content_hash, source_kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(versionId, documentId, content, contentHash, sourceKind, createdAt);
  }

  private audit(eventType: string, subjectId: string, detail: string, occurredAt: string): void {
    this.database.prepare("INSERT INTO audit_events (event_type, subject_id, detail, occurred_at) VALUES (?, ?, ?, ?)").run(eventType, subjectId, detail, occurredAt);
  }
}

function stableId(namespace: string, value: string): string {
  return createHash("sha256").update(`${namespace}\0${value}`).digest("hex");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeSourcePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function assertSafeSourcePath(sourcePath: string): void {
  if (!sourcePath || sourcePath.startsWith("/") || sourcePath === ".." || sourcePath.startsWith("../") || sourcePath.includes("/../")) {
    throw new Error("Knowledge source paths must be relative and cannot traverse parent folders.");
  }
}

function proposalFromRow(scope: KnowledgeScope, row: StoredProposalRow): KnowledgeProposal {
  return {
    id: row.id,
    scope,
    operation: row.operation,
    payload: JSON.parse(row.payload) as KnowledgeProposalPayload,
    evidenceSessionId: row.evidence_session_id,
    status: row.status,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
  };
}

function normalizeScopeId(value: string): string {
  const scopeId = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,127}$/.test(scopeId)) throw new Error("Knowledge scope identifiers must contain 3-128 lowercase letters, numbers, dots, underscores, or hyphens.");
  return scopeId;
}

function validateSnapshot(snapshot: KnowledgeSnapshot, expectedScope: KnowledgeScope): void {
  if (snapshot.format !== "atsla-knowledge-snapshot" || snapshot.version !== 1) throw new Error("Unsupported knowledge snapshot format.");
  if (snapshot.scope !== expectedScope) throw new Error(`Knowledge snapshot scope ${snapshot.scope} does not match ${expectedScope}.`);
  normalizeScopeId(snapshot.scopeId);
  for (const document of snapshot.documents) {
    assertSafeSourcePath(document.sourcePath);
    if (document.classification !== "public" && document.classification !== "client" && document.classification !== "restricted") throw new Error("Invalid knowledge document classification.");
    if (document.status !== "approved" && document.status !== "retired") throw new Error("Invalid knowledge document status.");
    if (!document.versions.length) throw new Error(`Knowledge document ${document.sourcePath} has no versions.`);
  }
  for (const policy of snapshot.policies) assertSafeSourcePath(policy.sourcePath);
  for (const proposal of snapshot.proposals) {
    if (proposal.scope !== expectedScope) throw new Error("Knowledge proposal scope does not match its snapshot.");
    assertSafeSourcePath(proposal.payload.sourcePath);
  }
}

function splitIntoChunks(content: string): string[] {
  const chunks: string[] = [];
  let remaining = content.trim();
  while (remaining) {
    if (remaining.length <= chunkCharacters) {
      chunks.push(remaining);
      break;
    }
    const paragraphBreak = remaining.lastIndexOf("\n\n", chunkCharacters);
    const lineBreak = remaining.lastIndexOf("\n", chunkCharacters);
    const space = remaining.lastIndexOf(" ", chunkCharacters);
    const boundary = Math.max(paragraphBreak, lineBreak, space, Math.floor(chunkCharacters * 0.6));
    chunks.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }
  return chunks.filter(Boolean);
}

function ftsTerms(query: string): string {
  const words = query.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,63}/g) ?? [];
  return [...new Set(words)].slice(0, 16).map((word) => `"${word.replaceAll('"', '""')}"`).join(" OR ");
}