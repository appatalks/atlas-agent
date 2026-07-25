import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MeetingCoordinator } from "../src/coordinator.js";
import { DraftStore, ResponsePolicy } from "../src/policy.js";
import { SessionStore } from "../src/session-store.js";
import { SimulationProvider } from "../src/providers.js";
import { SimulatedSpeechOutput } from "../src/voice.js";
import { ClientWorkspace } from "../src/settings.js";

describe("persistent meeting sessions", () => {
  it("greets once, persists conversation state, and restores a selected session", async () => {
    const root = mkdtempSync(join(tmpdir(), "voice-bridge-sessions-"));
    try {
      const sessions = new SessionStore(root);
      const workspace = new ClientWorkspace(join(root, "clients"));
      const coordinator = new MeetingCoordinator(
        new SimulationProvider(),
        new ResponsePolicy("autonomous"),
        new DraftStore(),
        new SimulatedSpeechOutput(),
        undefined,
        workspace,
        sessions,
      );

      const clientWorkspace = join(root, "clients", "northwind");
      coordinator.selectClientWorkspace({ name: "Northwind", supplementaryContextPath: clientWorkspace });
      const first = await coordinator.createSession({ title: "Northwind kickoff" });
      expect(first.greetingSent).toBe(true);
      expect(coordinator.state().drafts.filter((draft) => draft.question === "Operator template")).toHaveLength(1);
      await coordinator.ingest({ id: "remote-1", speaker: "remote", text: "We need to review reliability.", occurredAt: new Date().toISOString() });
      const second = await coordinator.createSession({ title: "Contoso follow-up" });
      expect(second.greetingSent).toBe(true);

      const restored = coordinator.selectSession(first.id);
      expect(restored.title).toBe("Northwind kickoff");
      expect(coordinator.state().transcript[0].text).toContain("review reliability");
      expect(coordinator.listSessions()).toHaveLength(2);
      expect(coordinator.state().drafts.filter((draft) => draft.question === "Operator template")).toHaveLength(1);

      const renamed = coordinator.renameSession(first.id, "Northwind reliability review");
      expect(renamed.title).toBe("Northwind reliability review");
      expect(sessions.get(first.id).title).toBe("Northwind reliability review");
      expect(coordinator.listSessions().find((session) => session.id === first.id)?.title).toBe("Northwind reliability review");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps each client workspace's sessions separate", async () => {
    const root = mkdtempSync(join(tmpdir(), "voice-bridge-workspace-sessions-"));
    try {
      const sessions = new SessionStore(root);
      const workspace = new ClientWorkspace(join(root, "clients"));
      const coordinator = new MeetingCoordinator(
        new SimulationProvider(),
        new ResponsePolicy("autonomous"),
        new DraftStore(),
        new SimulatedSpeechOutput(),
        undefined,
        workspace,
        sessions,
      );
      coordinator.selectClientWorkspace({ name: "Northwind", supplementaryContextPath: join(root, "clients", "northwind") });
      const northwind = await coordinator.createSession({ title: "Northwind review" });
      expect(coordinator.listSessions()).toMatchObject([{ id: northwind.id }]);

      coordinator.selectClientWorkspace({ path: join(root, "clients", "contoso") });
      expect(coordinator.listSessions()).toEqual([]);
      const contoso = await coordinator.createSession({ title: "Contoso review" });
      expect(coordinator.listSessions()).toMatchObject([{ id: contoso.id }]);
      expect(() => coordinator.selectSession(northwind.id)).toThrow("different client");
      expect(() => coordinator.renameSession(northwind.id, "Cross-client rename")).toThrow("different client");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("isolates database-only client sessions without supplementary folders", async () => {
    const root = mkdtempSync(join(tmpdir(), "voice-bridge-database-sessions-"));
    try {
      const coordinator = new MeetingCoordinator(
        new SimulationProvider(),
        new ResponsePolicy("autonomous"),
        new DraftStore(),
        new SimulatedSpeechOutput(),
        undefined,
        new ClientWorkspace(join(root, "clients"), undefined, join(root, "cache")),
        new SessionStore(join(root, "sessions")),
      );
      coordinator.selectClientWorkspace({ clientId: "fintech-demo-1", name: "Fintech Demo 1", database: "fintech-demo-1" });
      const fintech = await coordinator.createSession({ title: "Fintech database session" });
      expect(fintech).toMatchObject({ clientId: "fintech-demo-1", clientWorkspace: "" });

      coordinator.selectClientWorkspace({ clientId: "healthcare-demo-2", name: "Healthcare Demo 2", database: "healthcare-demo-2" });
      const healthcare = await coordinator.createSession({ title: "Healthcare database session" });
      expect(coordinator.listSessions()).toMatchObject([{ id: healthcare.id, clientId: "healthcare-demo-2" }]);
      expect(() => coordinator.selectSession(fintech.id)).toThrow("different client");

      coordinator.selectClientWorkspace({ clientId: "fintech-demo-1" });
      expect(coordinator.listSessions()).toMatchObject([{ id: fintech.id, clientId: "fintech-demo-1" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
