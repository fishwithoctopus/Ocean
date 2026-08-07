import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { JsonStore } from "./store.js";
import { buildFreeTimePrompt, DEFAULT_FREE_TIME_CONFIG, evaluateFreeTimeEligibility, normalizeFreeTimeConfig } from "./freeTime.js";
import type { StoredFreeTimeRun } from "./store.js";
import { ProviderRegistry } from "./providers/registry.js";
import type { OceanChatAttachment, ProviderChatRequest } from "./providers/types.js";
import { normalizeProviderError } from "./providers/streaming.js";
import { createMemoryAdapterFromEnv, dailyImpressions, type MemoryAdapter } from "./memory/adapter.js";
import { planChatMemoryRecall } from "./memory/recallPolicy.js";
import { recordMemoryEvent } from "./memory/events.js";
import { ContinuityService } from "./continuity.js";
import { createFishingGameConnectorFromEnv, type FishingGameConnector } from "./games/fishing.js";
import { fishingTools } from "./games/chatTool.js";
import { OceanAccessController } from "./access.js";
import { dispatchFreeTimeWithModel } from "./freeTimeDispatcher.js";
import { normalizeNotificationPreferences, OceanNotificationService } from "./notifications.js";
import type { PushSubscription } from "web-push";
import { NeteaseMusicService } from "./music/netease.js";
import { ProjectWorkspaceStore } from "./projectWorkspace.js";
import { deliverDuePaperNotes, generatePaperNotes, visiblePaperNotes } from "./paperNotes.js";
import { NotionSyncService } from "./notionSync.js";
import { isExplicitMemorySaveRequest } from "./memory/intent.js";

function coReadingConfig() {
  return {
    baseUrl: (process.env.CO_READING_BASE_URL ?? "http://127.0.0.1:8788").replace(/\/$/, ""),
    authToken: process.env.CO_READING_AUTH_TOKEN ?? "",
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", ...headers });
  response.end(JSON.stringify(value));
}

function cleanMemoryField(value: unknown, maxLength: number) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function stripMemoryCommand(value: string) {
  return value
    .replace(/^(?:宝宝[，,、 ]*)?(?:请|帮我|替我)?(?:记住|记一下|记下来|记得|存下|保存|写进|存进)(?:这件事|这条|一下|：|:|，|,|\s)*/u, "")
    .trim();
}

function structuredMemory(argumentsValue: Record<string, unknown>) {
  const title = cleanMemoryField(argumentsValue.title, 80);
  const event = stripMemoryCommand(cleanMemoryField(argumentsValue.event, 1_600));
  const meaning = cleanMemoryField(argumentsValue.meaning, 1_200);
  const continuity = cleanMemoryField(argumentsValue.continuity, 1_200);
  const tags = Array.isArray(argumentsValue.tags)
    ? argumentsValue.tags.map((tag) => cleanMemoryField(tag, 32)).filter(Boolean).slice(0, 10)
    : [];
  const importance = Math.max(1, Math.min(10, Math.round(Number(argumentsValue.importance) || 5)));
  if (!title || !event || !meaning || !continuity) return null;
  return {
    title,
    event,
    meaning,
    continuity,
    tags,
    importance,
    content: `# ${title}\n\n### 事件\n${event}\n\n### 为什么重要\n${meaning}\n\n### 连续性\n${continuity}`,
  };
}

function memoryTools(memory: MemoryAdapter, chatRequest: ProviderChatRequest) {
  const explicitSaveAllowed = isExplicitMemorySaveRequest(chatRequest.input);
  if (explicitSaveAllowed) {
    // OpenRouter/Anthropic rejects extended reasoning when tool_choice forces a
    // specific function. Explicit saves already have a strict schema, so this
    // one request omits reasoning and lets the model go straight to hold.
    const settings = { ...chatRequest.settings };
    delete settings.reasoning;
    chatRequest.settings = settings;
  }
  chatRequest.tools = [
    {
      type: "function",
      function: {
        name: "ocean_memory_breath",
        description: "Read relevant trusted long-term memory from 深海某处 (Ocean Memory 3.0). Use when the user explicitly asks you to remember or verify past information and the injected recall is insufficient.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "A concise memory search query." },
            max_results: { type: "integer", minimum: 1, maximum: 8, default: 4 },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "ocean_memory_hold",
        description: "Write one durable, well-organized memory into 深海某处. Use only when the current user explicitly asks to remember or save. First understand the relevant recent conversation, then describe the event, why it matters, and how it should guide future continuity. Never copy the save command itself and never reduce the memory to a vague one-line paraphrase.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "A specific Chinese memory title, normally 6-24 characters." },
            event: { type: "string", description: "A self-contained account of what happened, including the people and concrete context available in the recent conversation. Do not include words such as 请记住 or 宝宝记一下." },
            meaning: { type: "string", description: "Why this event matters emotionally, relationally, creatively, or practically. Preserve the user's meaning instead of inventing facts." },
            continuity: { type: "string", description: "What a future instance should understand or carry forward when this memory is recalled." },
            tags: { type: "array", items: { type: "string" }, maxItems: 10, description: "Concise semantic tags." },
            importance: { type: "integer", minimum: 1, maximum: 10, description: "Durable importance from 1 to 10." },
          },
          required: ["title", "event", "meaning", "continuity", "tags", "importance"],
          additionalProperties: false,
        },
      },
    },
  ];
  chatRequest.toolChoice = explicitSaveAllowed
    ? { type: "function", function: { name: "ocean_memory_hold" } }
    : "auto";
  chatRequest.executeTool = async (name, argumentsValue) => {
    try {
      if (name === "ocean_memory_breath") {
        const query = String(argumentsValue.query ?? "").trim();
        if (!query) return { ok: false, content: { error: "query is required" } };
        const maxResults = Math.max(1, Math.min(8, Number(argumentsValue.max_results) || 4));
        const result = await memory.breath({ query, max_results: maxResults, include_related: true });
        console.info(JSON.stringify({ event: "ocean_chat_tool", at: new Date().toISOString(), tool: name, ok: true }));
        return { ok: true, content: result };
      }
      if (name === "ocean_memory_hold") {
        if (!explicitSaveAllowed) return { ok: false, content: { error: "The current user message did not explicitly authorize a durable memory write." } };
        const prepared = structuredMemory(argumentsValue);
        if (!prepared) return { ok: false, content: { error: "A complete title, event, meaning, continuity, tags, and importance are required before Memory can save." } };
        const source = `chat-tool:${chatRequest.context?.physicalSessionId ?? "unknown"}`;
        const result = await memory.hold(prepared.content, source, {
          tags: prepared.tags,
          importance: prepared.importance,
          title: prepared.title,
          verificationText: `${prepared.title}\n${prepared.event}`,
        });
        console.info(JSON.stringify({ event: "ocean_chat_tool", at: new Date().toISOString(), tool: name, ok: result.verified, bucketId: result.bucketId ?? null, title: result.bucket?.title ?? prepared.title, verification: result.verification }));
        if (!result.verified) {
          return {
            ok: false,
            content: {
              saved: false,
              error: "Memory returned a bucket reference, but the stored content did not verify against this request. Do not tell the user it was saved.",
              bucketId: result.bucketId ?? null,
              verification: result.verification,
            },
          };
        }
        return {
          ok: true,
          content: {
            saved: true,
            bucketId: result.bucketId ?? null,
            title: result.bucket?.title ?? prepared.title,
            domain: result.bucket?.domain ?? null,
            verification: result.verification,
          },
        };
      }
      return { ok: false, content: { error: `Unknown Ocean tool: ${name}` } };
    } catch (error) {
      console.warn(JSON.stringify({ event: "ocean_chat_tool", at: new Date().toISOString(), tool: name, ok: false, error: error instanceof Error ? error.message : "unknown" }));
      return { ok: false, content: { error: error instanceof Error ? error.message : "Tool execution failed" } };
    }
  };
}

