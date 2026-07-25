import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClientWorkspace, SettingsStore, defaultSettings } from "../src/settings.js";

describe("client workspace", () => {
  const folders: string[] = [];

  afterEach(() => folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true })));

  it("creates a client knowledge, bulk-context, guardrail, skills, and meeting-log structure", () => {
    const root = mkdtempSync(join(tmpdir(), "voice-bridge-client-"));
    folders.push(root);
    const workspace = new ClientWorkspace(root);
    const folder = workspace.select({ name: "Northwind Support" });

    expect(existsSync(join(folder, "client-profile.json"))).toBe(true);
    expect(existsSync(join(folder, "knowledge", "README.md"))).toBe(true);
    expect(existsSync(join(folder, "skills", "README.md"))).toBe(true);
    expect(existsSync(join(folder, "context-drop", "README.md"))).toBe(true);
    expect(existsSync(join(folder, "context-drop", "CONTEXT-GUARDRAILS.md"))).toBe(true);
    expect(existsSync(join(folder, "meetings"))).toBe(true);
    expect(JSON.parse(readFileSync(join(folder, "client-profile.json"), "utf8")).id).toMatch(/^client-[a-f0-9-]{36}$/);
    const global = workspace.prepareGlobalKnowledge(join(root, "global"));
    expect(existsSync(join(global, "GLOBAL-GUARDRAILS.md"))).toBe(true);

    workspace.appendTranscript(folder, "- Remote: The client needs help.");
    const profile = JSON.parse(readFileSync(join(folder, "client-profile.json"), "utf8"));
    expect(profile.transcriptEvents).toBe(1);
    expect(profile.lastConversationAt).toBeTruthy();

    const summaryPath = workspace.appendSummary(folder, "The team agreed on the next step.");
    expect(summaryPath).toBe(join(folder, "meetings", `${new Date().toISOString().slice(0, 10)}.summary.md`));
    expect(workspace.latestSummary(folder)).toBe(summaryPath);
  });

  it("adds bulk-context guardrails to an existing client workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "voice-bridge-existing-client-"));
    folders.push(root);
    const folder = join(root, "Existing Client");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "client-profile.json"), JSON.stringify({ name: "Existing Client" }), "utf8");
    const workspace = new ClientWorkspace(root);

    workspace.select({ path: folder });

    expect(existsSync(join(folder, "context-drop", "README.md"))).toBe(true);
    expect(readFileSync(join(folder, "context-drop", "CONTEXT-GUARDRAILS.md"), "utf8")).toContain("Sensitive Or Restricted");
  });

  it("rejects workspace paths outside the operator home and configured clients root", () => {
    const root = mkdtempSync(join(tmpdir(), "voice-bridge-client-root-"));
    folders.push(root);
    const workspace = new ClientWorkspace(root);

    expect(() => workspace.select({ path: "/etc/voice-bridge-client" })).toThrow("Workspace paths must be inside");
  });

  it("persists an explicit ADX route against the stable client identity", () => {
    const root = mkdtempSync(join(tmpdir(), "voice-bridge-client-route-"));
    folders.push(root);
    const workspace = new ClientWorkspace(root);
    const folder = workspace.select({ name: "Northwind Support" });
    const before = workspace.clientKnowledgeIdentity(folder);
    const updated = workspace.setClientKnowledgeDatabase(folder, "client-database");

    expect(updated).toMatchObject({ clientId: before.clientId, name: "Northwind Support", knowledgeDatabase: "client-database" });
    expect(new ClientWorkspace(root).clientKnowledgeIdentity(folder)).toEqual(updated);
    expect(() => workspace.setClientKnowledgeDatabase(folder, "bad/database")).toThrow("unsupported characters");
  });

  it("imports the client and public templates into separate SQLite databases", async () => {
    const root = mkdtempSync(join(tmpdir(), "voice-bridge-template-import-"));
    folders.push(root);
    const client = join(root, "client-template");
    const publicKnowledge = join(root, "public-template");
    cpSync(new URL("../template-client-folder", import.meta.url), client, { recursive: true });
    cpSync(new URL("../template-public-knowledgebase", import.meta.url), publicKnowledge, { recursive: true });
    const workspace = new ClientWorkspace(join(root, "clients"));

    const selected = workspace.select({ path: client });
    const clientStats = await workspace.loadClientContext(selected);
    await workspace.loadGlobalKnowledge(publicKnowledge);

    expect(clientStats).toMatchObject({ documents: expect.any(Number), chunks: expect.any(Number) });
    expect(existsSync(join(client, ".atsla", "client-knowledge.sqlite"))).toBe(true);
    expect(existsSync(join(publicKnowledge, ".atsla", "public-knowledge.sqlite"))).toBe(true);
    expect(workspace.context(client, "Northwind support plan")).toContain("Enterprise Demo");
    expect(workspace.context(client, "public triage basics")).not.toContain("Public Triage Basics");
    expect(workspace.globalContext(publicKnowledge, "public triage basics")).toContain("Public Triage Basics");
    expect(workspace.globalContext(publicKnowledge, "Northwind support plan")).not.toContain("Enterprise Demo");
  });
});

