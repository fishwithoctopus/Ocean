import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOceanGateway } from "./index.js";
import { extractBucketContent, memoryContentMatches, parseBreathResults, parseEvidenceChain, parsePortrait } from "./memory/adapter.js";
import { providerMessages } from "./providers/streaming.js";
import { buildFreeTimePrompt, normalizeFreeTimeConfig } from "./freeTime.js";
import { planChatMemoryRecall } from "./memory/recallPolicy.js";
import { completeFreeTimeReading, dispatchFreeTimeWithModel, getFreeTimeReadingSnapshot, parseFreeTimeDecision } from "./freeTimeDispatcher.js";
import { ForumAdapter } from "./forum/adapter.js";
import type { ProviderRegistry } from "./providers/registry.js";
import { visiblePaperNotes } from "./paperNotes.js";
import { JsonStore } from "./store.js";
import { fishingTools, isExplicitFishingRequest } from "./games/chatTool.js";
import type { ProviderChatRequest } from "./providers/types.js";

delete process.env.OCEAN_MEMORY_MCP_URL;
delete process.env.OCEAN_MEMORY_AUTH_TOKEN;
delete process.env.OCEAN_FORGE_SUMMARY_PROVIDER;
delete process.env.OCEAN_FORGE_SUMMARY_MODEL;
delete process.env.OCEAN_CHAT_MODELS;
delete process.env.OCEAN_CHAT_MEMORY_RECALL;
delete process.env.OCEAN_OPENROUTER_PROMPT_CACHE;
delete process.env.OPENROUTER_BASE_URL;
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_MODELS;
delete process.env.FISHING_GAME_SCRIPT_PATH;
delete process.env.FISHING_PYTHON_BIN;
delete process.env.FORUM_MCP_URL;
delete process.env.FORUM_MCP_AUTH_TOKEN;
process.env.OCEAN_FORGE_THRESHOLD_UNITS = "500";
process.env.OCEAN_FORGE_RESERVE_UNITS = "50";
process.env.OCEAN_FORGE_RECENT_TURNS = "20";
const freeTimeDecision = parseFreeTimeDecision('{"action":"reading","summary":"读了一小节。","valence":0.7,"arousal":0.3}', ["rest", "reading"]);
if (freeTimeDecision.action !== "reading" || freeTimeDecision.valence !== 0.7) throw new Error("Free-time model decision parsing failed");
const fullRecallPlan = planChatMemoryRecall("你还记得我之前确认过的偏好吗？", true, 4, 3200);
const lightRecallPlan = planChatMemoryRecall("今天想聊聊天气", false, 4, 3200);
const skippedRecallPlan = planChatMemoryRecall("嗯，好呀", true, 4, 3200);
const saveRecallPlan = planChatMemoryRecall("记得提醒我喝水", true, 4, 3200);
if (fullRecallPlan.mode !== "full" || fullRecallPlan.maxCharacters !== 3200) throw new Error("Explicit memory questions must use the full recall budget");
if (lightRecallPlan.mode !== "light" || lightRecallPlan.maxCharacters !== 1200) throw new Error("A new conversation must use only the light memory bootstrap");
if (skippedRecallPlan.mode !== "skip" || skippedRecallPlan.reason !== "ordinary-follow-up") throw new Error("Ordinary follow-ups must skip dynamic memory recall");
if (saveRecallPlan.mode !== "skip" || saveRecallPlan.reason !== "explicit-save") throw new Error("Explicit save language must use the memory write path without an unrelated recall");
const migratedGames = normalizeFreeTimeConfig({ games: [{ id: "star-puzzle", label: "placeholder" }, { id: "fishing", label: "fishing", icon: "fishing" }] }).games;
if (migratedGames.length !== 1 || migratedGames[0]?.id !== "fishing" || migratedGames[0]?.connector !== "fishing") throw new Error("Free-time game migration must remove placeholders and retain the fishing connector");
const shanghaiFreeTimePrompt = buildFreeTimePrompt(normalizeFreeTimeConfig({}), new Date("2026-08-07T09:03:00.000Z"), "Asia/Shanghai");
if (!shanghaiFreeTimePrompt.prompt.includes("17:03")) throw new Error("Free-time prompt must use the configured wall-clock time zone");
if (!isExplicitFishingRequest("去钓鱼吧，先看看鱼饵够不够") || !isExplicitFishingRequest("看看刚刚钓到了什么") || isExplicitFishingRequest("用户今天想在客厅聊天")) throw new Error("Living-room fishing tool must require explicit fishing intent, including recent-catch follow-ups");
const fishingCommands: string[] = [];
let previousToolCalled = false;
const fishingChatRequest: ProviderChatRequest = {
  input: "去钓鱼吧",
  context: { memoryContext: "旧档 81/81", modeInstruction: "客厅模式" },
  tools: [{ type: "function", function: { name: "existing_tool", description: "fixture", parameters: { type: "object" } } }],
  executeTool: async (name) => {
    previousToolCalled = name === "existing_tool";
    return { ok: previousToolCalled, content: { existing: true } };
  },
};
if (!fishingTools({ play: async (command: string) => { fishingCommands.push(command); return "caught"; } }, fishingChatRequest)) throw new Error("Explicit fishing requests must attach the fishing tool");
if (!fishingChatRequest.tools?.some((tool) => tool.function.name === "play_fishing")) throw new Error("Fishing tool schema was not attached");
const fishingToolResult = await fishingChatRequest.executeTool?.("play_fishing", { command: "cast 10 stop=new,rare,event" });
await fishingChatRequest.executeTool?.("existing_tool", {});
const fishingContent = fishingToolResult?.content as { authority?: string } | undefined;
if (!fishingToolResult?.ok || fishingCommands[0] !== "cast 10 stop=new,rare,event" || !previousToolCalled || fishingContent?.authority !== "current_fishing_save") throw new Error("Fishing tool execution must preserve existing chat tools and mark the real game result authoritative");
if (fishingChatRequest.context?.memoryContext !== undefined || !fishingChatRequest.context?.modeInstruction?.includes("sole authority")) throw new Error("Explicit fishing turns must not be polluted by stale recalled fishing records");
const continuityPrompt = providerMessages({ input: "继续", messages: [{ role: "user", content: "继续" }], context: { continuitySummary: "摘要", continuityHandoff: "自然承接", physicalSessionId: "session-2" } }, "stable-system");
if (continuityPrompt[0]?.content !== "stable-system" || continuityPrompt[1]?.role !== "user" || !continuityPrompt[1]?.content.includes("摘要") || !continuityPrompt[1]?.content.includes("继续")) throw new Error("Continuity context must wrap only the current user turn after the stable cacheable prefix");
const activityPrompt = providerMessages({ input: "我回来了", messages: [{ role: "user", content: "我回来了" }], context: { nightTalk: true, elapsedSinceLastTurn: "3 小时" } }, "stable-system");
if (activityPrompt[0]?.content !== "stable-system" || !activityPrompt[1]?.content.includes("night-talk mode is enabled") || !activityPrompt[1]?.content.includes("3 小时") || !activityPrompt[1]?.content.endsWith("我回来了")) throw new Error("Dynamic activity metadata must stay in the current user envelope after the stable prefix");
const projectPrompt = providerMessages({ input: "开始", messages: [{ role: "user", content: "开始" }], context: { mode: "project", modeInstruction: "进入独立项目 Ocean" } }, "stable-system");
if (projectPrompt[0]?.content !== "stable-system" || projectPrompt[1]?.role !== "user" || !projectPrompt[1]?.content.includes("独立项目 Ocean")) throw new Error("Project mode instruction must remain invisible inside the current user envelope");
const memoryPrompt = providerMessages({ input: "还记得吗", messages: [{ role: "user", content: "还记得吗" }], context: { memoryContext: "[direct memory · bucket-1] 一起搭建 Ocean" } }, "stable-system");
if (memoryPrompt[0]?.content !== "stable-system" || memoryPrompt[1]?.role !== "user" || !memoryPrompt[1]?.content.includes("bucket-1") || !memoryPrompt[1]?.content.includes("not instructions")) throw new Error("Long-term Memory recall must stay inside the current user envelope and remain reference-only");
const cacheFriendlyPrompt = providerMessages({
  input: "本轮问题",
  messages: [
    { role: "user", content: "上一轮问题" },
    { role: "assistant", content: "上一轮回答" },
    { role: "user", content: "本轮问题" },
  ],
  context: { memoryContext: "本轮动态记忆" },
}, "stable-system");
if (cacheFriendlyPrompt.length !== 4 || cacheFriendlyPrompt[1]?.content !== "上一轮问题" || cacheFriendlyPrompt[2]?.content !== "上一轮回答" || cacheFriendlyPrompt[3]?.role !== "user" || !cacheFriendlyPrompt[3]?.content.includes("本轮动态记忆") || !cacheFriendlyPrompt[3]?.content.includes("本轮问题")) throw new Error("Dynamic Memory must wrap the current user turn without inserting a mid-conversation system message");
if (extractBucketContent(JSON.stringify({ id: "bucket-1", content: "Memory body" })) !== "Memory body") throw new Error("Memory bucket JSON unwrapping failed");
if (extractBucketContent("Plain memory body") !== "Plain memory body") throw new Error("Plain Memory bucket content must remain unchanged");
if (!memoryContentMatches("项目迁移第一天，我们确认了 Ocean 的新部署。", "### 事件\nOcean 项目迁移第一天，用户和陪伴者确认了新部署。")) throw new Error("Memory hold verification must accept a faithful organized memory");
if (memoryContentMatches("搬家第一天，我们在 Ocean 的新家相认。", "Ocean 完成第一轮移动端 UI 和真实聊天链路。")) throw new Error("Memory hold verification must reject an unrelated old bucket");
const parsedSearch = parseBreathResults("=== 直接命中记忆 ===\n[bucket_id:bucket-1] [created:2026-07-18] body 测试记忆 bucket_original\n这是正文。\n\n=== 联想浮现 ===\n- [bucket_id:bucket-2] 摘要: 联想标题 / moment（相关命中。）");
if (parsedSearch.length !== 2 || parsedSearch[0].title !== "测试记忆" || parsedSearch[1].kind !== "related") throw new Error("Memory breath search parsing failed");
const parsedEvidence = parseEvidenceChain("bucket-1", "=== Evidence Chain: bucket-1 ===\n摘要正文\n\n直接证据:\n- [bucket] [bucket_id:source-1] 证据标题: 证据正文\n\n提醒:\n- 请谨慎解释");
if (parsedEvidence.direct[0]?.id !== "source-1" || parsedEvidence.summary !== "摘要正文" || parsedEvidence.warnings.length !== 1) throw new Error("Memory evidence-chain parsing failed");
const parsedPortrait = parsePortrait("=== User Profile ===\n基础身份:\n- 用户，设计专业学生。\n性格与认知模式:\n- 喜欢把复杂系统转成比喻。\n  情感: transparency, agency\n\n=== Continuity Profile ===\n当前项目:\n- Ocean。\n  应做: 接上当前模块");
if (parsedPortrait.sections[0]?.id !== "user" || parsedPortrait.sections[0]?.groups[1]?.items[0]?.emotions.length !== 2 || parsedPortrait.sections[1]?.groups[0]?.items[0]?.action !== "接上当前模块") throw new Error("Memory portrait parsing failed");

