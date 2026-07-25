import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("HTTP control plane", () => {
  const servers: ReturnType<typeof buildServer>[] = [];
  let testRoot = "";

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "voice-bridge-server-test-"));
    process.env.VOICE_BRIDGE_SETTINGS_PATH = join(testRoot, "settings.json");
    process.env.VOICE_BRIDGE_SESSIONS_PATH = join(testRoot, "sessions");
    process.env.VOICE_BRIDGE_CLIENTS_ROOT = join(testRoot, "clients");
    process.env.VOICE_BRIDGE_GLOBAL_KNOWLEDGE_PATH = join(testRoot, "global");
    process.env.ATSLA_KNOWLEDGE_BACKEND = "sqlite";
    delete process.env.ATSLA_ADX_CLUSTER_URL;
    delete process.env.ATSLA_ADX_DEFAULT_DATABASE;
    delete process.env.ATSLA_ADX_PUBLIC_DATABASE;
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    delete process.env.VOICE_BRIDGE_SETTINGS_PATH;
    delete process.env.VOICE_BRIDGE_SESSIONS_PATH;
    delete process.env.VOICE_BRIDGE_CLIENTS_ROOT;
    delete process.env.VOICE_BRIDGE_GLOBAL_KNOWLEDGE_PATH;
    delete process.env.VOICE_BRIDGE_PROVIDER;
    delete process.env.LOCAL_VOICE_BRIDGE_URL;
    delete process.env.ATSLA_KNOWLEDGE_BACKEND;
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("runs a draft through explicit authorization", async () => {
    const server = buildServer();
    servers.push(server);

    expect((await server.inject({ method: "GET", url: "/health" })).json()).toMatchObject({ ok: true, simulation: true });
    expect((await server.inject({ method: "POST", url: "/v1/mode", payload: { mode: "approval" } })).statusCode).toBe(200);
    expect((await server.inject({ method: "POST", url: "/v1/transcripts", payload: { speaker: "remote", text: "Can you confirm the next step?" } })).statusCode).toBe(200);
    const draftResponse = await server.inject({ method: "POST", url: "/v1/drafts", payload: { question: "What is the next step?" } });
    const draft = draftResponse.json().draft;
    expect(draft.disposition).toBe("pending-approval");

    const authorization = await server.inject({ method: "POST", url: `/v1/drafts/${draft.id}/authorize` });
    expect(authorization.json().dispatch.status).toBe("spoken");
  });

  it("rate-limits repeated control-plane requests", async () => {
    const server = buildServer();
    servers.push(server);

    let response = await server.inject({ method: "GET", url: "/health" });
    for (let attempt = 0; attempt < 120; attempt += 1) response = await server.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(429);
  });

  it("serves the local simulation dashboard and model profiles", async () => {
    const server = buildServer();
    servers.push(server);

    const dashboard = await server.inject({ method: "GET", url: "/" });
    expect(dashboard.headers["content-type"]).toContain("text/html");
    expect(dashboard.body).toContain("ATSLA | Support Live Agent");
    expect(dashboard.body).toContain("AppaTalks");
    expect(dashboard.body).toContain("Open folder");
    expect(dashboard.body).toContain("Public knowledge only");
    expect(dashboard.body).toContain("data-settings-tab=\"workspace\"");
    expect(dashboard.body).toContain("data-settings-tab=\"agent\"");
    expect(dashboard.body).toContain("data-settings-tab=\"voice\"");
    expect(dashboard.body).toContain('id="ttsEngineUrl"');
    expect(dashboard.body).toContain('id="copilotReasoningEffort"');
    expect(dashboard.body).toContain("Higher levels can increase latency and premium usage");
    expect(dashboard.body).toContain("data-settings-tab=\"appearance\"");
    expect(dashboard.body).toContain("appearanceTheme");
    expect(dashboard.body).toContain("ATSLA signal");
    expect(dashboard.body).toContain("theme-atsla");
    expect(dashboard.body).toContain("glassTransparency");
    expect(dashboard.body).toContain("theme-lcars");
    expect(dashboard.body).toContain("theme-terminal");
    expect(dashboard.body).toContain("theme-dark");
    expect(dashboard.body).toContain("input-mode.active");
    expect(dashboard.body).toContain("Live representative requested");
    expect(dashboard.body).toContain("Take over");
    expect(dashboard.body).toContain('id="directText"');
    expect(dashboard.body).toContain("Speak direct text");
    expect(dashboard.body).toContain("/v1/templates/speak");
    expect(dashboard.body).toContain("submitOnEnter");
    expect(dashboard.body).toContain("event.key==='Enter'&&!event.shiftKey");
    expect(dashboard.body).toContain("intervene-input");
    expect(dashboard.body).not.toContain('id="wire"');
    expect(dashboard.body).toContain("height:calc(100vh - 16px)");
    expect(dashboard.body).not.toContain("window-drag-strip");
    expect(dashboard.body).toContain("event.target===byId('settingsOverlay')");
    expect(dashboard.body).toContain(".timeline{min-height:0;overflow-y:auto");
    expect(dashboard.body).toContain("session-rename-input");
    expect(dashboard.body).not.toContain("window.prompt('Rename session'");
    expect(dashboard.body).toContain("Writing meeting summary...");
    expect(dashboard.body).toContain("Pending knowledge proposals");
    expect(dashboard.body).toContain("/v1/knowledge/");
    expect(dashboard.body).toContain('id="knowledgeBackend"');
    expect(dashboard.body).toContain('id="adxClusterUrl"');
    expect(dashboard.body).toContain("Device code (personal account)");
    expect(dashboard.body).toContain('id="discoverAdxDatabases"');
    expect(dashboard.body).toContain('id="refreshClientDatabases"');
    expect(dashboard.body).toContain("loadAdxClientDatabases");
    expect(dashboard.body).toContain("Default public knowledge database");
    expect(dashboard.body).toContain("Optional; public knowledge stays local when blank");
    expect(dashboard.body).toContain("publicOnly:true");
    expect(dashboard.body).toContain('id="exportClientKnowledge"');
    expect(dashboard.body).toContain('id="knowledgeImportFile"');
    expect(dashboard.body).toContain("setInterval(refresh,3000)");
    expect(dashboard.body).toContain("Synced with ");
    const scriptStart = dashboard.body.indexOf("<script>");
    const scriptEnd = dashboard.body.lastIndexOf("</script>");
    const script = scriptStart >= 0 && scriptEnd > scriptStart
      ? dashboard.body.slice(scriptStart + "<script>".length, scriptEnd)
      : undefined;
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
    expect((await server.inject({ method: "GET", url: "/v1/models" })).json().profiles["qwen3-8b"].model).toBe("Qwen/Qwen3-8B");
  });

  it("uses the persisted TTS endpoint for a real provider without the legacy URL variable", async () => {
    process.env.VOICE_BRIDGE_PROVIDER = "local-qwen";
    delete process.env.LOCAL_VOICE_BRIDGE_URL;
    const server = buildServer();
    servers.push(server);

    expect((await server.inject({ method: "GET", url: "/health" })).json().voice).toBe("LocalVoiceBridgeOutput");
  });

  it("reports audio status but refuses device creation unless explicitly enabled", async () => {
    const server = buildServer();
    servers.push(server);

    expect((await server.inject({ method: "GET", url: "/v1/audio/status" })).json()).toHaveProperty("active");
    const start = await server.inject({ method: "POST", url: "/v1/audio/start" });
    expect(start.statusCode).toBe(403);
    expect(start.json().error).toContain("VOICE_BRIDGE_ENABLE_AUDIO_CONTROL=true");
  });

  it("lists Copilot Terra and Luna fallback models", async () => {
    const server = buildServer();
    servers.push(server);
    const options = (await server.inject({ method: "GET", url: "/v1/provider-options" })).json();
    const copilot = options.providers.find((provider: { id: string }) => provider.id === "copilot-acp");
    expect(copilot.models.map((model: { id: string }) => model.id)).toEqual(expect.arrayContaining(["gpt-5.6-terra", "gpt-5.6-luna"]));
    expect(copilot.reasoningEfforts.map((effort: { id: string }) => effort.id)).toEqual(["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("renames a persisted session and rejects blank titles", async () => {
    const server = buildServer();
    servers.push(server);
    await server.inject({ method: "POST", url: "/v1/client-workspace", payload: { name: "Session Client" } });
    const created = (await server.inject({ method: "POST", url: "/v1/sessions", payload: { title: "Original" } })).json().session;

    const renamed = await server.inject({ method: "PATCH", url: `/v1/sessions/${created.id}`, payload: { title: "Renamed session" } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().session.title).toBe("Renamed session");
    expect((await server.inject({ method: "GET", url: "/v1/sessions" })).json().sessions[0].title).toBe("Renamed session");

    const blank = await server.inject({ method: "PATCH", url: `/v1/sessions/${created.id}`, payload: { title: "   " } });
    expect(blank.statusCode).toBe(400);
  });

  it("uses public knowledge only when no client is selected", async () => {
    const server = buildServer();
    servers.push(server);
    await server.inject({ method: "POST", url: "/v1/client-workspace", payload: { name: "Known Client" } });

    const selected = await server.inject({ method: "POST", url: "/v1/client-workspace", payload: { publicOnly: true } });
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toMatchObject({ activeClientId: "", clientWorkspace: "" });

    const loaded = await server.inject({ method: "POST", url: "/v1/context/load" });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json()).toMatchObject({ loaded: true, scope: "public", backend: "sqlite" });
    expect((await server.inject({ method: "GET", url: "/v1/context/status" })).json()).toMatchObject({
      selectedClientId: "",
      client: { loaded: false },
      global: { enabled: true, loaded: true },
    });

    const session = await server.inject({ method: "POST", url: "/v1/sessions", payload: { title: "Unknown caller" } });
    expect(session.statusCode).toBe(200);
    expect(session.json().session).toMatchObject({ clientId: "public-knowledge-only", clientWorkspace: "" });
  });

  it("explicitly loads and clears only the selected client context", async () => {
    const server = buildServer();
    servers.push(server);
    const selected = (await server.inject({ method: "POST", url: "/v1/client-workspace", payload: { name: "Context Client" } })).json();
    expect(selected).toMatchObject({ clientWorkspace: "", activeClientId: expect.stringMatching(/^client-/) });
    expect(selected.clients).toMatchObject([{ name: "Context Client", supplementaryContextPath: "" }]);
    expect((await server.inject({ method: "GET", url: "/v1/context/status" })).json().client.loaded).toBe(false);

    const loaded = await server.inject({ method: "POST", url: "/v1/context/load" });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json()).toMatchObject({ loaded: true, path: selected.clientWorkspace });

    const cleared = await server.inject({ method: "POST", url: "/v1/context/clear" });
    expect(cleared.json()).toMatchObject({ loaded: false, path: "", files: 0 });
  });

  it("keeps proposed knowledge out of recall until scoped operator approval", async () => {
    const server = buildServer();
    servers.push(server);
    await server.inject({ method: "POST", url: "/v1/client-workspace", payload: { name: "Proposal Client" } });
    await server.inject({ method: "POST", url: "/v1/context/load" });

    const created = await server.inject({
      method: "POST",
      url: "/v1/knowledge/client/proposals",
      payload: {
        operation: "upsert",
        sourcePath: "ai/operator-approved.md",
        title: "Approved fact",
        content: "HTTP_PROPOSAL_CANARY",
      },
    });
    expect(created.statusCode).toBe(200);
    const proposal = created.json().proposal;
    expect(proposal).toMatchObject({ scope: "client", status: "pending" });
    expect((await server.inject({ method: "GET", url: "/v1/knowledge/client/proposals" })).json().proposals).toMatchObject([{ id: proposal.id }]);

    const before = await server.inject({ method: "POST", url: "/v1/drafts", payload: { question: "What approved fact is available?" } });
    expect(before.json().draft.reply.text).not.toContain("HTTP_PROPOSAL_CANARY");
    expect((await server.inject({ method: "POST", url: `/v1/knowledge/client/proposals/${proposal.id}/approve` })).json().proposal.status).toBe("approved");
    const after = await server.inject({ method: "POST", url: "/v1/drafts", payload: { question: "What approved fact is available?" } });
    expect(after.json().draft.reply.text).toContain("HTTP_PROPOSAL_CANARY");

    await server.inject({ method: "POST", url: "/v1/client-workspace", payload: { name: "Other Proposal Client" } });
    await server.inject({ method: "POST", url: "/v1/context/load" });
    expect((await server.inject({ method: "GET", url: "/v1/knowledge/client/proposals" })).json().proposals).toEqual([]);
    const crossClientReview = await server.inject({ method: "POST", url: `/v1/knowledge/client/proposals/${proposal.id}/approve` });
    expect(crossClientReview.statusCode).toBe(400);
    expect(crossClientReview.json().error).toContain("not found");
  });

  it("exports and imports only the selected stable client scope", async () => {
    const server = buildServer();
    servers.push(server);
    await server.inject({ method: "POST", url: "/v1/client-workspace", payload: { name: "Portable Client A" } });
    await server.inject({ method: "POST", url: "/v1/context/load" });
    const routeA = (await server.inject({ method: "GET", url: "/v1/client-workspace/knowledge-route" })).json().route;
    expect(routeA.clientId).toMatch(/^client-/);
    const mapped = await server.inject({ method: "PUT", url: "/v1/client-workspace/knowledge-route", payload: { database: "client-database" } });
    expect(mapped.json().route).toMatchObject({ clientId: routeA.clientId, knowledgeDatabase: "client-database" });
    await server.inject({ method: "POST", url: "/v1/context/load" });

    const exported = await server.inject({ method: "GET", url: "/v1/knowledge/client/export" });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().snapshot).toMatchObject({ format: "atsla-knowledge-snapshot", scope: "client", scopeId: routeA.clientId });
    const sameClientImport = await server.inject({ method: "POST", url: "/v1/knowledge/client/import", payload: { snapshot: exported.json().snapshot } });
    expect(sameClientImport.statusCode).toBe(200);

    await server.inject({ method: "POST", url: "/v1/client-workspace", payload: { name: "Portable Client B" } });
    await server.inject({ method: "POST", url: "/v1/context/load" });
    const crossClientImport = await server.inject({ method: "POST", url: "/v1/knowledge/client/import", payload: { snapshot: exported.json().snapshot } });
    expect(crossClientImport.statusCode).toBe(400);
    expect(crossClientImport.json().error).toContain("does not match selected scope");

    const backend = (await server.inject({ method: "GET", url: "/v1/knowledge/backend" })).json();
    expect(backend).toMatchObject({ backend: "sqlite", adx: { configured: false, authMode: "azure-cli" } });
    expect(JSON.stringify(backend)).not.toMatch(/secret|token/i);
  });
});