describe("default voice profile", () => {
  it("defines AppaTalks as an expert GitHub Reliability Engineer", () => {
    const defaults = defaultSettings();
    const appaTalks = defaults.voiceProfiles.find((profile) => profile.name === "AppaTalks");
    expect(appaTalks?.instructions).toContain("AppaTalks, an expert GitHub Reliability Engineer");
    expect(appaTalks?.instructions).toContain("ATSLA means AppaTalks Support Live Agent");
    expect(appaTalks).toMatchObject({ exaggeration: 0.65, cfgWeight: 0.35 });
    expect(defaults.voiceProfiles.find((profile) => profile.name === "Eva")).toMatchObject({
      id: "eva",
      exaggeration: 0.55,
      cfgWeight: 0.4,
    });
    expect(defaults.voiceProfile).toBe("AppaTalks");
    expect(defaults.ttsEngineUrl).toBe("http://127.0.0.1:8090/");
    expect(defaults.responseMode).toBe("autonomous");
    expect(defaults.defaultInputMode).toBe("agent");
  });

  it("persists edited AppaTalks custom instructions", () => {
    const root = mkdtempSync(join(tmpdir(), "voice-bridge-settings-"));
    try {
      const path = join(root, "settings.json");
      const store = new SettingsStore(path);
      const voiceProfiles = store.get().voiceProfiles.map((profile) => ({ ...profile, instructions: "Custom reliability instruction." }));
      store.update({ voiceProfiles });

      expect(new SettingsStore(path).get().voiceProfiles[0].instructions).toBe("Custom reliability instruction.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists a network TTS engine URL and rejects unsupported protocols", () => {
    const root = mkdtempSync(join(tmpdir(), "voice-bridge-tts-settings-"));
    try {
      const store = new SettingsStore(join(root, "settings.json"));
      store.update({ ttsEngineUrl: "https://gpu-tts.example.test:8090/" });

      expect(new SettingsStore(join(root, "settings.json")).get().ttsEngineUrl).toBe("https://gpu-tts.example.test:8090/");
      expect(() => store.update({ ttsEngineUrl: "file:///tmp/tts" })).toThrow("valid HTTP(S)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the configured remote URL as the initial TTS engine location", () => {
    const previousLocalUrl = process.env.LOCAL_VOICE_BRIDGE_URL;
    const previousRemoteUrl = process.env.VOICE_BRIDGE_REMOTE_TTS_URL;
    try {
      delete process.env.LOCAL_VOICE_BRIDGE_URL;
      process.env.VOICE_BRIDGE_REMOTE_TTS_URL = "https://gpu-tts.example.test:8090/";
      expect(defaultSettings().ttsEngineUrl).toBe("https://gpu-tts.example.test:8090/");
    } finally {
      if (previousLocalUrl === undefined) delete process.env.LOCAL_VOICE_BRIDGE_URL;
      else process.env.LOCAL_VOICE_BRIDGE_URL = previousLocalUrl;
      if (previousRemoteUrl === undefined) delete process.env.VOICE_BRIDGE_REMOTE_TTS_URL;
      else process.env.VOICE_BRIDGE_REMOTE_TTS_URL = previousRemoteUrl;
    }
  });

  it("migrates pre-v5 settings to autonomous mode and the agent microphone", () => {
    const root = mkdtempSync(join(tmpdir(), "voice-bridge-migration-"));
    try {
      const path = join(root, "settings.json");
      const legacy = { ...defaultSettings(), settingsVersion: 2, responseMode: "approval", defaultInputMode: "operator" };
      writeFileSync(path, JSON.stringify(legacy), "utf8");
      const migrated = new SettingsStore(path).get();

      expect(migrated.settingsVersion).toBe(11);
      expect(migrated.responseMode).toBe("autonomous");
      expect(migrated.defaultInputMode).toBe("agent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("migrates existing Atsla and Appatalks settings to AppaTalks", () => {
    const root = mkdtempSync(join(tmpdir(), "voice-bridge-appatalks-migration-"));
    try {
      const path = join(root, "settings.json");
      const legacy = {
        ...defaultSettings(),
        settingsVersion: 6,
        voiceProfile: "Atsla",
        voiceProfiles: [{ id: "appatalks", name: "Appatalks", instructions: "Custom Appatalks instruction.", exaggeration: 0.65, cfgWeight: 0.35 }],
      };
      writeFileSync(path, JSON.stringify(legacy), "utf8");
      const migrated = new SettingsStore(path).get();

      expect(migrated.voiceProfile).toBe("AppaTalks");
      expect(migrated.voiceProfiles[0]).toMatchObject({ id: "appatalks", name: "AppaTalks" });
      expect(migrated.voiceProfiles[0].instructions).toContain("AppaTalks");
      const persisted = JSON.parse(readFileSync(path, "utf8"));
      expect(persisted.voiceProfile).toBe("AppaTalks");
      expect(persisted.voiceProfiles[0]).toMatchObject({ id: "appatalks", name: "AppaTalks" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists a selectable theme and clamps glass transparency", () => {
    const root = mkdtempSync(join(tmpdir(), "voice-bridge-appearance-"));
    try {
      const path = join(root, "settings.json");
      const store = new SettingsStore(path);
      expect(store.get()).toMatchObject({ appearanceTheme: "atsla", glassTransparency: 88 });

      store.update({ appearanceTheme: "lcars", glassTransparency: 120 });
      expect(new SettingsStore(path).get()).toMatchObject({ appearanceTheme: "lcars", glassTransparency: 100 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists public-only operation even when client catalog entries exist", () => {
    const root = mkdtempSync(join(tmpdir(), "voice-bridge-public-only-settings-"));
    try {
      const path = join(root, "settings.json");
      const store = new SettingsStore(path);
      store.update({
        clients: [{ id: "known-client", name: "Known Client", knowledgeDatabase: "known-client", supplementaryContextPath: "" }],
        activeClientId: "known-client",
      });
      store.update({ activeClientId: "" });

      expect(new SettingsStore(path).get()).toMatchObject({ activeClientId: "", clientWorkspace: "" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes a Data Explorer portal link without hardcoding its endpoint", () => {
    const root = mkdtempSync(join(tmpdir(), "voice-bridge-adx-settings-"));
    try {
      const path = join(root, "settings.json");
      const store = new SettingsStore(path);
      const updated = store.update({
        knowledgeBackend: "adx",
        adxClusterUrl: "https://dataexplorer.azure.com/clusters/example.southcentralus/databases/client-database",
        adxAuthMode: "device-code",
      });
      expect(updated).toMatchObject({
        settingsVersion: 11,
        knowledgeBackend: "adx",
        adxClusterUrl: "https://example.southcentralus.kusto.windows.net",
        adxDefaultDatabase: "client-database",
        adxAuthMode: "device-code",
      });
      expect(JSON.stringify(updated)).not.toContain("clientSecret");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes an ADX portal link supplied through environment defaults", () => {
    const previousCluster = process.env.ATSLA_ADX_CLUSTER_URL;
    const previousDatabase = process.env.ATSLA_ADX_DEFAULT_DATABASE;
    try {
      process.env.ATSLA_ADX_CLUSTER_URL = "https://dataexplorer.azure.com/clusters/example.southcentralus/databases/client-database";
      delete process.env.ATSLA_ADX_DEFAULT_DATABASE;
      expect(defaultSettings()).toMatchObject({
        adxClusterUrl: "https://example.southcentralus.kusto.windows.net",
        adxDefaultDatabase: "client-database",
      });
    } finally {
      if (previousCluster === undefined) delete process.env.ATSLA_ADX_CLUSTER_URL;
      else process.env.ATSLA_ADX_CLUSTER_URL = previousCluster;
      if (previousDatabase === undefined) delete process.env.ATSLA_ADX_DEFAULT_DATABASE;
      else process.env.ATSLA_ADX_DEFAULT_DATABASE = previousDatabase;
    }
  });

  it("migrates the prior default theme and adds the Eva voice profile", () => {
    const root = mkdtempSync(join(tmpdir(), "voice-bridge-atsla-theme-"));
    try {
      const path = join(root, "settings.json");
      const legacy = {
        ...defaultSettings(),
        settingsVersion: 8,
        appearanceTheme: "atelier",
        voiceProfiles: defaultSettings().voiceProfiles.filter((profile) => profile.id === "appatalks"),
      };
      writeFileSync(path, JSON.stringify(legacy), "utf8");

      const migrated = new SettingsStore(path).get();
      expect(migrated).toMatchObject({ settingsVersion: 11, appearanceTheme: "atsla" });
      expect(migrated.voiceProfiles.find((profile) => profile.id === "eva")?.instructions).toContain("warm, curious, and genuine");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});