// Mirrors the actual response shapes returned by server/routes/workspace.js
// and server/lib/sessions.js/clients.js/users.js in the chatbot-ai repo --
// keep these in sync if those change. Verified against a real running
// instance while building this SDK, not just read off the source.

export interface Agent {
  /** A stable identifier for this specific human on the CALLING system's
   * side (e.g. your CRM's own user id). Required for every chat action --
   * this is what lets chatbot-ai tell two different agents apart and
   * enforce "only whoever claimed it can reply" (see collision guard notes
   * on ChatbotClient.reply). Never needs to correspond to anything in
   * chatbot-ai's own user database. */
  id: string;
  /** Shown to the visitor in place of the bot's name once this agent
   * claims the conversation. */
  name: string;
  /** Optional -- shown to the visitor alongside the name. */
  avatarUrl?: string;
}

export interface AgentIdentity {
  name: string;
  avatarUrl: string | null;
}

export interface ChatMessage {
  seq: number;
  ts: number;
  role: "user" | "assistant";
  content: string;
  sender?: AgentIdentity;
}

export interface LastMessage {
  role: "user" | "assistant";
  content: string;
  sender: AgentIdentity | null;
}

/** One row in the inbox list -- see summarizeForAgent in lib/sessions.js. */
export interface ConversationSummary {
  id: string;
  clientId: string;
  visitorId: string | null;
  agent: AgentIdentity | null;
  agentUserId: string | null;
  agentRequested: boolean;
  agentRequestedAt: number | null;
  locked: boolean;
  tempLocked: boolean;
  /** True when a visitor asked for a human and nobody has claimed it yet --
   * this is the queue a CRM's UI should badge/notify on. */
  waiting: boolean;
  seq: number;
  messageCount: number;
  updatedAt: number;
  createdAt: number;
  lastMessage: LastMessage | null;
  /** The visitor's own most recent words, separate from lastMessage -- useful
   * because lastMessage is often just a canned "connecting you..." line. */
  lastVisitorMessage: string | null;
  ip: string | null;
  /** Same-IP conversations are grouped under one human-friendly number so a
   * visitor opening several tabs doesn't look like several strangers. A
   * triage hint, not an identity claim -- see groupByIp in lib/sessions.js. */
  visitorNumber: number;
  sameIpOpenCount: number;
}

export interface InboxResponse {
  sessions: ConversationSummary[];
  counts: { waiting: number; mine: number; active: number };
  serverTime: number;
}

/** GET /sessions/:id -- everything ConversationSummary has, plus the full
 * transcript. */
export interface ConversationDetail extends ConversationSummary {
  messages: ChatMessage[];
}

export interface ReplyResult {
  message: ChatMessage;
  seq: number;
}

/** One FAQ entry shown as a tappable question in the widget. */
export interface Faq {
  question: string;
  answer: string;
}

/** One page/section link the bot can offer as a clickable button -- see
 * NAV_OPTIONS_MARKER in lib/sarvam.js. */
export interface PageLink {
  label: string;
  url: string;
}

/** GET/POST /client -- everything except identitySecret/ownerApiKey/
 * agentApiKey, which never leave the platform-admin API. */
export interface WorkspaceConfig {
  id: string;
  botName: string;
  welcomeMessage: string;
  brandColor: string;
  businessInfo: string;
  faqs: Faq[];
  tone: string;
  avatarUrl: string;
  website: string;
  pages: PageLink[];
  quickReplies: string[];
  createdAt: string;
  updatedAt: string;
}

/** Only the fields POST /client actually accepts -- send just what's
 * changing, anything omitted keeps its current value server-side. */
export type WorkspaceConfigUpdate = Partial<
  Omit<WorkspaceConfig, "id" | "createdAt" | "updatedAt">
>;

export type WorkspaceRole = "owner" | "agent";

export interface WorkspaceUser {
  id: string;
  clientId: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  avatarUrl: string;
}

export interface CreateWorkspaceUserInput {
  email: string;
  password: string;
  name: string;
  role: WorkspaceRole;
}

/** Thrown for any non-2xx response. `status` and `body` are the raw HTTP
 * status and parsed JSON error body, so callers can branch on e.g. 409
 * ("someone else already has this conversation") without string-matching
 * the message. */
export class ChatbotApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `Request failed with status ${status}`;
    super(message);
    this.name = "ChatbotApiError";
    this.status = status;
    this.body = body;
  }
}
