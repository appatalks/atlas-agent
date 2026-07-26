import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { type MeetingSession, type MeetingSessionSummary } from "./domain.js";

export class SessionStore {
  private readonly root: string;

  constructor(root = process.env.VOICE_BRIDGE_SESSIONS_PATH ?? join(homedir(), ".local", "share", "voice-bridge", "sessions")) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  create(title = "New conversation", clientId = "", clientWorkspace = ""): MeetingSession {
    const now = new Date().toISOString();
    const session: MeetingSession = {
      id: randomUUID(),
      title: title.trim().slice(0, 120) || "New conversation",
      clientId,
      clientWorkspace,
      createdAt: now,
      updatedAt: now,
      greetingSent: false,
      status: "active",
      transcript: [],
      drafts: [],
      activity: [],
      escalations: [],
    };
    this.save(session);
    return session;
  }

  save(session: MeetingSession): MeetingSession {
    const stored = { ...session, updatedAt: new Date().toISOString() };
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.path(stored.id), `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    return stored;
  }

  get(id: string): MeetingSession {
    const path = this.path(id);
    if (!existsSync(path)) throw new Error("Meeting session was not found.");
    return normalizeSession(JSON.parse(readFileSync(path, "utf8")) as Partial<MeetingSession>);
  }

  rename(id: string, title: string): MeetingSession {
    const cleanTitle = title.trim().slice(0, 120);
    if (!cleanTitle) throw new Error("Session title is required.");
    return this.save({ ...this.get(id), title: cleanTitle });
  }

  list(clientId: string): MeetingSessionSummary[] {
    if (!existsSync(this.root)) return [];
    const selectedClientId = clientId.trim();
    if (!selectedClientId) return [];
    return readdirSync(this.root)
      .filter(isSessionFileName)
      .flatMap((name) => {
        try {
          const session = normalizeSession(JSON.parse(readFileSync(this.path(name.slice(0, -5)), "utf8")) as Partial<MeetingSession>);
          if (session.clientId !== selectedClientId) return [];
          return [{
            id: session.id,
            title: session.title,
            clientId: session.clientId,
            clientWorkspace: session.clientWorkspace,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            greetingSent: session.greetingSent,
            status: session.status,
            resolution: session.completion?.resolution,
            transcriptEvents: session.transcript.length,
          }];
        } catch {
          return [];
        }
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  delete(id: string): void {
    rmSync(this.path(id), { force: true });
  }

  private path(id: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid session identifier.");
    const path = resolve(this.root, `${id}.json`);
    if (!isChildPath(this.root, path)) throw new Error("Invalid session path.");
    return path;
  }
}

function normalizeSession(session: Partial<MeetingSession>): MeetingSession {
  const clientWorkspace = typeof session.clientWorkspace === "string" ? session.clientWorkspace : "";
  return {
    id: String(session.id ?? ""),
    title: String(session.title ?? "New conversation"),
    clientId: typeof session.clientId === "string" && session.clientId ? session.clientId : clientWorkspace,
    clientWorkspace,
    createdAt: String(session.createdAt ?? new Date().toISOString()),
    updatedAt: String(session.updatedAt ?? session.createdAt ?? new Date().toISOString()),
    greetingSent: Boolean(session.greetingSent),
    status: session.status === "awaiting-feedback" || session.status === "completed" ? session.status : "active",
    ...(session.completion && typeof session.completion === "object" ? { completion: session.completion } : {}),
    transcript: Array.isArray(session.transcript) ? session.transcript : [],
    drafts: Array.isArray(session.drafts) ? session.drafts : [],
    activity: Array.isArray(session.activity) ? session.activity : [],
    escalations: Array.isArray(session.escalations) ? session.escalations : [],
  };
}

function isChildPath(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return Boolean(pathFromRoot) && !pathFromRoot.startsWith("..") && !pathFromRoot.startsWith("/");
}

function isSessionFileName(name: string): boolean {
  return /^[a-zA-Z0-9-]+\.json$/.test(name);
}