function integrationManifest(providers: ProviderRegistry, integrations: { memory: boolean; fishing: boolean; notifications: boolean; music: boolean; notion: boolean }) {
  const configuredProviders = providers.listPublic().filter((provider) => provider.configured && provider.kind !== "mock");
  const meetingModels = providers.listModels().filter((model) => {
    if (model.providerId === "mock") return false;
    const identity = `${model.name} ${model.upstreamModelId ?? model.id}`.toLowerCase();
    return identity.includes("kimi-k3") || identity.includes("kimi k3") || identity.includes("gpt-5.6") || identity.includes("gpt 5.6") || identity.includes("sonnet-4.6") || identity.includes("sonnet 4.6") || identity.includes("opus-4.6") || identity.includes("opus 4.6");
  });
  const internalFreeTimeModel = process.env.FREE_TIME_PROVIDER_ID?.trim();
  const freeTimeDispatchConfigured = Boolean(process.env.FREE_TIME_DISPATCH_URL || internalFreeTimeModel);
  return {
    generatedAt: new Date().toISOString(),
    services: [
      { id: "gateway", state: "real", source: "ocean-gateway", detail: "Server boundary and health checks are active." },
      { id: "chat", state: configuredProviders.length ? "real" : "mock", source: configuredProviders.length ? configuredProviders.map((provider) => provider.id).join(",") : "mock", detail: configuredProviders.length ? "At least one real provider is configured." : "No real provider credential is configured." },
      { id: "conversations", state: "staging", source: "gateway-json-store", detail: "Conversation scopes persist on the Gateway; production database migration is pending." },
      { id: "projects", state: "real", source: "gateway-project-directories", detail: "Projects, documents, files and confirmed meeting minutes share one durable server workspace." },
      { id: "notion", state: integrations.notion ? "real" : "unconfigured", source: "notion-project-mirror", detail: integrations.notion ? "Ocean projects can be mirrored to a private Notion parent page without making Notion the primary data source." : "Set NOTION_ACCESS_TOKEN and OCEAN_NOTION_PARENT_PAGE_ID to enable the optional project mirror." },
      { id: "continuity", state: "real", source: process.env.OCEAN_FORGE_SUMMARY_PROVIDER ? "provider-assisted-gateway-forge" : "deterministic-gateway-forge", detail: process.env.OCEAN_FORGE_SUMMARY_PROVIDER ? "Persistent physical-session rotation is active with an optional model-authored summary." : "Persistent physical-session rotation is active with a no-cost deterministic summary." },
      { id: "memory", state: integrations.memory ? "real" : "staging", source: integrations.memory ? "ombre-brain-mcp" : "gateway-candidate-store", detail: integrations.memory ? "Memory reads are live; explicit save requests commit through hold." : "Candidates are durable on the Gateway but are not yet committed to Memory 3.0." },
      { id: "home", state: integrations.memory && configuredProviders.length ? "real" : "staging", source: "gateway-json-store+memory-paper-notes", detail: integrations.memory && configuredProviders.length ? "User-authored home data syncs; daily impressions and four-window paper notes are connected." : "User-authored home data syncs; automated paper notes wait for both Memory and a real model provider." },
      { id: "reading", state: process.env.CO_READING_BASE_URL ? "real" : "unconfigured", source: "co-reading-proxy", detail: process.env.CO_READING_BASE_URL ? "The Gateway proxy is configured." : "Set CO_READING_BASE_URL to enable the real service." },
      { id: "fishing-game", state: integrations.fishing ? "real" : "unconfigured", source: "tutusagi-ai-fishing-game", detail: integrations.fishing ? "The external personal-use game engine is available through the Gateway." : "Set FISHING_GAME_SCRIPT_PATH to enable the optional fishing game." },
      { id: "free-time-config", state: "real", source: "gateway-scheduler", detail: "Rules, prompt preview, eligibility, persistence, and run history are active." },
      { id: "free-time-dispatch", state: freeTimeDispatchConfigured ? "real" : "unconfigured", source: internalFreeTimeModel ? `internal:${internalFreeTimeModel}` : "dispatch-webhook", detail: internalFreeTimeModel ? `Manual model dispatch is ready; automatic dispatch is ${process.env.FREE_TIME_AUTO_DISPATCH === "enabled" ? "enabled" : "disabled"}.` : process.env.FREE_TIME_DISPATCH_URL ? "Eligible runs can be dispatched to the configured webhook." : "Runs remain queued until a dispatch target is configured." },
      { id: "notifications", state: integrations.notifications ? "real" : "unconfigured", source: "web-push", detail: integrations.notifications ? "Permission, subscription persistence, test delivery, and free-time delivery are active." : "Set Web Push VAPID keys to enable phone notifications." },
      { id: "music", state: integrations.music ? "real" : "unconfigured", source: "netease-cloud-music", detail: integrations.music ? "A server-side QR session is connected; playlists, tracks, and short-lived playback URLs are available." : "Scan a NetEase Cloud Music QR code in Ocean settings to connect a server-only session." },
      { id: "meetings", state: meetingModels.length >= 2 ? "real" : "unconfigured", source: "gateway-chat-client-orchestrator", detail: meetingModels.length >= 2 ? `Round orchestration is ready with ${meetingModels.map((model) => model.name).join(", ")}.` : "Connect at least two of Kimi K3, GPT 5.6, Sonnet 4.6 and Opus 4.6 to enable real meetings." },
    ],
  };
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {};
}