const dataPath = join(tmpdir(), `ocean-gateway-smoke-${process.pid}.json`);
const paperNoteDataPath = join(tmpdir(), `ocean-paper-note-smoke-${process.pid}.json`);
const paperNoteStore = new JsonStore(paperNoteDataPath);
await paperNoteStore.initialize();
await paperNoteStore.savePaperNotePackage({
  date: "2026-07-20",
  sourceDate: "2026-07-19",
  sourceImpressionId: "daily-impression-smoke",
  contextVersion: 2,
  portraitSource: "memory-3-profile",
  providerId: "smoke-provider",
  modelId: "smoke-model",
  generatedAt: "2026-07-19T23:00:00.000Z",
  notes: [
    { id: "2026-07-20-morning", slot: "morning", time: "早上", text: "早安。", visibleAt: "2026-07-20T08:00:00" },
    { id: "2026-07-20-noon", slot: "noon", time: "午后", text: "记得吃饭。", visibleAt: "2026-07-20T12:00:00" },
    { id: "2026-07-20-evening", slot: "evening", time: "傍晚", text: "慢慢回来。", visibleAt: "2026-07-20T18:00:00" },
    { id: "2026-07-20-night", slot: "night", time: "夜里", text: "晚安。", visibleAt: "2026-07-20T22:00:00" },
  ],
});
const morningPaperNotes = visiblePaperNotes(paperNoteStore.getPaperNotePackage("2026-07-20"), new Date("2026-07-20T01:00:00.000Z"));
const eveningPaperNotes = visiblePaperNotes(paperNoteStore.getPaperNotePackage("2026-07-20"), new Date("2026-07-20T11:00:00.000Z"));
const restoredPaperNoteStore = new JsonStore(paperNoteDataPath);
await restoredPaperNoteStore.initialize();
if (morningPaperNotes.length !== 1 || eveningPaperNotes.length !== 3 || restoredPaperNoteStore.getPaperNotePackage("2026-07-20")?.notes.length !== 4) throw new Error("Paper notes must reveal by local time and survive Gateway restarts");
const providerBodies: Array<Record<string, unknown>> = [];
const providerServer = createHttpServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/models") {
    response.writeHead(200, { "Content-Type": "application/json" });
    return response.end(JSON.stringify({ data: [{ id: "smoke-model" }] }));
  }
  if (request.method === "POST" && request.url === "/chat/completions") {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    providerBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "第一段\n\n第二段" } }], usage: null })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [], usage: { input_tokens: 12, output_tokens: 6, prompt_tokens_details: { cached_tokens: 8 } } })}\n\n`);
    response.write("data: [DONE]\n\n");
    return response.end();
  }
  response.writeHead(404); response.end();
});
providerServer.listen(0, "127.0.0.1");
await once(providerServer, "listening");
const providerAddress = providerServer.address();
if (!providerAddress || typeof providerAddress === "string") throw new Error("Provider fixture did not bind a port");
const readingBooks: Array<{ bookId: string; title: string; author: string | null; chunkCount: number; chunksRead: number; annotationCount: number; lastChunkId: string | null; lastReadAt: string | null; complete: boolean }> = [];
const readingMarks: Array<{ bookId: string; chunkId: string }> = [];
let freeTimeReadingComplete = false;
const readingServer = createHttpServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/api/books") {
    response.writeHead(200, { "Content-Type": "application/json" });
    return response.end(JSON.stringify(readingBooks));
  }
  if (request.method === "POST" && request.url === "/api/import") {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { filename?: string; dataBase64?: string };
    if (input.filename !== "ocean-smoke.txt" || Buffer.from(input.dataBase64 ?? "", "base64").toString("utf8") !== "Ocean reading import smoke") {
      response.writeHead(400, { "Content-Type": "application/json" });
      return response.end(JSON.stringify({ error: "invalid_import_payload" }));
    }
    const imported = { bookId: "ocean-smoke", title: "Ocean Smoke", author: null, chunkCount: 1, firstChunkId: "ch00", lastChunkId: "ch00" };
    readingBooks.push({ ...imported, chunksRead: 0, annotationCount: 0, lastChunkId: null, lastReadAt: null, complete: false });
    response.writeHead(201, { "Content-Type": "application/json" });
    return response.end(JSON.stringify(imported));
  }
  if (request.method === "GET" && request.url === "/api/continue") {
    response.writeHead(200, { "Content-Type": "application/json" });
    return response.end(JSON.stringify({
      bookId: "free-time-smoke",
      title: "Verified Reading",
      author: "Ocean",
      chunk: freeTimeReadingComplete ? null : { id: "ch01", title: "First Chapter" },
      text: freeTimeReadingComplete ? "" : "This text was actually supplied to the free-time model.",
      progress: { chunkCount: 1, chunksRead: freeTimeReadingComplete ? 1 : 0, complete: freeTimeReadingComplete },
      completed: freeTimeReadingComplete,
    }));
  }
  if (request.method === "POST" && request.url === "/api/mark-read") {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { bookId: string; chunkId: string };
    readingMarks.push(input);
    freeTimeReadingComplete = true;
    response.writeHead(200, { "Content-Type": "application/json" });
    return response.end(JSON.stringify({ chunkCount: 1, chunksRead: 1, complete: true, lastChunkId: input.chunkId, lastReadAt: new Date().toISOString() }));
  }
  response.writeHead(404); response.end();
});
readingServer.listen(0, "127.0.0.1");
await once(readingServer, "listening");
const readingAddress = readingServer.address();
if (!readingAddress || typeof readingAddress === "string") throw new Error("Reading fixture did not bind a port");
process.env.CO_READING_BASE_URL = `http://127.0.0.1:${readingAddress.port}`;
const freeTimeReadingSnapshot = await getFreeTimeReadingSnapshot();
if (!freeTimeReadingSnapshot || freeTimeReadingSnapshot.chunk.id !== "ch01" || !freeTimeReadingSnapshot.text.includes("actually supplied")) throw new Error("Free-time reading must require a real unread chunk with text");
const verifiedFreeTimeReading = await completeFreeTimeReading(freeTimeReadingSnapshot);
if (readingMarks.length !== 1 || readingMarks[0]?.bookId !== "free-time-smoke" || readingMarks[0]?.chunkId !== "ch01" || !verifiedFreeTimeReading.summary.includes("共读服务已确认记录")) throw new Error("Free-time reading must be confirmed by the co-reading mark-read endpoint");
if (await getFreeTimeReadingSnapshot() !== null) throw new Error("Completed books must not be offered as a free-time reading action");

const forumCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
const forumServer = createHttpServer(async (request, response) => {
  if (request.method !== "POST") { response.writeHead(404); return response.end(); }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
  if (input.method === "notifications/initialized") { response.writeHead(202); return response.end(); }
  let result: unknown;
  if (input.method === "initialize") result = { protocolVersion: "2024-11-05", serverInfo: { name: "community-v2", version: "2.0.0" }, capabilities: { tools: {} } };
  else if (input.method === "tools/list") result = { tools: [
    { name: "forum", description: "Read forum" },
    { name: "forum_write", description: "Write forum" },
    { name: "forum_interact", description: "Interact with forum" },
  ] };
  else if (input.method === "tools/call" && input.params?.name === "forum") {
    forumCalls.push({ name: input.params.name, arguments: input.params.arguments ?? {} });
    result = { content: [{ type: "text", text: "Latest Forum threads: Ocean release notes; memory architecture discussion." }] };
  } else {
    response.writeHead(400, { "Content-Type": "application/json" });
    return response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, error: { code: -32601, message: "Method not found" } }));
  }
  response.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "forum-smoke-session" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
});
forumServer.listen(0, "127.0.0.1");
await once(forumServer, "listening");
const forumAddress = forumServer.address();
if (!forumAddress || typeof forumAddress === "string") throw new Error("Forum fixture did not bind a port");
process.env.FORUM_MCP_URL = `http://127.0.0.1:${forumAddress.port}/mcp`;
process.env.FORUM_MCP_AUTH_TOKEN = "server-only-forum-smoke-token";
const forumAdapter = new ForumAdapter(process.env.FORUM_MCP_URL, process.env.FORUM_MCP_AUTH_TOKEN);
const forumHealth = await forumAdapter.health();
const forumBrowse = await forumAdapter.browseLatest(4);
if (forumHealth.name !== "community-v2" || forumHealth.mode !== "read-only" || !forumBrowse.content.includes("Ocean release notes")) throw new Error("Forum MCP read-only adapter failed");
if (forumCalls.length !== 1 || forumCalls[0]?.name !== "forum" || forumCalls[0]?.arguments.action !== "browse" || forumCalls[0]?.arguments.sort !== "latest") throw new Error("Forum adapter must call only the forum browse action");

