import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SqliteKnowledgeStore } from "../src/knowledge-store.js";

describe("SQLite knowledge store", () => {
  it("imports versioned source content, recalls approved chunks, and keeps policies separate", () => {
    const root = mkdtempSync(join(tmpdir(), "atsla-knowledge-store-"));
    const store = new SqliteKnowledgeStore("client", join(root, "client.sqlite"));
    try {
      const initial = store.sync([
        { sourcePath: "knowledge/product.md", title: "Product", content: "The Aurora gateway supports regional failover." },
        { sourcePath: "context-drop/accounts.csv", title: "Accounts", content: "account,plan\nNorthwind,enterprise" },
        { sourcePath: "knowledge/private.md", title: "Private", content: "RESTRICTED_CANARY", classification: "restricted" },
      ], [{ sourcePath: "context-drop/CONTEXT-GUARDRAILS.md", content: "Never disclose restricted records." }]);

      expect(initial).toMatchObject({ documents: 3, chunks: 3 });
      expect(store.recall("Does the gateway support failover?", { maxChunks: 1 })[0]).toMatchObject({
        sourcePath: "knowledge/product.md",
        scope: "client",
      });
      expect(store.recall("restricted canary").map((item) => item.content).join(" ")).not.toContain("RESTRICTED_CANARY");
      expect(store.policies()).toContain("Never disclose restricted records");

      const updated = store.sync([
        { sourcePath: "knowledge/product.md", title: "Product", content: "The Aurora gateway supports regional and zone failover." },
      ], [{ sourcePath: "context-drop/CONTEXT-GUARDRAILS.md", content: "Never disclose restricted records." }]);
      expect(updated.documents).toBe(1);
      expect(store.recall("zone failover", { maxChunks: 1 })[0].content).toContain("zone failover");
      expect(store.recall("Northwind").map((item) => item.content).join(" ")).not.toContain("Northwind");
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cannot recall one client's canary from another physical database", () => {
    const root = mkdtempSync(join(tmpdir(), "atsla-knowledge-isolation-"));
    const clientA = new SqliteKnowledgeStore("client", join(root, "client-a.sqlite"));
    const clientB = new SqliteKnowledgeStore("client", join(root, "client-b.sqlite"));
    try {
      clientA.sync([{ sourcePath: "knowledge/client.md", title: "Client A", content: "CLIENT_A_DATABASE_CANARY" }], []);
      clientB.sync([{ sourcePath: "knowledge/client.md", title: "Client B", content: "CLIENT_B_DATABASE_CANARY" }], []);

      expect(clientA.recall("database canary").map((item) => item.content).join(" ")).toContain("CLIENT_A_DATABASE_CANARY");
      expect(clientA.recall("database canary").map((item) => item.content).join(" ")).not.toContain("CLIENT_B_DATABASE_CANARY");
      expect(clientB.recall("database canary").map((item) => item.content).join(" ")).toContain("CLIENT_B_DATABASE_CANARY");
      expect(clientB.recall("database canary").map((item) => item.content).join(" ")).not.toContain("CLIENT_A_DATABASE_CANARY");
    } finally {
      clientA.close();
      clientB.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies only approved proposals and retains document versions", () => {
    const root = mkdtempSync(join(tmpdir(), "atsla-knowledge-proposals-"));
    const databasePath = join(root, "client.sqlite");
    const store = new SqliteKnowledgeStore("client", databasePath);
    try {
      const rejected = store.createProposal({
        operation: "upsert",
        sourcePath: "ai/rejected.md",
        title: "Rejected",
        content: "REJECTED_PROPOSAL_CANARY",
        evidenceSessionId: "session-1",
      });
      expect(store.recall("rejected proposal canary")).toEqual([]);
      expect(store.reviewProposal(rejected.id, "reject").status).toBe("rejected");
      expect(store.recall("rejected proposal canary")).toEqual([]);

      const first = store.createProposal({
        operation: "upsert",
        sourcePath: "ai/session-summary.md",
        title: "Session summary",
        content: "The approved recovery target is fifteen minutes.",
        evidenceSessionId: "session-1",
      });
      expect(store.listProposals()).toMatchObject([{ id: first.id, status: "pending" }]);
      expect(store.recall("recovery target")).toEqual([]);
      expect(store.reviewProposal(first.id, "approve", "test-operator")).toMatchObject({ status: "approved", reviewedBy: "test-operator" });
      expect(store.recall("recovery target", { maxChunks: 1 })[0].content).toContain("fifteen minutes");
      expect(() => store.reviewProposal(first.id, "approve")).toThrow("already been reviewed");

      const update = store.createProposal({
        operation: "upsert",
        sourcePath: "ai/session-summary.md",
        title: "Session summary",
        content: "The approved recovery target is ten minutes.",
        evidenceSessionId: "session-2",
      });
      store.reviewProposal(update.id, "approve");
      expect(store.recall("recovery target", { maxChunks: 1 })[0].content).toContain("ten minutes");

      const history = new DatabaseSync(databasePath, { readOnly: true });
      expect((history.prepare("SELECT COUNT(*) AS count FROM document_versions").get() as { count: number }).count).toBe(2);
      history.close();

      const retirement = store.createProposal({ operation: "retire", sourcePath: "ai/session-summary.md", evidenceSessionId: "session-3" });
      store.reviewProposal(retirement.id, "approve");
      expect(store.recall("recovery target")).toEqual([]);
      expect(() => store.createProposal({ operation: "retire", sourcePath: "../other-client/private.md" })).toThrow("cannot traverse");
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("weights evidence-backed autonomous knowledge without treating repetition as authority", () => {
    const root = mkdtempSync(join(tmpdir(), "atsla-knowledge-quality-"));
    const store = new SqliteKnowledgeStore("client", join(root, "client.sqlite"));
    try {
      const weak = store.createProposal({
        operation: "upsert",
        sourcePath: "learned/weak-reset.md",
        title: "Reset procedure",
        content: "Use the unverified reset procedure for the gateway.",
        evidenceSessionId: "session-weak",
        quality: { authority: "autonomous", confidence: 0.7, evidenceCount: 1, negativeFeedback: 1 },
      });
      store.reviewProposal(weak.id, "approve", "atsla-autonomous-review");
      const strong = store.createProposal({
        operation: "upsert",
        sourcePath: "learned/verified-reset.md",
        title: "Reset procedure",
        content: "Use the verified reset procedure for the gateway.",
        evidenceSessionId: "session-strong",
        quality: { authority: "autonomous", confidence: 0.96, evidenceCount: 3, positiveFeedback: 1 },
      });
      store.reviewProposal(strong.id, "approve", "atsla-autonomous-review");

      expect(store.recall("reset procedure gateway", { maxChunks: 1 })[0].content).toContain("verified reset");
      const snapshot = store.exportSnapshot("quality-client");
      expect(snapshot.documents.find((document) => document.sourcePath === "learned/verified-reset.md")?.quality).toMatchObject({
        authority: "autonomous",
        confidence: 0.96,
        evidenceCount: 3,
        positiveFeedback: 1,
      });

      const humanReviewed = store.createProposal({
        operation: "upsert",
        sourcePath: "learned/human-reviewed.md",
        title: "Human reviewed procedure",
        content: "This procedure was explicitly reviewed by the operator.",
        quality: { authority: "autonomous", confidence: 0.7, evidenceCount: 1 },
      });
      store.reviewProposal(humanReviewed.id, "approve", "support-operator");
      expect(store.exportSnapshot("quality-client").documents.find((document) => document.sourcePath === "learned/human-reviewed.md")?.quality).toMatchObject({
        authority: "operator",
        confidence: 0.95,
      });
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("round-trips a portable snapshot across physical databases", () => {
    const root = mkdtempSync(join(tmpdir(), "atsla-knowledge-snapshot-"));
    const sourcePath = join(root, "source.sqlite");
    const targetPath = join(root, "target.sqlite");
    const source = new SqliteKnowledgeStore("client", sourcePath);
    const target = new SqliteKnowledgeStore("client", targetPath);
    try {
      source.sync([
        { sourcePath: "knowledge/runbook.md", title: "Runbook", content: "Version one recovery guidance." },
      ], [{ sourcePath: "context-drop/CONTEXT-GUARDRAILS.md", content: "Never reveal another client." }]);
      const update = source.createProposal({
        operation: "upsert",
        sourcePath: "knowledge/runbook.md",
        title: "Runbook",
        content: "Version two recovery guidance.",
        evidenceSessionId: "session-approved",
      });
      source.reviewProposal(update.id, "approve");
      source.createProposal({
        operation: "upsert",
        sourcePath: "ai/pending.md",
        title: "Pending",
        content: "PENDING_SNAPSHOT_CANARY",
        evidenceSessionId: "session-pending",
      });

      const snapshot = source.exportSnapshot("northwind-client");
      expect(snapshot).toMatchObject({
        format: "atsla-knowledge-snapshot",
        version: 1,
        scope: "client",
        scopeId: "northwind-client",
      });
      expect(snapshot.documents[0].versions).toHaveLength(2);

      target.importSnapshot(JSON.parse(JSON.stringify(snapshot)), "replace");
      expect(target.recall("recovery guidance", { maxChunks: 1 })[0].content).toContain("Version two");
      expect(target.policies()).toContain("Never reveal another client");
      expect(target.listProposals("pending")).toMatchObject([{ payload: { content: "PENDING_SNAPSHOT_CANARY" } }]);
      expect(target.recall("pending snapshot canary").map((item) => item.content).join(" ")).not.toContain("PENDING_SNAPSHOT_CANARY");
      expect(target.exportSnapshot("northwind-client").documents[0].versions).toHaveLength(2);
      expect(() => target.importSnapshot({ ...snapshot, scope: "public" })).toThrow("does not match client");
    } finally {
      source.close();
      target.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("compacts portable version history while retaining the current state", () => {
    const root = mkdtempSync(join(tmpdir(), "atsla-knowledge-compaction-"));
    const store = new SqliteKnowledgeStore("client", join(root, "client.sqlite"));
    try {
      for (let version = 1; version <= 25; version += 1) {
        const proposal = store.createProposal({
          operation: "upsert",
          sourcePath: "learned/repeated-resolution.md",
          title: "Repeated resolution",
          content: `Resolution version ${version}.`,
          evidenceSessionId: `session-${version}`,
          quality: { authority: "autonomous", confidence: 0.95, evidenceCount: 1, positiveFeedback: 1 },
        });
        store.reviewProposal(proposal.id, "approve", "atsla-autonomous-review");
      }

      const snapshot = store.exportSnapshot("compaction-client");
      expect(snapshot.documents[0].versions).toHaveLength(20);
      expect(snapshot.documents[0].versions.at(-1)?.content).toBe("Resolution version 25.");
      expect(snapshot.compaction).toMatchObject({ maxVersionsPerDocument: 20, maxProposals: 1_000, omittedVersions: 5, omittedProposals: 0 });
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});