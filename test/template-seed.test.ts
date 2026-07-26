import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteKnowledgeStore } from "../src/knowledge-store.js";
import { buildTemplateSeed } from "../tools/build-template-seed.js";

describe("client database seed template", () => {
  it("builds a portable, seed-authority support knowledge snapshot", () => {
    const snapshot = buildTemplateSeed("template-client");
    expect(snapshot).toMatchObject({
      format: "atsla-knowledge-snapshot",
      version: 1,
      scope: "client",
      scopeId: "template-client",
    });
    expect(snapshot.documents.length).toBeGreaterThanOrEqual(7);
    expect(snapshot.documents.every((document) => document.quality?.authority === "seed" && document.quality.confidence === 1)).toBe(true);
    expect(snapshot.policies).toMatchObject([{ sourcePath: "CLIENT-GUARDRAILS.md", status: "active" }]);

    const root = mkdtempSync(join(tmpdir(), "atsla-seed-import-"));
    const store = new SqliteKnowledgeStore("client", join(root, "client.sqlite"));
    try {
      store.importSnapshot(snapshot);
      expect(store.recall("symptom diagnosis resolution verification rollback escalation").map((item) => item.content).join(" ")).toContain("Troubleshooting Playbooks");
      expect(store.policies()).toContain("Promote learning only when it is reusable");
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