async function streamChat(request: IncomingMessage, response: ServerResponse, providers: ProviderRegistry, memory: MemoryAdapter | null, fishing: FishingGameConnector | null) {
  const input = await body(request);
  const rawContext = input.context && typeof input.context === "object" ? input.context as Record<string, unknown> : {};
  const chatRequest: ProviderChatRequest = {
    input: String(input.input ?? ""),
    providerId: typeof input.providerId === "string" ? input.providerId : undefined,
    modelId: typeof input.modelId === "string" ? input.modelId : undefined,
    settings: input.settings && typeof input.settings === "object" ? input.settings as Record<string, string> : undefined,
    messages: Array.isArray(input.messages ?? rawContext.messages) ? (input.messages ?? rawContext.messages) as ProviderChatRequest["messages"] : undefined,
    attachments: Array.isArray(input.attachments) ? input.attachments.flatMap<OceanChatAttachment>((attachment) => {
      if (!attachment || typeof attachment !== "object") return [];
      const value = attachment as Record<string, unknown>;
      const kind = value.kind;
      const data = typeof value.data === "string" ? value.data : "";
      const size = Number(value.size ?? 0);
      if (!(["image", "text", "connector"] as unknown[]).includes(kind) || !data || data.length > 12_000_000 || size > 8_000_000) return [];
      return [{
        kind: kind as OceanChatAttachment["kind"],
        data,
        size,
        name: String(value.name ?? "附件").slice(0, 180),
        mimeType: String(value.mimeType ?? "application/octet-stream").slice(0, 120),
      }];
    }) : undefined,
    context: {
      mode: typeof rawContext.mode === "string" ? rawContext.mode : undefined,
      nightTalk: rawContext.nightTalk === true,
      elapsedSinceLastTurn: typeof rawContext.elapsedSinceLastTurn === "string" ? rawContext.elapsedSinceLastTurn.slice(0, 80) : undefined,
      continuitySummary: typeof rawContext.continuitySummary === "string" ? rawContext.continuitySummary : undefined,
      continuityHandoff: typeof rawContext.continuityHandoff === "string" ? rawContext.continuityHandoff : undefined,
      physicalSessionId: typeof rawContext.physicalSessionId === "string" ? rawContext.physicalSessionId : undefined,
      modeInstruction: typeof rawContext.modeInstruction === "string" ? rawContext.modeInstruction : undefined,
    },
  };
  if (!chatRequest.input.trim()) return sendJson(response, 400, { error: "invalid_chat_input", message: "input is required" });
  const configuredMemoryResults = Math.max(1, Math.min(12, Number(process.env.OCEAN_CHAT_MEMORY_RESULTS) || 4));
  const configuredMemoryCharacters = Math.max(500, Math.min(12_000, Number(process.env.OCEAN_CHAT_MEMORY_CHARACTERS) || 3200));
  const hasConversationHistory = Boolean(chatRequest.messages?.some((message) => message.role === "assistant"));
  const memoryPlan = planChatMemoryRecall(
    chatRequest.input.trim(),
    hasConversationHistory,
    configuredMemoryResults,
    configuredMemoryCharacters,
  );
  chatRequest.context = {
    ...chatRequest.context,
    memoryRecall: {
      status: !memory || process.env.OCEAN_CHAT_MEMORY_RECALL === "disabled" ? "disabled" : "miss",
      count: 0,
      directCount: 0,
      relatedCount: 0,
    },
  };
  if (memory && process.env.OCEAN_CHAT_MEMORY_RECALL !== "disabled") {
    if (memoryPlan.mode === "skip") {
      chatRequest.context = { ...chatRequest.context, memoryRecall: { status: "skipped", count: 0, directCount: 0, relatedCount: 0 } };
    } else try {
      const recalled = await memory.contextForChat(chatRequest.input.trim(), memoryPlan.maxResults, memoryPlan.maxCharacters);
      chatRequest.context = {
        ...chatRequest.context,
        ...(recalled.text ? { memoryContext: recalled.text } : {}),
        memoryRecall: {
          status: recalled.count > 0 ? "hit" : "miss",
          count: recalled.count,
          directCount: recalled.directCount,
          relatedCount: recalled.relatedCount,
        },
      };
    } catch {
      chatRequest.context = { ...chatRequest.context, memoryRecall: { status: "unavailable", count: 0, directCount: 0, relatedCount: 0 } };
      // Memory recall is assistive. Chat must remain available when the independent
      // Memory service is temporarily slow or unavailable.
    }
  }
  if (memory) memoryTools(memory, chatRequest);
  if (fishing) fishingTools(fishing, chatRequest);
  const { provider, modelId } = providers.resolve(chatRequest);
  const trace = {
    event: "ocean_chat_start",
    at: new Date().toISOString(),
    providerId: provider.id,
    modelId,
    mode: chatRequest.context?.mode,
    physicalSessionId: chatRequest.context?.physicalSessionId,
    memoryRecall: chatRequest.context?.memoryRecall,
    memoryPolicy: memoryPlan,
    attachmentCount: chatRequest.attachments?.length ?? 0,
    imageAttachmentCount: chatRequest.attachments?.filter((attachment) => attachment.kind === "image").length ?? 0,
    attachmentBytes: chatRequest.attachments?.reduce((sum, attachment) => sum + attachment.size, 0) ?? 0,
    attachmentMimeTypes: [...new Set(chatRequest.attachments?.map((attachment) => attachment.mimeType) ?? [])],
  };
  console.info(JSON.stringify(trace));
  response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" });
  const write = (event: unknown) => response.write(`${JSON.stringify(event)}\n`);
  try {
    for await (const event of providers.adapter(provider).stream(chatRequest, modelId)) {
      if (event.type === "usage") {
        const usageEvent = { ...event, memoryRecall: chatRequest.context?.memoryRecall };
        console.info(JSON.stringify({
          event: "ocean_chat_usage",
          at: new Date().toISOString(),
          physicalSessionId: chatRequest.context?.physicalSessionId,
          ...usageEvent,
          cachePercent: usageEvent.inputTokens > 0 ? Math.round((usageEvent.cachedTokens / usageEvent.inputTokens) * 100) : 0,
        }));
        write(usageEvent);
      } else {
        write(event);
      }
    }
  } catch (error) {
    const normalized = normalizeProviderError(error);
    write({ type: "error", message: normalized.message, code: normalized.code, retryable: normalized.retryable, providerId: provider.id, modelId });
    write({ type: "done" });
  }
  response.end();
}