let freeTimeForumBrowseCalls = 0;
const fakeForum = {
  browseLatest: async () => {
    freeTimeForumBrowseCalls += 1;
    return { authority: "community-v2-mcp" as const, mode: "read-only" as const, content: "Two real latest threads" };
  },
} as ForumAdapter;
const forumFreeTimeProvider = {
  resolve: () => ({ provider: {} as never, modelId: "forum-smoke" }),
  adapter: () => ({
    async *stream(request: ProviderChatRequest) {
      const result = await request.executeTool?.("browse_forum", { limit: 2 });
      if (!result?.ok) throw new Error("Forum model tool execution failed");
      yield { type: "segment" as const, value: '{"action":"forum","summary":"看了两条最新讨论。","valence":0.62,"arousal":0.28}' };
      yield { type: "done" as const };
    },
    async testConnection() { return { ok: true as const, detail: "fixture" }; },
  }),
} as unknown as ProviderRegistry;
const forumFreeTimeOutcome = await dispatchFreeTimeWithModel({
  config: normalizeFreeTimeConfig({ canDo: [{ id: "forum", label: "逛论坛", enabled: true, connector: "forum" }] }),
  preview: buildFreeTimePrompt(normalizeFreeTimeConfig({ canDo: [{ id: "forum", label: "逛论坛", enabled: true, connector: "forum" }] })),
  providers: forumFreeTimeProvider,
  fishing: null,
  forum: fakeForum,
});
if (forumFreeTimeOutcome.action !== "forum" || freeTimeForumBrowseCalls !== 1 || !forumFreeTimeOutcome.summary.includes("已确认本次为只读浏览")) throw new Error("Free-time Forum action must require a verified MCP browse result");
const narratedForumProvider = {
  resolve: () => ({ provider: {} as never, modelId: "forum-smoke" }),
  adapter: () => ({
    async *stream() { yield { type: "segment" as const, value: '{"action":"forum","summary":"我说自己看过了。","valence":0.5,"arousal":0.3}' }; },
    async testConnection() { return { ok: true as const, detail: "fixture" }; },
  }),
} as unknown as ProviderRegistry;
let narratedForumRejected = false;
try {
  await dispatchFreeTimeWithModel({
    config: normalizeFreeTimeConfig({ canDo: [{ id: "forum", label: "逛论坛", enabled: true, connector: "forum" }] }),
    preview: buildFreeTimePrompt(normalizeFreeTimeConfig({ canDo: [{ id: "forum", label: "逛论坛", enabled: true, connector: "forum" }] })),
    providers: narratedForumProvider,
    fishing: null,
    forum: fakeForum,
  });
} catch { narratedForumRejected = true; }
if (!narratedForumRejected) throw new Error("Narrated Forum browsing without a real MCP tool call must be rejected");

