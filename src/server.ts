import { type LocalModelId, type ResponseMode, modelProfiles, responseTemplates } from "./domain.js";
import { spawn } from "node:child_process";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { fastifyRateLimit } from "@fastify/rate-limit";
import { MeetingCoordinator } from "./coordinator.js";
import { DraftStore, ResponsePolicy } from "./policy.js";
import { CopilotAcpProvider, LocalQwenProvider, OpenAiCompatibleProvider, ProviderRouter, SimulationProvider } from "./providers.js";
import { dashboard } from "./dashboard.js";
import { runSimulation } from "./simulation.js";
import { LocalVoiceBridgeOutput, SimulatedSpeechOutput } from "./voice.js";
import { MacVoiceOutput, PipeWireVoiceOutput } from "./voice.js";
import { AudioControl } from "./audio-control.js";
import { ClientWorkspace, SettingsStore, copilotReasoningEfforts } from "./settings.js";
import { SessionStore } from "./session-store.js";
import { type KnowledgeProposal, type KnowledgeProposalOperation, type KnowledgeScope, type KnowledgeSnapshot } from "./knowledge-store.js";

const responseModes: ResponseMode[] = ["disabled", "suggest", "approval", "guarded-autonomous", "autonomous"];
const knowledgeScopes: KnowledgeScope[] = ["client", "public"];
const knowledgeProposalStatuses: Array<KnowledgeProposal["status"] | "all"> = ["pending", "approved", "rejected", "all"];
const knowledgeProposalOperations: KnowledgeProposalOperation[] = ["upsert", "retire"];
const statusRateLimit = { max: 600, timeWindow: "1 minute" } as const;
const filesystemRateLimit = { max: 120, timeWindow: "1 minute" } as const;

