export const modelProfiles = {
  "qwen3-8b": {
    label: "Qwen3 8B",
    model: "Qwen/Qwen3-8B",
    recommendation: "Default local profile; strong general reasoning on a 16 GB GPU when quantized.",
  },
  "qwen2.5-7b": {
    label: "Qwen2.5 7B",
    model: "Qwen/Qwen2.5-7B-Instruct",
    recommendation: "Strong 4-bit local reasoning alternative.",
  },
  "qwen2.5-1.5b": {
    label: "Qwen2.5 1.5B",
    model: "Qwen/Qwen2.5-1.5B-Instruct",
    recommendation: "Responsive model for lightweight meeting assistance.",
  },
  "qwen3-0.6b": {
    label: "Qwen3 0.6B",
    model: "Qwen/Qwen3-0.6B",
    recommendation: "Fastest local option for simple conversational turns.",
  },
} as const;

export type LocalModelId = keyof typeof modelProfiles;
export type ProviderId = "simulation" | "openai-compatible" | "copilot-acp" | "local-qwen";
export type ResponseMode = "disabled" | "suggest" | "approval" | "guarded-autonomous" | "autonomous";
export type Speaker = "remote" | "local" | "agent";
export const NO_RESPONSE_SENTINEL = "[[NO_RESPONSE]]";
export const STANDARD_GREETING = "Hi, I am AppaTalks, your AI support agent. I can help with support questions and next steps. If you would like a live representative, say Live Representative Please and I will notify one. How can I help today?";
export const CUSTOMER_FEEDBACK_REQUEST = "Before we wrap up, did this resolve your issue? You can answer yes or no, and optionally rate this support from one to five.";
export const BACKCHANNEL_ACKNOWLEDGEMENTS = ["Mm-hmm.", "I understand."] as const;

export interface TranscriptEvent {
  id: string;
  speaker: Speaker;
  text: string;
  occurredAt: string;
}

export interface ChatRequest {
  transcript: TranscriptEvent[];
  question: string;
  cancellationSignal?: AbortSignal;
}

export interface ModelReply {
  text: string;
  provider: ProviderId;
  model: string;
  usage?: ModelUsage;
}

export interface ModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  durationSeconds?: number;
  tokensPerSecond?: number;
  exact: boolean;
}

export interface SessionTelemetry {
  startedAt: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  measuredRequests: number;
  generationSeconds: number;
  averageTokensPerSecond: number | null;
  usageAvailable: boolean;
  lastModel: string;
  lastProvider: ProviderId | "";
}

export interface ChatProvider {
  readonly id: ProviderId;
  complete(request: ChatRequest): Promise<ModelReply>;
}

export interface Draft {
  id: string;
  question: string;
  reply: ModelReply;
  disposition: "suggested" | "pending-approval" | "authorized" | "blocked" | "dismissed";
  createdAt: string;
}

export interface AgentActivity {
  id: string;
  kind: "listening" | "thinking" | "pending" | "speaking" | "stopped" | "error";
  message: string;
  createdAt: string;
  draftId?: string;
}

export interface EscalationRequest {
  id: string;
  text: string;
  createdAt: string;
  status: "pending" | "acknowledged";
}

export type SessionStatus = "active" | "awaiting-feedback" | "completed";
export type SessionResolution = "resolved" | "unresolved" | "escalated";

export interface SessionCompletion {
  resolution: SessionResolution;
  feedbackText: string;
  feedbackScore: number | null;
  summary: string;
  completedAt: string;
  promotedProposalIds: string[];
  pendingProposalIds: string[];
  discardedCandidates: number;
}

export interface MeetingSession {
  id: string;
  title: string;
  clientId: string;
  clientWorkspace: string;
  createdAt: string;
  updatedAt: string;
  greetingSent: boolean;
  status: SessionStatus;
  completion?: SessionCompletion;
  transcript: TranscriptEvent[];
  drafts: Draft[];
  activity: AgentActivity[];
  escalations: EscalationRequest[];
}

export interface MeetingSessionSummary {
  id: string;
  title: string;
  clientId: string;
  clientWorkspace: string;
  createdAt: string;
  updatedAt: string;
  greetingSent: boolean;
  status: SessionStatus;
  resolution?: SessionResolution;
  transcriptEvents: number;
}

export interface ResponseTemplate {
  id: string;
  label: string;
  text: string;
}

export const responseTemplates: ResponseTemplate[] = [
  {
    id: "standard-greeting",
    label: "Standard greeting",
    text: STANDARD_GREETING,
  },
  {
    id: "acknowledge",
    label: "Acknowledge",
    text: "I understand. Let me review that and give you the clearest next step.",
  },
  {
    id: "verify-details",
    label: "Verify details",
    text: "I want to make sure I give you an accurate answer. Let me verify the details for you.",
  },
  {
    id: "live-representative",
    label: "Live representative",
    text: "Absolutely. I will route your request to a live representative or counterpart now.",
  },
  {
    id: "follow-up",
    label: "Follow-up",
    text: "I have documented that request and will make sure the appropriate team follows up.",
  },
  {
    id: "customer-feedback",
    label: "Request feedback",
    text: CUSTOMER_FEEDBACK_REQUEST,
  },
];