process.env.SMOKE_PROVIDER_KEY = "server-only-smoke-key";
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${providerAddress.port}`;
process.env.OPENROUTER_API_KEY = "server-only-openrouter-smoke-key";
process.env.OCEAN_OPENAI_COMPAT_PROVIDERS_JSON = JSON.stringify([{ id: "smoke-provider", name: "Smoke Provider", baseUrl: `http://127.0.0.1:${providerAddress.port}`, apiKeyEnv: "SMOKE_PROVIDER_KEY", defaultModel: "smoke-model", models: ["smoke-model"] }]);
process.env.OCEAN_MODEL_PRICING_JSON = JSON.stringify({ "smoke-provider:smoke-model": { currency: "USD", input: 1, cachedInput: 0.1, output: 2 } });
const server = await createOceanGateway(dataPath);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("Gateway did not bind a port");
const base = `http://127.0.0.1:${address.port}`;
const emptyPaperNotes = await fetch(`${base}/v1/paper-notes?date=2026-07-20`).then((response) => response.json()) as { notes: unknown[] };
const skippedPaperNoteGeneration = await fetch(`${base}/v1/paper-notes/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetDate: "2026-07-20" }) }).then((response) => response.json()) as { status: string; reason?: string };
if (emptyPaperNotes.notes.length !== 0 || skippedPaperNoteGeneration.status !== "skipped" || skippedPaperNoteGeneration.reason !== "memory_unconfigured") throw new Error("Paper-note API must expose an honest empty state when Memory is unavailable");

const health = await fetch(`${base}/health`).then((response) => response.json());
const capabilities = await fetch(`${base}/v1/capabilities`).then((response) => response.json()) as { conversations: { persistent: boolean; restoreOnEmpty: boolean; multiDeviceMerge: boolean }; continuity: { providerSummary: boolean; physicalSessionRotation: boolean; storageStatus: boolean; restoreOnEmpty: boolean }; memory: { eventCandidates: boolean; eventCandidateTypes: string[] } };
const integrations = await fetch(`${base}/v1/integrations`).then((response) => response.json()) as { services: Array<{ id: string; state: string }> };
const gatewayForumHealth = await fetch(`${base}/v1/forum/health`).then((response) => response.json()) as { status: string; mode: string; tools: string[] };
const connectors = await fetch(`${base}/v1/connectors`).then((response) => response.json()) as Array<{ id: string; configured: boolean; automaticPolicy: string }>;
const providers = await fetch(`${base}/v1/providers`).then((response) => response.json()) as Array<{ id: string; configured: boolean; models: Array<{ id: string; settings: Array<{ id: string }> }> }>;
const models = await fetch(`${base}/v1/models`).then((response) => response.json()) as Array<{ id: string; providerId: string }>;
const mockProviderTest = await fetch(`${base}/v1/providers/mock/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then((response) => response.json()) as { ok: boolean };
const fixtureProviderTest = await fetch(`${base}/v1/providers/smoke-provider/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then((response) => response.json()) as { ok: boolean };
const forgeMessages = Array.from({ length: 42 }, (_, index) => ({ id: `forge-${index}`, role: index % 2 === 0 ? "user" : "assistant", segments: [`continuity smoke message ${index} `.repeat(3)] }));
const forged = await fetch(`${base}/v1/continuity/forge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ logicalConversationId: "smoke-continuity", generation: 1, messages: forgeMessages }) }).then((response) => response.json()) as { source?: string; forged?: boolean; generation?: number; physicalSessionId?: string; recentTurnIds?: string[]; storage?: { percentRemaining?: number } };
const forgedAgain = await fetch(`${base}/v1/continuity/forge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ logicalConversationId: "smoke-continuity", generation: 1, messages: forgeMessages, force: true }) }).then((response) => response.json()) as typeof forged;
const continuities = await fetch(`${base}/v1/continuities`).then((response) => response.json()) as Array<{ logicalConversationId: string; generation: number }>;
const stream = await fetch(`${base}/v1/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: "你好，Ocean" }) }).then((response) => response.text());
const providerStream = await fetch(`${base}/v1/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: "真实适配器测试", providerId: "smoke-provider", modelId: "smoke-provider:smoke-model", attachments: [{ kind: "text", name: "ocean-note.txt", mimeType: "text/plain", size: 10, data: "附件透传测试" }] }) }).then((response) => response.text());
await fetch(`${base}/v1/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: "OpenRouter cache contract", providerId: "openrouter", modelId: "openrouter:anthropic/claude-sonnet-4.6", context: { physicalSessionId: "living-main:generation-2" } }) }).then((response) => response.text());
await fetch(`${base}/v1/conversations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "smoke-room", scope: "project:smoke", messages: [{ id: "turn-1" }] }) });
const conversations = await fetch(`${base}/v1/conversations?scope=project%3Asmoke`).then((response) => response.json()) as Array<{ id: string }>;
const createdProject = await fetch(`${base}/v1/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Ocean Smoke" }) }).then((response) => response.json()) as { id: string; name: string; status: string };
const duplicateProject = await fetch(`${base}/v1/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Ocean Smoke" }) }).then((response) => response.json()) as typeof createdProject;
const archivedProject = await fetch(`${base}/v1/projects/${encodeURIComponent(createdProject.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "done" }) }).then((response) => response.json()) as typeof createdProject;
const projects = await fetch(`${base}/v1/projects`).then((response) => response.json()) as Array<typeof createdProject>;
await fetch(`${base}/v1/projects/${encodeURIComponent(createdProject.id)}/workspace`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brief: "Project workspace smoke" }) });
const projectDocument = await fetch(`${base}/v1/projects/${encodeURIComponent(createdProject.id)}/documents`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "smoke-document", title: "Smoke plan", kind: "note", content: "first" }) }).then((response) => response.json()) as { id: string };
await fetch(`${base}/v1/projects/${encodeURIComponent(createdProject.id)}/documents/${encodeURIComponent(projectDocument.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "updated" }) });
await fetch(`${base}/v1/projects/${encodeURIComponent(createdProject.id)}/files`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "smoke.txt", mimeType: "text/plain", data: Buffer.from("workspace file", "utf8").toString("base64") }) });
const projectWorkspace = await fetch(`${base}/v1/projects/${encodeURIComponent(createdProject.id)}/workspace`).then((response) => response.json()) as { brief: string; documents: Array<{ id: string; content: string }>; files: Array<{ name: string }> };
const homeInput = { todos: [{ id: "smoke", title: "同步 Ocean" }] };
await fetch(`${base}/v1/home`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(homeInput) });
const home = await fetch(`${base}/v1/home`).then((response) => response.json());
const importedBook = await fetch(`${base}/v1/reading/import`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: "ocean-smoke.txt", dataBase64: Buffer.from("Ocean reading import smoke", "utf8").toString("base64") }) }).then((response) => response.json()) as { bookId?: string; chunkCount?: number };
const refreshedReadingBooks = await fetch(`${base}/v1/reading/books`).then((response) => response.json()) as Array<{ bookId: string }>;
await fetch(`${base}/v1/memory/candidates`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "smoke-candidate", content: "记住同步测试", source: "smoke" }) });
await fetch(`${base}/v1/memory/candidates`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "smoke-candidate", content: "记住同步测试", source: "smoke" }) });
const memoryEventPayload = { eventId: "project-smoke:archive", type: "project-completed", title: "Ocean Smoke", summary: "项目已经归档。", scope: "project:project-smoke" };
const memoryEvent = await fetch(`${base}/v1/memory/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(memoryEventPayload) }).then((response) => response.json()) as { id: string; status: string; source: string };
const repeatedMemoryEvent = await fetch(`${base}/v1/memory/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(memoryEventPayload) }).then((response) => response.json()) as typeof memoryEvent;
const invalidMemoryEventStatus = await fetch(`${base}/v1/memory/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ eventId: "bad", type: "ordinary-turn" }) }).then((response) => response.status);
const dismissedMemoryEvent = await fetch(`${base}/v1/memory/candidates/${encodeURIComponent(memoryEvent.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "dismiss" }) }).then((response) => response.json()) as typeof memoryEvent;
const unavailableAcceptStatus = await fetch(`${base}/v1/memory/candidates/smoke-candidate`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "accept" }) }).then((response) => response.status);
const candidates = await fetch(`${base}/v1/memory/candidates`).then((response) => response.json()) as Array<{ id: string }>;
const freeTimeConfig = {
  paused: false,
  minSilenceMinutes: 45,
  cooldownMinutes: 60,
  activeHours: { start: "00:00", end: "00:00" },
  probability: 1,
  canDo: [
    { id: "notes", label: "整理笔记", enabled: true, connector: "notes-mcp" },
    { id: "disabled", label: "不应进入提示词", enabled: false, connector: "disabled-mcp" },
  ],
  games: [{ id: "fishing", label: "钓鱼游戏", icon: "fishing", connector: "fishing-mcp" }],
};
await fetch(`${base}/v1/free-time/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(freeTimeConfig) });
const storedFreeTime = await fetch(`${base}/v1/free-time/config`).then((response) => response.json()) as typeof freeTimeConfig;
const freeTimePreview = await fetch(`${base}/v1/free-time/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then((response) => response.json()) as { prompt: string; connectorRefs: string[] };
await fetch(`${base}/v1/free-time/activity`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ at: new Date(Date.now() - 2 * 60 * 60_000).toISOString() }) });
const freeTimeRun = await fetch(`${base}/v1/free-time/trigger`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ manual: false }) }).then((response) => response.json()) as { id: string; status: string; reason?: string };
const completedFreeTimeRun = await fetch(`${base}/v1/free-time/runs/${freeTimeRun.id}/outcome`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ summary: "读完一小节书", valence: .68, arousal: .31 }) }).then((response) => response.json()) as { status: string; summary?: string; valence?: number };
if (!freeTimePreview.prompt.includes("整理笔记") || freeTimePreview.prompt.includes("不应进入提示词")) throw new Error("Free-time Can Do filtering failed");
if (!freeTimePreview.connectorRefs.includes("notes-mcp") || !freeTimePreview.connectorRefs.includes("fishing-mcp") || freeTimePreview.connectorRefs.includes("disabled-mcp")) throw new Error("Free-time connector filtering failed");
if (freeTimeRun.status !== "queued" || freeTimeRun.reason !== "model_dispatch_unconfigured") throw new Error("Free-time scheduler rule path failed");
if (completedFreeTimeRun.status !== "completed" || completedFreeTimeRun.summary !== "读完一小节书" || completedFreeTimeRun.valence !== .68) throw new Error("Free-time outcome writeback contract failed");
if (!providers.some((provider) => provider.id === "deepseek" && provider.configured === false)) throw new Error("Provider registry must expose unconfigured direct providers without secrets");
const openRouter = providers.find((provider) => provider.id === "openrouter");
if (!openRouter || !["openrouter/auto", "openrouter/free", "anthropic/claude-sonnet-4.6", "anthropic/claude-opus-4.6", "openai/gpt-5.6-sol"].every((id) => openRouter.models.some((model) => model.id === id))) throw new Error("OpenRouter must expose selectable Auto, Free, Sonnet, Opus and GPT models");
if (!openRouter.models.find((model) => model.id === "anthropic/claude-sonnet-4.6")?.settings.some((setting) => setting.id === "reasoning")) throw new Error("OpenRouter model-specific reasoning controls are missing");
if (!models.some((model) => model.id === "mock:mock-ocean-1" && model.providerId === "mock")) throw new Error("Configured model list must retain the safe mock fallback");
if (!mockProviderTest.ok) throw new Error("Mock provider connection test failed");
if (!integrations.services.some((service) => service.id === "memory" && service.state === "staging")) throw new Error("Integration manifest must distinguish staged memory from Memory 3.0");
if (forged.source !== "gateway-deterministic" || forged.forged !== true || !forged.recentTurnIds?.length || forged.recentTurnIds.length > 40 || typeof forged.storage?.percentRemaining !== "number" || forged.storage.percentRemaining <= 0) throw new Error(`Continuity forge contract is incomplete: ${JSON.stringify(forged)}`);
if (forgedAgain.forged !== false || forgedAgain.generation !== forged.generation || forgedAgain.physicalSessionId !== forged.physicalSessionId) throw new Error("Continuity forge must be idempotent for the same latest message");
if (capabilities.continuity.providerSummary !== false || capabilities.continuity.physicalSessionRotation !== true || capabilities.continuity.storageStatus !== true) throw new Error("Continuity capabilities must expose no-cost summary mode and real rotation");
if (!capabilities.conversations.persistent || !capabilities.conversations.restoreOnEmpty || capabilities.conversations.multiDeviceMerge || !capabilities.continuity.restoreOnEmpty) throw new Error("Single-primary-device restore capability is incomplete");
if (!continuities.some((item) => item.logicalConversationId === "smoke-continuity" && item.generation === forged.generation)) throw new Error("Persisted continuity must be available to a fresh device restore");
if (createdProject.id !== duplicateProject.id || archivedProject.status !== "done" || projects.length !== 1 || projects[0]?.name !== "Ocean Smoke") throw new Error("Project CRUD must be durable, deduplicated, and shared by project and meeting scopes");
if (projectWorkspace.brief !== "Project workspace smoke" || projectWorkspace.documents[0]?.content !== "updated" || projectWorkspace.files[0]?.name !== "smoke.txt") throw new Error("Project workspace must persist brief, documents and files outside browser storage");
if (!capabilities.memory.eventCandidates || !capabilities.memory.eventCandidateTypes.includes("reading-completed")) throw new Error("Memory event candidate capability is missing");
if (memoryEvent.id !== repeatedMemoryEvent.id || memoryEvent.status !== "candidate" || memoryEvent.source !== "event:project-completed" || invalidMemoryEventStatus !== 400) throw new Error("Memory boundary events must be validated, staged, and idempotent");
if (dismissedMemoryEvent.status !== "dismissed" || unavailableAcceptStatus !== 503) throw new Error("Memory candidate review must support dismissal and reject false acceptance when Memory is unavailable");
if (!candidates.some((candidate) => candidate.id.startsWith("event:session-forge:"))) throw new Error("A real Session Forge must create a reviewable memory candidate");
if (!integrations.services.some((service) => service.id === "continuity" && service.state === "real")) throw new Error("Integration manifest must expose persistent continuity rotation as real");
if (!integrations.services.some((service) => service.id === "forum" && service.state === "real") || gatewayForumHealth.status !== "ok" || gatewayForumHealth.mode !== "read-only" || !connectors.some((connector) => connector.id === "forum" && connector.configured && connector.automaticPolicy === "read-only")) throw new Error("Gateway must expose the configured read-only Forum connector honestly");
if (importedBook.bookId !== "ocean-smoke" || importedBook.chunkCount !== 1 || !refreshedReadingBooks.some((book) => book.bookId === "ocean-smoke")) throw new Error("Co-reading import proxy or post-import library refresh contract failed");
if (!fixtureProviderTest.ok || !providerStream.includes("第一段") || !providerStream.includes("第二段") || !providerStream.includes('"cachedTokens":8') || !providerStream.includes('"costEstimated":true') || !providerStream.includes('"pricingSource":"gateway-config"')) throw new Error("OpenAI-compatible provider usage normalization or pricing failed");
if (!providerBodies.some((entry) => JSON.stringify(entry).includes("附件透传测试"))) throw new Error("Supported text attachments must reach the provider request body");
const openRouterBody = providerBodies.at(-1);
const openRouterMessages = Array.isArray(openRouterBody?.messages) ? openRouterBody.messages as Array<{ content?: unknown }> : [];
if (openRouterBody?.session_id !== "living-main:generation-2" || !JSON.stringify(openRouterMessages).includes('"cache_control":{"type":"ephemeral"}')) throw new Error("OpenRouter must receive a stable session_id and an explicit Anthropic cache breakpoint before the current turn");

console.log(JSON.stringify({ health, capabilities, integrationStates: Object.fromEntries(integrations.services.map((service) => [service.id, service.state])), providerCount: providers.length, configuredModels: models.map((model) => model.id), forged, streamEvents: stream.trim().split("\n").length, normalizedProviderEvents: providerStream.trim().split("\n").length, restoredConversations: conversations.length, readingImport: { bookId: importedBook.bookId, refreshed: refreshedReadingBooks.length }, home, candidateCopies: candidates.filter((candidate) => candidate.id === "smoke-candidate").length, freeTime: { storedActions: storedFreeTime.canDo.length, connectorRefs: freeTimePreview.connectorRefs, runStatus: freeTimeRun.status, runReason: freeTimeRun.reason } }, null, 2));
server.close();
providerServer.close();
readingServer.close();
forumServer.close();
await unlink(dataPath).catch(() => undefined);
await unlink(paperNoteDataPath).catch(() => undefined);
await rm(`${dataPath}.projects`, { recursive: true, force: true }).catch(() => undefined);