async function isReachable(endpoint: URL | undefined, authToken?: string): Promise<boolean> {
  if (!endpoint) return false;
  try {
    const headers = authToken?.trim() ? { authorization: `Bearer ${authToken.trim()}` } : undefined;
    const response = await fetch(new URL("health", endpoint), { headers, signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

export function buildServer() {
  const app = Fastify({ logger: false });
  const providerKind = process.env.VOICE_BRIDGE_PROVIDER ?? "simulation";
  const configuredModel = process.env.VOICE_BRIDGE_LOCAL_MODEL ?? "qwen3-8b";
  const modelId: LocalModelId = configuredModel in modelProfiles ? configuredModel as LocalModelId : "qwen3-8b";
  const localQwenUrl = new URL(process.env.LOCAL_QWEN_URL ?? "http://127.0.0.1:8001/");
  const copilotAcpUrl = new URL(process.env.COPILOT_ACP_URL ?? "http://127.0.0.1:8888/");
  const settingsStore = new SettingsStore();
  const savedSettings = settingsStore.get();
  const provider = providerKind === "local-qwen" || providerKind === "copilot-acp"
    ? new ProviderRouter(
      new LocalQwenProvider(localQwenUrl, modelId),
      new CopilotAcpProvider(copilotAcpUrl, savedSettings.copilotModel, fetch, savedSettings.copilotReasoningEffort),
      savedSettings.modelProvider,
    )
    : providerKind === "openai-compatible"
      ? new OpenAiCompatibleProvider(new URL(process.env.LOCAL_MODEL_URL ?? "http://127.0.0.1:1234/v1/"), modelId)
      : new SimulationProvider();
  const voiceBridgeUrl = providerKind !== "simulation" || process.env.LOCAL_VOICE_BRIDGE_URL
    ? new URL(savedSettings.ttsEngineUrl)
    : undefined;
  const voiceBridgeAuthToken = process.env.VOICE_BRIDGE_TTS_AUTH_TOKEN;
  const audioOutput = process.env.VOICE_BRIDGE_AUDIO_OUTPUT;
  const speech = voiceBridgeUrl && audioOutput === "pipewire"
    ? new PipeWireVoiceOutput(voiceBridgeUrl, process.env.VOICE_BRIDGE_AGENT_SINK ?? "voice_bridge_agent", spawn, fetch, voiceBridgeAuthToken)
    : voiceBridgeUrl && audioOutput === "coreaudio"
      ? new MacVoiceOutput(voiceBridgeUrl, process.env.VOICE_BRIDGE_MAC_AGENT_DEVICE, spawn, fetch, voiceBridgeAuthToken)
    : voiceBridgeUrl
      ? new LocalVoiceBridgeOutput(voiceBridgeUrl, fetch, voiceBridgeAuthToken)
      : new SimulatedSpeechOutput();
  const coordinator = new MeetingCoordinator(provider, new ResponsePolicy(), new DraftStore(), speech, settingsStore, new ClientWorkspace(), new SessionStore());
  const audio = new AudioControl(new URL("../tools/audio-bridge.sh", import.meta.url).pathname, process.env.VOICE_BRIDGE_ENABLE_AUDIO_CONTROL === "true");

  fastifyRateLimit(app, { global: true, max: 120, timeWindow: "1 minute" }, (error) => {
    if (error) throw error;
  });
  app.register(cors, { origin: false });
  app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(dashboard));
  app.get("/health", { config: { rateLimit: false } }, async () => ({
    ok: true,
    provider: provider.id,
    simulation: provider.id === "simulation",
    voice: speech.constructor.name,
    voiceProfile: process.env.VOICE_BRIDGE_VOICE_PROFILE ?? "AppaTalks",
    transcriptionModel: process.env.VOICE_BRIDGE_TRANSCRIPTION_MODEL ?? "whisper.cpp base.en",
    audioControlEnabled: process.env.VOICE_BRIDGE_ENABLE_AUDIO_CONTROL === "true",
    dependencies: {
      modelReady: provider.id === "simulation" || await isReachable(provider.id === "copilot-acp" ? copilotAcpUrl : localQwenUrl),
      voiceReady: voiceBridgeUrl ? await isReachable(voiceBridgeUrl, voiceBridgeAuthToken) : speech.constructor === SimulatedSpeechOutput,
    },
  }));
  app.get("/v1/models", async () => ({ default: modelId, profiles: modelProfiles }));
  app.get("/v1/templates", async () => responseTemplates);
  app.get("/v1/provider-options", async () => {
    const fallbackCopilot = ["auto", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4", "claude-sonnet-4.6", "gpt-4.1"];
    let copilotModels = fallbackCopilot;
    try {
      const response = await fetch(new URL("v1/models", copilotAcpUrl), { signal: AbortSignal.timeout(1_500) });
      const payload = await response.json() as { models?: Array<string | { id?: string; name?: string }>; data?: Array<{ id?: string }> };
      const discovered = (payload.models ?? payload.data ?? []).map((model) => typeof model === "string" ? model : model.id ?? ("name" in model ? model.name ?? "" : "")).filter((model) => Boolean(model) && model !== "copilot");
      if (discovered.length) copilotModels = [...new Set(["auto", ...discovered, ...fallbackCopilot.slice(1)])];
    } catch {}
    return {
      providers: [
        { id: "local-qwen", label: "Local Qwen", ready: await isReachable(localQwenUrl), models: Object.entries(modelProfiles).map(([id, profile]) => ({ id, label: profile.label })) },
        { id: "copilot-acp", label: "GitHub Copilot CLI", ready: await isReachable(copilotAcpUrl), models: copilotModels.map((id) => ({ id, label: id === "auto" ? "Copilot automatic" : id })), reasoningEfforts: copilotReasoningEfforts.map((id) => ({ id, label: id === "default" ? "Model default" : id })) },
      ],
    };
  });
  app.get("/v1/settings", async () => coordinator.getSettings());
  app.put<{ Body: Record<string, unknown> }>("/v1/settings", async (request) => coordinator.updateSettings(request.body));
  app.post<{ Body: { clientId?: string; path?: string; name?: string; database?: string; supplementaryContextPath?: string; publicOnly?: boolean } }>("/v1/client-workspace", async (request, reply) => {
    try { return coordinator.selectClientWorkspace(request.body); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Client selection failed." }); }
  });
  app.get("/v1/client-workspace/status", { config: { rateLimit: filesystemRateLimit } }, async () => coordinator.workspaceStatus());
  app.get("/v1/client-workspace/knowledge-route", async () => ({ route: coordinator.clientKnowledgeRoute() }));
  app.put<{ Body: { database?: string; supplementaryContextPath?: string } }>("/v1/client-workspace/knowledge-route", async (request, reply) => {
    if (typeof request.body.database !== "string") return reply.code(400).send({ error: "database is required." });
    try { return { route: coordinator.setClientKnowledgeRoute({ database: request.body.database, supplementaryContextPath: request.body.supplementaryContextPath }) }; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Client knowledge route update failed." }); }
  });
  app.get("/v1/context/status", async () => coordinator.contextStatus());
  app.post("/v1/context/load", async (_request, reply) => {
    try { return await coordinator.loadClientContext(); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Client context load failed." }); }
  });
  app.post("/v1/context/clear", async () => coordinator.clearClientContext());
  app.get("/v1/knowledge/backend", async () => {
    const settings = coordinator.getSettings();
    return {
      backend: settings.knowledgeBackend,
      adx: {
        configured: Boolean(settings.adxClusterUrl),
        clusterUrl: settings.adxClusterUrl,
        authMode: settings.adxAuthMode,
        defaultDatabase: settings.adxDefaultDatabase,
        publicDatabase: settings.adxPublicDatabase,
      },
    };
  });
  app.get("/v1/knowledge/adx/databases", async (_request, reply) => {
    try { return { databases: await coordinator.listAdxDatabases() }; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "ADX database discovery failed." }); }
  });
  app.get<{ Params: { scope: string }; Querystring: { status?: string } }>("/v1/knowledge/:scope/proposals", async (request, reply) => {
    if (!knowledgeScopes.includes(request.params.scope as KnowledgeScope)) return reply.code(400).send({ error: "Knowledge scope must be client or public." });
    const status = request.query.status ?? "pending";
    if (!knowledgeProposalStatuses.includes(status as KnowledgeProposal["status"] | "all")) return reply.code(400).send({ error: "Invalid knowledge proposal status." });
    try { return { proposals: coordinator.listKnowledgeProposals(request.params.scope as KnowledgeScope, status as KnowledgeProposal["status"] | "all") }; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Knowledge proposals are unavailable." }); }
  });
  app.post<{ Params: { scope: string }; Body: { operation?: string; sourcePath?: string; title?: string; content?: string; evidenceSessionId?: string } }>("/v1/knowledge/:scope/proposals", async (request, reply) => {
    if (!knowledgeScopes.includes(request.params.scope as KnowledgeScope)) return reply.code(400).send({ error: "Knowledge scope must be client or public." });
    if (!request.body.operation || !knowledgeProposalOperations.includes(request.body.operation as KnowledgeProposalOperation)) return reply.code(400).send({ error: "Knowledge operation must be upsert or retire." });
    if (!request.body.sourcePath?.trim()) return reply.code(400).send({ error: "Knowledge sourcePath is required." });
    if (request.body.operation === "upsert" && (!request.body.title?.trim() || !request.body.content?.trim())) return reply.code(400).send({ error: "Knowledge upserts require title and content." });
    if ((request.body.content?.length ?? 0) > 200_000) return reply.code(400).send({ error: "Knowledge proposal content exceeds 200000 characters." });
    try {
      return { proposal: await coordinator.createKnowledgeProposal(request.params.scope as KnowledgeScope, {
        operation: request.body.operation as KnowledgeProposalOperation,
        sourcePath: request.body.sourcePath,
        title: request.body.title,
        content: request.body.content,
        evidenceSessionId: request.body.evidenceSessionId,
      }) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Knowledge proposal creation failed." });
    }
  });
  app.post<{ Params: { scope: string; proposalId: string; decision: string } }>("/v1/knowledge/:scope/proposals/:proposalId/:decision", async (request, reply) => {
    if (!knowledgeScopes.includes(request.params.scope as KnowledgeScope)) return reply.code(400).send({ error: "Knowledge scope must be client or public." });
    if (request.params.decision !== "approve" && request.params.decision !== "reject") return reply.code(400).send({ error: "Knowledge proposal decision must be approve or reject." });
    try { return { proposal: await coordinator.reviewKnowledgeProposal(request.params.scope as KnowledgeScope, request.params.proposalId, request.params.decision) }; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Knowledge proposal review failed." }); }
  });
  app.get<{ Params: { scope: string } }>("/v1/knowledge/:scope/export", async (request, reply) => {
    if (!knowledgeScopes.includes(request.params.scope as KnowledgeScope)) return reply.code(400).send({ error: "Knowledge scope must be client or public." });
    try { return { snapshot: coordinator.exportKnowledge(request.params.scope as KnowledgeScope) }; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Knowledge export failed." }); }
  });
  app.post<{ Params: { scope: string }; Body: { snapshot?: KnowledgeSnapshot } }>("/v1/knowledge/:scope/import", { bodyLimit: 20 * 1024 * 1024 }, async (request, reply) => {
    if (!knowledgeScopes.includes(request.params.scope as KnowledgeScope)) return reply.code(400).send({ error: "Knowledge scope must be client or public." });
    if (!request.body.snapshot || typeof request.body.snapshot !== "object") return reply.code(400).send({ error: "A knowledge snapshot is required." });
    try { return { result: await coordinator.importKnowledge(request.params.scope as KnowledgeScope, request.body.snapshot) }; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Knowledge import failed." }); }
  });
  app.post<{ Params: { scope: string }; Body: { direction?: string } }>("/v1/knowledge/:scope/sync", async (request, reply) => {
    if (!knowledgeScopes.includes(request.params.scope as KnowledgeScope)) return reply.code(400).send({ error: "Knowledge scope must be client or public." });
    if (request.body.direction !== "pull" && request.body.direction !== "push") return reply.code(400).send({ error: "Knowledge sync direction must be pull or push." });
    try {
      const result = request.body.direction === "pull"
        ? await coordinator.pullKnowledge(request.params.scope as KnowledgeScope)
        : await coordinator.pushKnowledge(request.params.scope as KnowledgeScope);
      return { result };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Knowledge synchronization failed." });
    }
  });
  app.get("/v1/sessions", async () => ({ sessions: coordinator.listSessions(), activeSession: coordinator.activeSessionInfo() }));
  app.post<{ Body: { title?: string } }>("/v1/sessions", async (request, reply) => {
    try { return { session: await coordinator.createSession(request.body) }; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Session creation failed." }); }
  });
  app.post<{ Body: { requestFeedback?: boolean; feedbackText?: string; feedbackScore?: number | null } }>("/v1/sessions/complete", async (request, reply) => {
    try { return await coordinator.completeSession(request.body); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Session completion failed." }); }
  });
  app.post<{ Params: { sessionId: string } }>("/v1/sessions/:sessionId/select", async (request, reply) => {
    try { return { session: coordinator.selectSession(request.params.sessionId) }; }
    catch (error) { return reply.code(404).send({ error: error instanceof Error ? error.message : "Session selection failed." }); }
  });
  app.patch<{ Params: { sessionId: string }; Body: { title?: string } }>("/v1/sessions/:sessionId", async (request, reply) => {
    if (!request.body.title?.trim()) return reply.code(400).send({ error: "Session title is required." });
    try { return { session: coordinator.renameSession(request.params.sessionId, request.body.title) }; }
    catch (error) { return reply.code(404).send({ error: error instanceof Error ? error.message : "Session rename failed." }); }
  });
  app.post("/v1/meeting-summary", async () => {
    const result = await coordinator.summarizeMeeting();
    return { summary: result.text, path: result.path, proposal: result.proposal };
  });
  app.get("/v1/state", { config: { rateLimit: false } }, async () => ({ ...coordinator.state(), activeSession: coordinator.activeSessionInfo() }));
  app.post<{ Body: { mode?: ResponseMode } }>("/v1/mode", async (request, reply) => {
    if (!request.body.mode || !responseModes.includes(request.body.mode)) return reply.code(400).send({ error: "A valid response mode is required." });
    coordinator.setMode(request.body.mode);
    return { mode: request.body.mode };
  });
  app.post<{ Body: { speaker?: "remote" | "local" | "agent"; text?: string } }>("/v1/transcripts", async (request, reply) => {
    if (!request.body.speaker || !request.body.text?.trim()) return reply.code(400).send({ error: "speaker and text are required." });
    await coordinator.ingest({ id: crypto.randomUUID(), speaker: request.body.speaker, text: request.body.text.trim(), occurredAt: new Date().toISOString() });
    return { ok: true };
  });
  app.post<{ Body: { question?: string } }>("/v1/drafts", async (request, reply) => {
    if (!request.body.question?.trim()) return reply.code(400).send({ error: "question is required." });
    return coordinator.draft(request.body.question.trim());
  });
  app.post<{ Params: { draftId: string } }>("/v1/drafts/:draftId/authorize", async (request, reply) => {
    try { return await coordinator.authorize(request.params.draftId); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Authorization failed." }); }
  });
  app.post<{ Params: { draftId: string } }>("/v1/drafts/:draftId/dismiss", async (request, reply) => {
    try { return { draft: coordinator.dismiss(request.params.draftId) }; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Dismissal failed." }); }
  });
  app.post<{ Params: { escalationId: string } }>("/v1/escalations/:escalationId/acknowledge", async (request, reply) => {
    try { return { escalation: coordinator.acknowledgeEscalation(request.params.escalationId) }; }
    catch (error) { return reply.code(404).send({ error: error instanceof Error ? error.message : "Escalation acknowledgement failed." }); }
  });
  app.post("/v1/stop", async () => { coordinator.stopSpeech(); return { ok: true }; });
  app.post<{ Body: { instruction?: string } }>("/v1/respond", async (request) => coordinator.respondToConversation(request.body.instruction ?? ""));
  app.post<{ Body: { text?: string } }>("/v1/templates/speak", async (request, reply) => {
    if (!request.body.text?.trim()) return reply.code(400).send({ error: "Template text is required." });
    try { return await coordinator.speakTemplate(request.body.text); }
    catch (error) { return reply.code(500).send({ error: error instanceof Error ? error.message : "Template speech failed." }); }
  });
  app.get("/v1/audio/status", { config: { rateLimit: statusRateLimit } }, async () => audio.status());
  app.post("/v1/audio/start", async (_request, reply) => {
    try { return { output: await audio.start() }; }
    catch (error) { return reply.code(403).send({ error: error instanceof Error ? error.message : "Audio start failed." }); }
  });
  app.post("/v1/audio/stop", async (_request, reply) => {
    try { return { output: await audio.stop() }; }
    catch (error) { return reply.code(500).send({ error: error instanceof Error ? error.message : "Audio stop failed." }); }
  });
  app.post<{ Body: { mode?: ResponseMode } }>("/v1/simulation/run", async (request) => runSimulation(request.body.mode ?? "approval"));
  return app;
}