async function runFreeTime(store: JsonStore, providers: ProviderRegistry, fishing: FishingGameConnector | null, notifications: OceanNotificationService, input: {
  manual?: boolean;
  recordSkip?: boolean;
  now?: Date;
} = {}): Promise<StoredFreeTimeRun | null> {
  const config = normalizeFreeTimeConfig(store.getFreeTime() ?? DEFAULT_FREE_TIME_CONFIG);
  const lastActivity = store.getFreeTimeLastUserActivityAt();
  if (!input.manual && !lastActivity) return null;
  const lastRun = store.listFreeTimeRuns().find((run) => run.status === "queued" || run.status === "dispatched" || run.status === "completed");
  const eligibility = evaluateFreeTimeEligibility(config, {
    now: input.now,
    manual: input.manual,
    timeZone: process.env.OCEAN_TIME_ZONE?.trim() || "Asia/Shanghai",
    lastUserActivityAt: lastActivity ? new Date(lastActivity) : undefined,
    lastRunAt: lastRun ? new Date(lastRun.createdAt) : undefined,
  });
  if (!eligibility.eligible) {
    if (!input.recordSkip) return null;
    return store.saveFreeTimeRun({ status: "skipped", reason: eligibility.reason, prompt: "", connectorRefs: [], enabledActions: 0, availableGames: 0 });
  }

  const preview = buildFreeTimePrompt(config, input.now);
  const internalModelConfigured = Boolean(process.env.FREE_TIME_PROVIDER_ID?.trim());
  const automaticModelEnabled = process.env.FREE_TIME_AUTO_DISPATCH === "enabled";
  if (internalModelConfigured && (input.manual || automaticModelEnabled)) {
    try {
      const outcome = await dispatchFreeTimeWithModel({ config, preview, providers, fishing });
      console.info(JSON.stringify({ event: "ocean_free_time_usage", at: new Date().toISOString(), manual: Boolean(input.manual), action: outcome.action, usage: outcome.usage }));
      const saved = await store.saveFreeTimeRun({ ...preview, status: "completed", reason: input.manual ? "manual_model_dispatch" : "automatic_model_dispatch", completedAt: new Date().toISOString(), ...outcome });
      await notifications.notifyFreeTime(saved);
      return saved;
    } catch (error) {
      return store.saveFreeTimeRun({ ...preview, status: "skipped", reason: `model_dispatch_failed:${error instanceof Error ? error.message.slice(0, 180) : "unknown"}` });
    }
  }
  const dispatchUrl = process.env.FREE_TIME_DISPATCH_URL;
  if (!dispatchUrl) return store.saveFreeTimeRun({ ...preview, status: "queued", reason: internalModelConfigured ? "automatic_dispatch_disabled" : "model_dispatch_unconfigured" });
  const dispatched = await fetch(dispatchUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...preview, source: "ocean-free-time" }),
  });
  if (!dispatched.ok) throw new Error(`Free-time dispatch failed with ${dispatched.status}`);
  return store.saveFreeTimeRun({ ...preview, status: "dispatched" });
}

function coReadingPath(url: URL) {
  const path = url.pathname;
  if (path === "/v1/reading/books") return "/api/books";
  if (path === "/v1/reading/continue") return `/api/continue${url.search}`;
  if (/^\/v1\/reading\/books\/[^/]+\/chunks$/.test(path)) return path.replace("/v1/reading", "/api");
  if (/^\/v1\/reading\/books\/[^/]+\/chunks\/[^/]+$/.test(path)) return path.replace("/v1/reading", "/api");
  if (path === "/v1/reading/annotations") return `/api/annotations${url.search}`;
  if (path === "/v1/reading/mark-read") return "/api/mark-read";
  if (path === "/v1/reading/submit-notes") return "/api/submit-notes";
  if (path === "/v1/reading/import") return "/api/import";
  return null;
}

