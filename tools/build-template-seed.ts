import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteKnowledgeStore, type KnowledgeDocumentInput, type KnowledgeSnapshot } from "../src/knowledge-store.js";

const defaultTemplateRoot = new URL("../template-database-seed", import.meta.url);

export function buildTemplateSeed(clientId: string, templateRoot = resolve(defaultTemplateRoot.pathname)): KnowledgeSnapshot {
  const root = resolve(templateRoot);
  const temporaryRoot = mkdtempSync(join(tmpdir(), "atlas-template-seed-"));
  const store = new SqliteKnowledgeStore("client", join(temporaryRoot, "seed.sqlite"));
  try {
    const documents = walk(root)
      .filter((path) => [".md", ".json", ".yaml", ".yml", ".csv"].includes(extname(path).toLowerCase()))
      .filter((path) => basename(path) !== "CLIENT-GUARDRAILS.md" && basename(path) !== "README.md")
      .map((path): KnowledgeDocumentInput => {
        const content = readFileSync(path, "utf8").trim();
        return {
          sourcePath: relative(root, path).replaceAll("\\", "/"),
          title: firstHeading(content) || basename(path, extname(path)),
          content,
          classification: "client",
          quality: {
            authority: "seed",
            confidence: 1,
            evidenceCount: 1,
            positiveFeedback: 0,
            negativeFeedback: 0,
            lastValidatedAt: new Date().toISOString(),
          },
        };
      });
    const guardrailPath = join(root, "CLIENT-GUARDRAILS.md");
    store.sync(documents, [{ sourcePath: "CLIENT-GUARDRAILS.md", content: readFileSync(guardrailPath, "utf8") }]);
    return store.exportSnapshot(clientId);
  } finally {
    store.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function walk(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function firstHeading(content: string): string {
  return /^#\s+(.+)$/m.exec(content)?.[1]?.trim().slice(0, 200) ?? "";
}

function main(): void {
  const [clientId, templateRoot, outputPath] = process.argv.slice(2);
  if (!clientId || clientId === "--help" || clientId === "-h") {
    console.log("Usage: npm run seed:template -- <client-id> [template-directory] [output.json]");
    process.exit(clientId ? 0 : 2);
  }
  const snapshot = buildTemplateSeed(clientId, templateRoot);
  const output = resolve(outputPath ?? `atlas-${clientId}-seed.json`);
  writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`Wrote ${snapshot.documents.length} seed documents for ${snapshot.scopeId} to ${output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
