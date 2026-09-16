import {
  Agent,
  ChatbotApiError,
  ConversationDetail,
  ConversationSummary,
  CreateWorkspaceUserInput,
  InboxResponse,
  ReplyResult,
  WorkspaceConfig,
  WorkspaceConfigUpdate,
  WorkspaceUser,
} from "./types";

export interface ChatbotClientConfig {
  /** Origin the chatbot-ai backend is running at, e.g.
   * "https://chatbot-ai-pi-pearl.vercel.app" -- no trailing slash. */
  baseUrl: string;
  /** The chatbot-ai workspace/client id this instance talks to. One
   * ChatbotClient per workspace. */
  workspaceId: string;
  /** Either that workspace's ownerApiKey (settings + chat) or agentApiKey
   * (chat only) -- see lib/clients.js. Using the agent key on a
   * settings/team call throws a ChatbotApiError with status 403, same as
   * if a logged-in agent tried it in the browser dashboard. */
  apiKey: string;
}

/**
 * Server-to-server client for the chatbot-ai workspace API -- lets a CRM
 * (or any other backend) act as a workspace's agents/owner without a human
 * logging into chatbot-ai directly. See requireAuth's API-key path in
 * lib/auth.js on the server for the other half of this contract.
 *
 * One instance per workspace: construct with that workspace's id and one of
 * its two keys. Every chat-action method additionally takes an `Agent`
 * identifying who on YOUR side is acting -- chatbot-ai has no account of
 * its own for them, so that identity has to come from you on every call.
 */
export class ChatbotClient {
  private readonly baseUrl: string;
  private readonly workspaceId: string;
  private readonly apiKey: string;

  constructor(config: ChatbotClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.workspaceId = config.workspaceId;
    this.apiKey = config.apiKey;
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    options: { body?: unknown; agent?: Agent } = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      "x-workspace-id": this.workspaceId,
      "x-api-key": this.apiKey,
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.agent) {
      headers["x-agent-id"] = options.agent.id;
      headers["x-agent-name"] = options.agent.name;
      if (options.agent.avatarUrl) headers["x-agent-avatar"] = options.agent.avatarUrl;
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    // Every route in this API responds with JSON, success or error, so a
    // parse failure here means something upstream of the app itself (a
    // proxy's error page, a fully-down server) -- surface that distinctly
    // rather than as a confusing "Unexpected token '<'" from JSON.parse.
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new ChatbotApiError(response.status, {
        error: `Non-JSON response (HTTP ${response.status}) -- is baseUrl correct and the server reachable?`,
      });
    }

    if (!response.ok) throw new ChatbotApiError(response.status, parsed);
    return parsed as T;
  }

  // ---- inbox / conversations ----------------------------------------

  /** The whole dashboard state in one call -- poll this on an interval
   * (chatbot-ai's own dashboard polls every 4s) to keep a CRM's chat list
   * live; there's no websocket/push option here. */
  getInbox(): Promise<InboxResponse> {
    return this.request<InboxResponse>("GET", "/api/workspace/inbox");
  }

  /** Full transcript for one conversation. */
  getConversation(sessionId: string): Promise<ConversationDetail> {
    return this.request<ConversationDetail>("GET", `/api/workspace/sessions/${sessionId}`);
  }

  /** Picks up a waiting conversation. First caller wins -- if a teammate
   * (any agent, from chatbot-ai's own dashboard or another CRM call) got
   * there first, this throws ChatbotApiError with status 409 and
   * `body.agent` set to who actually holds it, so the UI can correct
   * itself instead of two agents unknowingly answering the same visitor.
   * `greeting`, if given, posts as the agent's first message immediately. */
  claim(sessionId: string, agent: Agent, greeting?: string): Promise<ConversationSummary> {
    return this.request<ConversationSummary>("POST", `/api/workspace/sessions/${sessionId}/claim`, {
      agent,
      body: greeting ? { greeting } : {},
    });
  }

  /** Sends a message to the visitor as this agent. Throws 409 if the
   * conversation hasn't been claimed yet, or if a *different* agent
   * (matched by Agent.id) currently holds it -- always claim() first, and
   * always pass the SAME Agent.id across a given agent's calls, or every
   * call looks like a different person and reply() will 409 immediately
   * after your own claim(). */
  reply(sessionId: string, agent: Agent, message: string): Promise<ReplyResult> {
    return this.request<ReplyResult>("POST", `/api/workspace/sessions/${sessionId}/reply`, {
      agent,
      body: { message },
    });
  }

  /** Hands the conversation back to the AI. The bot gets everything the
   * agent said as context, and picks up from there. */
  release(sessionId: string, agent: Agent): Promise<ConversationSummary> {
    return this.request<ConversationSummary>("POST", `/api/workspace/sessions/${sessionId}/release`, {
      agent,
    });
  }

  /** Ends the conversation outright (unlike release, which stays open with
   * the bot). Same 409 collision rule as reply() if a teammate holds it. */
  close(sessionId: string, agent: Agent): Promise<ConversationSummary> {
    return this.request<ConversationSummary>("POST", `/api/workspace/sessions/${sessionId}/close`, {
      agent,
    });
  }

  // ---- workspace settings (owner key only) ---------------------------

  /** Business info, FAQs, tone, personality, page/section links, branding.
   * Requires an owner-level apiKey -- throws 403 with an agent key. */
  getConfig(): Promise<WorkspaceConfig> {
    return this.request<WorkspaceConfig>("GET", "/api/workspace/client");
  }

  /** Partial update -- only send fields that are changing; anything
   * omitted keeps its current server-side value. */
  updateConfig(update: WorkspaceConfigUpdate): Promise<WorkspaceConfig> {
    return this.request<WorkspaceConfig>("POST", "/api/workspace/client", { body: update });
  }

  // ---- team management (owner key only) ------------------------------

  listUsers(): Promise<WorkspaceUser[]> {
    return this.request<{ users: WorkspaceUser[] }>("GET", "/api/workspace/users").then(
      (r) => r.users
    );
  }

  addUser(input: CreateWorkspaceUserInput): Promise<WorkspaceUser> {
    return this.request<WorkspaceUser>("POST", "/api/workspace/users", { body: input });
  }

  /** Throws 400 if this is the workspace's last owner -- a workspace always
   * needs at least one, same rule as removing them from the browser
   * dashboard. */
  removeUser(userId: string): Promise<void> {
    return this.request<{ deleted: true }>("DELETE", `/api/workspace/users/${userId}`).then(
      () => undefined
    );
  }
}