async function proxyCoReading(request: IncomingMessage, response: ServerResponse, url: URL) {
  const { baseUrl, authToken } = coReadingConfig();
  if (url.pathname === "/v1/reading/health") {
    const upstream = await fetch(`${baseUrl}/api/books`, {
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
    });
    if (!upstream.ok) throw new Error(`Co-Reading health failed with ${upstream.status}`);
    const books = await upstream.json() as unknown[];
    return sendJson(response, 200, { status: "ok", provider: "co-reading-mcp", books: books.length, baseUrl });
  }

  const targetPath = coReadingPath(url);
  if (!targetPath) return sendJson(response, 404, { error: "reading_route_not_found", path: url.pathname });
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const payload = hasBody ? await body(request) : undefined;
  const upstream = await fetch(`${baseUrl}${targetPath}`, {
    method: request.method,
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await upstream.text();
  response.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  response.end(text);
}

export async function createOceanGateway(dataPath?: string) {
  const store = new JsonStore(dataPath);
  const projectWorkspaces = new ProjectWorkspaceStore(dataPath);
  const notion = new NotionSyncService(dataPath);
  const providers = new ProviderRegistry();
  const memory = createMemoryAdapterFromEnv();
  const fishing = createFishingGameConnectorFromEnv();
  const access = new OceanAccessController();
  await store.initialize();
  await notion.initialize();
  const notifications = new OceanNotificationService(store);
  const music = new NeteaseMusicService();
  await music.initialize();
  const continuity = new ContinuityService(store, providers);
  const syncProjectToNotion = async (projectId: string) => {
    const project = store.getProject(projectId);
    if (!project) throw new Error("project_not_found");
    return notion.syncProject(project, await projectWorkspaces.get(projectId));
  };
  const autoSyncProjectToNotion = (projectId: string) => {
    if (!notion.configured || !notion.autoSync) return;
    void syncProjectToNotion(projectId).catch((error) => console.warn("Ocean Notion auto-sync failed", projectId, error instanceof Error ? error.message : error));
  };
  const server = createServer(async (request, response) => {
    if (request.method === "OPTIONS") { response.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS" }); return response.end(); }
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/v1/auth/status") {
        return sendJson(response, 200, { required: access.required, authenticated: access.isAuthenticated(request) });
      }
      if (request.method === "POST" && url.pathname === "/v1/auth/login") {
        const input = await body(request);
        const result = access.login(request, typeof input.password === "string" ? input.password : "");
        if (!result.ok) return sendJson(response, result.status, { error: result.status === 429 ? "too_many_attempts" : "invalid_password", retryAfterSeconds: result.retryAfterSeconds });
        return sendJson(response, 200, { authenticated: true, expiresAt: result.expiresAt }, result.cookie ? { "Set-Cookie": result.cookie } : {});
      }
      if (request.method === "POST" && url.pathname === "/v1/auth/logout") {
        return sendJson(response, 200, { authenticated: false }, { "Set-Cookie": access.logoutCookie(request) });
      }
      if (url.pathname.startsWith("/v1/") && !access.isAuthenticated(request)) {
        return sendJson(response, 401, { error: "authentication_required" });
      }
      if (request.method === "GET" && url.pathname === "/health") return sendJson(response, 200, { status: "ok", version: "0.2.0", providers: providers.listPublic().filter((provider) => provider.configured).map((provider) => provider.id) });
      if (request.method === "GET" && url.pathname === "/v1/capabilities") {
        const musicStatus = await music.status();
        const configuredMeetingModels = providers.listModels().filter((model) => model.providerId !== "mock" && /(kimi[- ]k3|gpt[- ]5\.6|sonnet[- ]4\.6|opus[- ]4\.6)/i.test(`${model.name} ${model.upstreamModelId ?? model.id}`));
        const paperNotesConfigured = providers.listPublic().some((provider) => provider.configured && provider.kind !== "mock");
        return sendJson(response, 200, { chat: { stream: true, reasoningSummary: true, usage: true, promptCache: true, providers: true, dynamicModels: true, memoryRecall: Boolean(memory) && process.env.OCEAN_CHAT_MEMORY_RECALL !== "disabled" }, conversations: { persistent: true, restoreOnEmpty: true, multiDeviceMerge: false }, continuity: { snapshot: true, providerSummary: Boolean(process.env.OCEAN_FORGE_SUMMARY_PROVIDER), physicalSessionRotation: true, persistent: true, storageStatus: true, restoreOnEmpty: true }, memory: { candidateStaging: true, eventCandidates: true, eventCandidateTypes: ["session-forge", "project-completed", "reading-completed", "meeting-completed"], adapterConnected: Boolean(memory), buckets: Boolean(memory), search: Boolean(memory), chatRecall: Boolean(memory) && process.env.OCEAN_CHAT_MEMORY_RECALL !== "disabled", scheduledReview: false, evidenceChain: Boolean(memory), portrait: Boolean(memory), dailyImpression: Boolean(memory), paperNotes: Boolean(memory) && paperNotesConfigured, explicitHold: Boolean(memory) }, projects: { persistent: true, documents: true, files: true, meetingMinutes: true, contextInjection: true, notionMirror: notion.configured, notionAutoSync: notion.autoSync }, reading: { adapter: "co-reading-mcp", contextMode: "chunk-once-per-session", configured: Boolean(process.env.CO_READING_BASE_URL) }, meetings: { orchestrator: "client-sequential", configured: configuredMeetingModels.length >= 2, models: configuredMeetingModels.map((model) => ({ id: model.id, name: model.name })) }, connectors: { fishing: { configured: Boolean(fishing), persistentSave: Boolean(fishing) } }, scheduler: { persistent: true, adapter: "gateway-config", modelDispatch: Boolean(process.env.FREE_TIME_DISPATCH_URL || process.env.FREE_TIME_PROVIDER_ID), automaticDispatch: process.env.FREE_TIME_AUTO_DISPATCH === "enabled", providerId: process.env.FREE_TIME_PROVIDER_ID?.trim() || null, modelId: process.env.FREE_TIME_MODEL_ID?.trim() || null }, notifications: { webPush: notifications.configured, subscriptions: store.listPushSubscriptions().length, freeTime: true, paperNotes: true, quietHours: true }, music: { provider: "netease-cloud-music", connected: musicStatus.connected, qrLogin: true, playlists: true, playbackUrl: true } });
      }
      if (request.method === "GET" && url.pathname === "/v1/integrations") {
        const musicStatus = await music.status();
        return sendJson(response, 200, integrationManifest(providers, { memory: Boolean(memory), fishing: Boolean(fishing), notifications: notifications.configured, music: musicStatus.connected, notion: notion.configured }));
      }
      if (request.method === "GET" && url.pathname === "/v1/notion/status") return sendJson(response, 200, await notion.status(true));
      if (request.method === "POST" && url.pathname === "/v1/notion/test") {
        const status = await notion.status(true);
        return sendJson(response, status.connected ? 200 : 503, status);
      }
      const notionProjectStatus = url.pathname.match(/^\/v1\/notion\/projects\/([^/]+)$/);
      if (request.method === "GET" && notionProjectStatus) {
        const projectId = decodeURIComponent(notionProjectStatus[1]);
        if (!store.getProject(projectId)) return sendJson(response, 404, { error: "project_not_found" });
        return sendJson(response, 200, notion.projectStatus(projectId));
      }
      const notionProjectSync = url.pathname.match(/^\/v1\/notion\/projects\/([^/]+)\/sync$/);
      if (request.method === "POST" && notionProjectSync) {
        const projectId = decodeURIComponent(notionProjectSync[1]);
        if (!notion.configured) return sendJson(response, 503, { error: "notion_unconfigured" });
        try { return sendJson(response, 200, await syncProjectToNotion(projectId)); }
        catch (error) {
          const message = error instanceof Error ? error.message : "notion_sync_failed";
          return sendJson(response, message === "project_not_found" ? 404 : 502, { error: message });
        }
      }
      if (request.method === "GET" && url.pathname === "/v1/notifications/public-key") {
        return notifications.configured ? sendJson(response, 200, { publicKey: notifications.publicKey }) : sendJson(response, 503, { error: "web_push_unconfigured" });
      }
      if (request.method === "POST" && url.pathname === "/v1/notifications/subscribe") {
        const input = await body(request);
        const subscription = input.subscription && typeof input.subscription === "object" ? input.subscription as PushSubscription : undefined;
        if (!subscription) return sendJson(response, 400, { error: "push_subscription_required" });
        try {
          const saved = await notifications.subscribe(subscription, normalizeNotificationPreferences(input.preferences), request.headers["user-agent"]);
          return sendJson(response, 201, { subscribed: true, preferences: saved.preferences });
        } catch (error) {
          return sendJson(response, error instanceof Error && error.message === "web_push_unconfigured" ? 503 : 400, { error: error instanceof Error ? error.message : "push_subscription_invalid" });
        }
      }
      if (request.method === "DELETE" && url.pathname === "/v1/notifications/subscribe") {
        const input = await body(request);
        const endpoint = typeof input.endpoint === "string" ? input.endpoint : "";
        return endpoint ? sendJson(response, 200, await notifications.unsubscribe(endpoint)) : sendJson(response, 400, { error: "push_endpoint_required" });
      }
      if (request.method === "POST" && url.pathname === "/v1/notifications/test") {
        const result = await notifications.send({ title: "Ocean 通知已连接", body: "以后陪伴者在自由时间回来时，Ocean 可以在这里告诉你。", tag: "ocean-test", url: "?room=living", room: "living" }, { kind: "test", force: true });
        return result.sent ? sendJson(response, 200, result) : sendJson(response, 503, { error: "push_delivery_unavailable", ...result });
      }
      if (request.method === "GET" && url.pathname === "/v1/connectors") return sendJson(response, 200, [
        { id: "fishing", configured: Boolean(fishing), provider: "tutusagi-ai-fishing-game", automaticPolicy: "game-state", healthPath: "/v1/games/fishing/health" },
      ]);
      if (request.method === "GET" && url.pathname === "/v1/games/fishing/health") {
        if (!fishing) return sendJson(response, 503, { status: "unconfigured", provider: "tutusagi-ai-fishing-game" });
        return sendJson(response, 200, await fishing.health());
      }
      if (request.method === "POST" && url.pathname === "/v1/games/fishing/play") {
        if (!fishing) return sendJson(response, 503, { error: "fishing_unconfigured" });
        const input = await body(request);
        return sendJson(response, 200, { result: await fishing.play(String(input.command ?? "")) });
      }
      if (request.method === "GET" && url.pathname === "/v1/music/status") return sendJson(response, 200, await music.status(url.searchParams.get("refresh") === "true"));
      if (request.method === "POST" && url.pathname === "/v1/music/login/qr") return sendJson(response, 201, await music.createQr());
      const musicQr = url.pathname.match(/^\/v1\/music\/login\/qr\/([^/]+)$/);
      if (request.method === "GET" && musicQr) return sendJson(response, 200, await music.checkQr(decodeURIComponent(musicQr[1])));
      if (request.method === "DELETE" && url.pathname === "/v1/music/session") return sendJson(response, 200, await music.logout());
      if (request.method === "GET" && url.pathname === "/v1/music/playlists") return sendJson(response, 200, await music.playlists());
      const musicPlaylistTracks = url.pathname.match(/^\/v1\/music\/playlists\/([^/]+)\/tracks$/);
      if (request.method === "GET" && musicPlaylistTracks) return sendJson(response, 200, await music.tracks(decodeURIComponent(musicPlaylistTracks[1])));
      const musicPlayback = url.pathname.match(/^\/v1\/music\/tracks\/([^/]+)\/playback$/);
      if (request.method === "GET" && musicPlayback) return sendJson(response, 200, await music.playback(decodeURIComponent(musicPlayback[1]), url.searchParams.get("level") ?? "standard"));
      if (request.method === "GET" && url.pathname === "/v1/providers") return sendJson(response, 200, providers.listPublic());
      if (request.method === "GET" && url.pathname === "/v1/providers/openrouter/balance") {
        try {
          return sendJson(response, 200, await providers.openRouterBalance());
        } catch (error) {
          return sendJson(response, 503, { error: "openrouter_balance_unavailable", message: error instanceof Error ? error.message : "OpenRouter balance is unavailable" });
        }
      }
      if (request.method === "GET" && url.pathname === "/v1/models") return sendJson(response, 200, providers.listModels(url.searchParams.get("all") === "true"));
      const providerTest = url.pathname.match(/^\/v1\/providers\/([^/]+)\/test$/);
      if (request.method === "POST" && providerTest) {
        const providerId = decodeURIComponent(providerTest[1]);
        const provider = providers.get(providerId);
        if (!provider) return sendJson(response, 404, { error: "provider_not_found", providerId });
        if (provider.kind !== "mock" && !provider.apiKey) return sendJson(response, 409, { error: "provider_not_configured", providerId, message: `Set ${provider.apiKeyEnv} on Ocean Gateway` });
        return sendJson(response, 200, await providers.test(providerId));
      }
      if (request.method === "POST" && url.pathname === "/v1/chat/stream") {
        await store.markFreeTimeUserActivity();
        await streamChat(request, response, providers, memory, fishing);
        await store.markCompanionActivity();
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/projects") return sendJson(response, 200, store.listProjects());
      if (request.method === "POST" && url.pathname === "/v1/projects") {
        try {
          const input = await body(request);
          const saved = await store.createProject({
            id: typeof input.id === "string" ? input.id : undefined,
            name: String(input.name ?? ""),
            description: typeof input.description === "string" ? input.description : undefined,
          });
          autoSyncProjectToNotion(saved.id);
          return sendJson(response, 201, saved);
        } catch (error) {
          return sendJson(response, 400, { error: error instanceof Error ? error.message : "project_invalid" });
        }
      }
      const projectWorkspaceMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)\/workspace$/);
      if (projectWorkspaceMatch) {
        const projectId = decodeURIComponent(projectWorkspaceMatch[1]);
        if (!store.getProject(projectId)) return sendJson(response, 404, { error: "project_not_found" });
        if (request.method === "GET") return sendJson(response, 200, await projectWorkspaces.get(projectId));
        if (request.method === "PUT") {
          const input = await body(request);
          const saved = await projectWorkspaces.updateBrief(projectId, String(input.brief ?? ""));
          autoSyncProjectToNotion(projectId);
          return sendJson(response, 200, saved);
        }
      }
      const projectDocumentsMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)\/documents$/);
      if (projectDocumentsMatch && request.method === "POST") {
        const projectId = decodeURIComponent(projectDocumentsMatch[1]);
        if (!store.getProject(projectId)) return sendJson(response, 404, { error: "project_not_found" });
        try {
          const input = await body(request);
          const saved = await projectWorkspaces.addDocument(projectId, {
            id: typeof input.id === "string" ? input.id : undefined,
            title: String(input.title ?? ""),
            content: typeof input.content === "string" ? input.content : undefined,
            kind: typeof input.kind === "string" ? input.kind : undefined,
          });
          autoSyncProjectToNotion(projectId);
          return sendJson(response, 201, saved);
        } catch (error) {
          return sendJson(response, 400, { error: error instanceof Error ? error.message : "project_document_invalid" });
        }
      }
      const projectDocumentMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)\/documents\/([^/]+)$/);
      if (projectDocumentMatch) {
        const projectId = decodeURIComponent(projectDocumentMatch[1]);
        const documentId = decodeURIComponent(projectDocumentMatch[2]);
        if (!store.getProject(projectId)) return sendJson(response, 404, { error: "project_not_found" });
        if (request.method === "PATCH") {
          try {
            const input = await body(request);
            const saved = await projectWorkspaces.updateDocument(projectId, documentId, {
              title: typeof input.title === "string" ? input.title : undefined,
              content: typeof input.content === "string" ? input.content : undefined,
              kind: typeof input.kind === "string" ? input.kind : undefined,
            });
            if (saved) autoSyncProjectToNotion(projectId);
            return saved ? sendJson(response, 200, saved) : sendJson(response, 404, { error: "project_document_not_found" });
          } catch (error) {
            return sendJson(response, 400, { error: error instanceof Error ? error.message : "project_document_invalid" });
          }
        }
        if (request.method === "DELETE") {
          const result = await projectWorkspaces.deleteDocument(projectId, documentId);
          autoSyncProjectToNotion(projectId);
          return sendJson(response, 200, result);
        }
      }
      const projectFilesMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)\/files$/);
      if (projectFilesMatch && request.method === "POST") {
        const projectId = decodeURIComponent(projectFilesMatch[1]);
        if (!store.getProject(projectId)) return sendJson(response, 404, { error: "project_not_found" });
        try {
          const input = await body(request);
          const saved = await projectWorkspaces.addFile(projectId, {
            name: String(input.name ?? ""),
            mimeType: typeof input.mimeType === "string" ? input.mimeType : undefined,
            size: typeof input.size === "number" ? input.size : undefined,
            data: String(input.data ?? ""),
          });
          autoSyncProjectToNotion(projectId);
          return sendJson(response, 201, saved);
        } catch (error) {
          return sendJson(response, 400, { error: error instanceof Error ? error.message : "project_file_invalid" });
        }
      }
      const projectMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)$/);
      if (request.method === "PATCH" && projectMatch) {
        try {
          const input = await body(request);
          const status = input.status === "todo" || input.status === "done" ? input.status : undefined;
          const saved = await store.updateProject(decodeURIComponent(projectMatch[1]), {
            name: typeof input.name === "string" ? input.name : undefined,
            description: typeof input.description === "string" ? input.description : undefined,
            status,
          });
          if (saved) autoSyncProjectToNotion(saved.id);
          return saved ? sendJson(response, 200, saved) : sendJson(response, 404, { error: "project_not_found" });
        } catch (error) {
          const code = error instanceof Error ? error.message : "project_invalid";
          return sendJson(response, code === "project_name_conflict" ? 409 : 400, { error: code });
        }
      }
      if (request.method === "DELETE" && projectMatch) {
        const projectId = decodeURIComponent(projectMatch[1]);
        const result = await store.deleteProject(projectId);
        if (result.removed) await projectWorkspaces.remove(projectId);
        return sendJson(response, 200, result);
      }
      if (request.method === "GET" && url.pathname === "/v1/conversations") return sendJson(response, 200, store.listConversations(url.searchParams.get("scope") ?? undefined));
      if (request.method === "POST" && url.pathname === "/v1/conversations") { const input = await body(request); const saved = await store.saveConversation({ id: typeof input.id === "string" ? input.id : undefined, scope: String(input.scope ?? "living-main"), messages: Array.isArray(input.messages) ? input.messages : [] }); return sendJson(response, 200, saved); }
      if (request.method === "GET" && url.pathname === "/v1/continuities") return sendJson(response, 200, store.listContinuities());
      if (request.method === "POST" && url.pathname === "/v1/continuity/forge") {
        const result = await continuity.evaluate(await body(request));
        if (result.forged) await recordMemoryEvent(store, { eventId: `${result.logicalConversationId}:${result.generation}`, type: "session-forge", title: result.logicalConversationId, summary: result.summary, scope: result.logicalConversationId, occurredAt: result.forgedAt, metadata: { generation: result.generation, physicalSessionId: result.physicalSessionId } });
        return sendJson(response, 200, result);
      }
      if (request.method === "GET" && url.pathname === "/v1/memory/candidates") return sendJson(response, 200, store.listCandidates());
      if (request.method === "POST" && url.pathname === "/v1/memory/events") {
        try { return sendJson(response, 201, await recordMemoryEvent(store, await body(request))); }
        catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : "memory_event_invalid" }); }
      }
      if (request.method === "POST" && url.pathname === "/v1/memory/candidates") {
        const input = await body(request);
        const saved = await store.addCandidate({ id: typeof input.id === "string" ? input.id : undefined, content: String(input.content ?? ""), source: String(input.source ?? "unknown") });
        const writeMode = process.env.OCEAN_MEMORY_WRITE_MODE ?? "staging";
        const shouldCommit = Boolean(memory) && (writeMode === "direct" || (writeMode === "explicit" && saved.source.includes("explicit")));
        if (!shouldCommit || saved.status === "saved") return sendJson(response, 201, saved);
        try {
          const committed = await memory!.hold(saved.content, saved.source);
          if (!committed.verified || !committed.bucketId) throw new Error(`Memory commit could not be verified (${committed.verification})`);
          return sendJson(response, 201, await store.updateCandidate(saved.id, { status: "saved", externalId: committed.bucketId, error: undefined }));
        } catch (error) {
          const failed = await store.updateCandidate(saved.id, { error: error instanceof Error ? error.message : "Memory commit failed" });
          return sendJson(response, 202, failed);
        }
      }
      const memoryCandidate = url.pathname.match(/^\/v1\/memory\/candidates\/([^/]+)$/);
      if (request.method === "PATCH" && memoryCandidate) {
        const id = decodeURIComponent(memoryCandidate[1]);
        const candidate = store.getCandidate(id);
        if (!candidate) return sendJson(response, 404, { error: "memory_candidate_not_found" });
        const input = await body(request);
        if (input.action === "dismiss") return sendJson(response, 200, await store.updateCandidate(id, { status: "dismissed", error: undefined }));
        if (input.action !== "accept") return sendJson(response, 400, { error: "memory_candidate_action_invalid" });
        if (candidate.status === "saved") return sendJson(response, 200, candidate);
        if (!memory) return sendJson(response, 503, { error: "memory_unconfigured", candidate });
        try {
          const committed = await memory.hold(candidate.content, `${candidate.source}:explicit-review`);
          if (!committed.verified || !committed.bucketId) throw new Error(`Memory commit could not be verified (${committed.verification})`);
          return sendJson(response, 200, await store.updateCandidate(id, { status: "saved", externalId: committed.bucketId, error: undefined }));
        } catch (error) {
          return sendJson(response, 502, await store.updateCandidate(id, { error: error instanceof Error ? error.message : "Memory commit failed" }));
        }
      }
      if (request.method === "GET" && url.pathname === "/v1/memory/health") {
        if (!memory) return sendJson(response, 503, { status: "unconfigured", provider: "gateway-candidate-store" });
        return sendJson(response, 200, await memory.health());
      }
      if (request.method === "GET" && url.pathname === "/v1/memory/buckets") {
        if (!memory) return sendJson(response, 503, { error: "memory_unconfigured" });
        return sendJson(response, 200, await memory.listBuckets(url.searchParams.get("includeArchive") === "true"));
      }
      const memoryEvidence = url.pathname.match(/^\/v1\/memory\/buckets\/([^/]+)\/evidence$/);
      if (request.method === "GET" && memoryEvidence) {
        if (!memory) return sendJson(response, 503, { error: "memory_unconfigured" });
        return sendJson(response, 200, await memory.evidence(decodeURIComponent(memoryEvidence[1])));
      }
      const memoryBucket = url.pathname.match(/^\/v1\/memory\/buckets\/([^/]+)$/);
      if (request.method === "GET" && memoryBucket) {
        if (!memory) return sendJson(response, 503, { error: "memory_unconfigured" });
        return sendJson(response, 200, await memory.readBucket(decodeURIComponent(memoryBucket[1])));
      }
      if (request.method === "GET" && url.pathname === "/v1/memory/search") {
        if (!memory) return sendJson(response, 503, { error: "memory_unconfigured" });
        const query = url.searchParams.get("q")?.trim() ?? "";
        if (!query) return sendJson(response, 400, { error: "memory_query_required" });
        return sendJson(response, 200, await memory.search(query, Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20))));
      }
      if (request.method === "GET" && url.pathname === "/v1/memory/daily-impressions") {
        if (!memory) return sendJson(response, 503, { error: "memory_unconfigured" });
        const from = url.searchParams.get("from") ?? "";
        const to = url.searchParams.get("to") ?? "";
        const items = dailyImpressions(await memory.listBuckets(false)).filter((item) => (!from || item.date >= from) && (!to || item.date <= to));
        return sendJson(response, 200, items);
      }
      if (request.method === "GET" && url.pathname === "/v1/memory/portrait") {
        if (!memory) return sendJson(response, 503, { error: "memory_unconfigured" });
        return sendJson(response, 200, await memory.portrait());
      }
      if (request.method === "POST" && url.pathname === "/v1/memory/breath") {
        if (!memory) return sendJson(response, 503, { error: "memory_unconfigured" });
        return sendJson(response, 200, await memory.breath(await body(request)));
      }
      if (request.method === "GET" && url.pathname === "/v1/home") return sendJson(response, 200, store.getHome());
      if (request.method === "PUT" && url.pathname === "/v1/home") return sendJson(response, 200, await store.saveHome(await body(request)));
      if (request.method === "GET" && url.pathname === "/v1/presence") return sendJson(response, 200, store.getPresence());
      if (request.method === "POST" && url.pathname === "/v1/presence/visit") return sendJson(response, 200, await store.markUserVisit());
      if (request.method === "GET" && url.pathname === "/v1/paper-notes") {
        const date = url.searchParams.get("date") || new Intl.DateTimeFormat("en-CA", { timeZone: process.env.OCEAN_TIME_ZONE?.trim() || "Asia/Shanghai" }).format(new Date());
        const notePackage = store.getPaperNotePackage(date);
        const notes = url.searchParams.get("all") === "true" ? notePackage?.notes ?? [] : visiblePaperNotes(notePackage);
        return sendJson(response, 200, { date, sourceDate: notePackage?.sourceDate, sourceImpressionId: notePackage?.sourceImpressionId, generatedAt: notePackage?.generatedAt, notes });
      }
      if (request.method === "POST" && url.pathname === "/v1/paper-notes/generate") {
        const input = await body(request);
        const result = await generatePaperNotes(store, providers, memory, { targetDate: typeof input.targetDate === "string" ? input.targetDate : undefined, force: input.force === true });
        return sendJson(response, result.status === "generated" ? 201 : 200, result);
      }
      if (request.method === "GET" && url.pathname === "/v1/free-time/config") return sendJson(response, 200, normalizeFreeTimeConfig(store.getFreeTime() ?? DEFAULT_FREE_TIME_CONFIG));
      if (request.method === "PUT" && url.pathname === "/v1/free-time/config") return sendJson(response, 200, await store.saveFreeTime(normalizeFreeTimeConfig(await body(request))));
      if (request.method === "POST" && url.pathname === "/v1/free-time/preview") {
        const input = await body(request);
        const config = normalizeFreeTimeConfig(input.config ?? store.getFreeTime() ?? DEFAULT_FREE_TIME_CONFIG);
        return sendJson(response, 200, buildFreeTimePrompt(config));
      }
      if (request.method === "GET" && url.pathname === "/v1/free-time/runs") return sendJson(response, 200, store.listFreeTimeRuns());
      const freeTimeOutcomeMatch = url.pathname.match(/^\/v1\/free-time\/runs\/([^/]+)\/outcome$/);
      if (request.method === "PUT" && freeTimeOutcomeMatch) {
        const input = await body(request);
        const summary = typeof input.summary === "string" ? input.summary.trim().slice(0, 500) : "";
        if (!summary) return sendJson(response, 400, { error: "invalid_free_time_outcome", message: "summary is required" });
        const numberInRange = (value: unknown) => {
          const parsed = typeof value === "number" ? value : Number(value);
          return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : undefined;
        };
        const completedAt = typeof input.completedAt === "string" && !Number.isNaN(Date.parse(input.completedAt))
          ? new Date(input.completedAt).toISOString()
          : new Date().toISOString();
        const saved = await store.saveFreeTimeOutcome(decodeURIComponent(freeTimeOutcomeMatch[1]), {
          summary,
          valence: numberInRange(input.valence),
          arousal: numberInRange(input.arousal),
          completedAt,
        });
        if (saved) await notifications.notifyFreeTime(saved);
        return saved ? sendJson(response, 200, saved) : sendJson(response, 404, { error: "free_time_run_not_found" });
      }
      if (request.method === "PUT" && url.pathname === "/v1/free-time/activity") {
        const input = await body(request);
        const requestedAt = typeof input.at === "string" && !Number.isNaN(Date.parse(input.at)) ? new Date(input.at).toISOString() : new Date().toISOString();
        return sendJson(response, 200, { at: await store.markFreeTimeUserActivity(requestedAt) });
      }
      if (request.method === "POST" && url.pathname === "/v1/free-time/trigger") {
        const input = await body(request);
        const run = await runFreeTime(store, providers, fishing, notifications, { manual: input.manual === true, recordSkip: true });
        return sendJson(response, run?.status === "skipped" ? 200 : 202, run);
      }
      if (url.pathname.startsWith("/v1/reading/")) return void await proxyCoReading(request, response, url);
      return sendJson(response, 404, { error: "not_found", path: url.pathname });
    } catch (error) {
      console.error("Ocean Gateway request failed:", request.method, url.pathname, error);
      return sendJson(response, 500, { error: "gateway_error", message: error instanceof Error ? error.message : "Upstream request failed" });
    }
  });

  let schedulerBusy = false;
  const schedulerTimer = setInterval(() => {
    if (schedulerBusy) return;
    schedulerBusy = true;
    void runFreeTime(store, providers, fishing, notifications).catch((error) => console.error("Ocean free-time scheduler:", error)).finally(() => { schedulerBusy = false; });
  }, 30_000);
  schedulerTimer.unref();
  let paperNotesBusy = false;
  const runPaperNoteScheduler = async () => {
    if (paperNotesBusy) return;
    paperNotesBusy = true;
    try {
      await generatePaperNotes(store, providers, memory);
      await deliverDuePaperNotes(store, notifications);
    } catch (error) {
      console.error("Ocean paper-note scheduler:", error instanceof Error ? error.message : error);
    } finally { paperNotesBusy = false; }
  };
  const paperNoteTimer = setInterval(() => void runPaperNoteScheduler(), 10 * 60_000);
  paperNoteTimer.unref();
  setTimeout(() => void runPaperNoteScheduler(), 5_000).unref();
  server.once("close", () => { clearInterval(schedulerTimer); clearInterval(paperNoteTimer); });
  return server;
}

async function main() {
  const server = await createOceanGateway();
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.OCEAN_GATEWAY_HOST ?? "127.0.0.1";
  server.listen(port, host, () => console.log(`Ocean Gateway listening on http://${host}:${port}`));
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) void main();
