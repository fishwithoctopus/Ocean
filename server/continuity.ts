import type { JsonStore, StoredContinuity } from "./store.js";
import type { ProviderRegistry } from "./providers/registry.js";
import type { ProviderChatRequest } from "./providers/types.js";

interface ForgeMessage {
  id: string;
  role: "user" | "assistant";
  segments: string[];
}

interface ForgeInput {
  logicalConversationId?: unknown;
  generation?: unknown;
  messages?: unknown;
  previous?: unknown;
  providerId?: unknown;
  modelId?: unknown;
  force?: unknown;
}

export interface ContinuityStorageStatus extends Record<string, unknown> {
  usedUnits: number;
  thresholdUnits: number;
  reserveUnits: number;
  safeThresholdUnits: number;
  remainingUnits: number;
  percentRemaining: number;
  shouldForge: boolean;
  unit: "normalized-token-estimate";
}

export interface ContinuityResult extends Omit<StoredContinuity, "updatedAt" | "lastForgeMessageId"> {
  storage: ContinuityStorageStatus;
  forged: boolean;
  warning?: "provider-summary-failed";
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizedMessages(value: unknown): ForgeMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || (item.role !== "user" && item.role !== "assistant")) return [];
    const segments = Array.isArray(item.segments) ? item.segments.filter((segment): segment is string => typeof segment === "string" && segment.trim().length > 0) : [];
    return [{ id: item.id, role: item.role, segments }];
  });
}

export function estimateNormalizedUnits(text: string) {
  let units = 0;
  for (const char of text) units += /[\u3400-\u9fff\uf900-\ufaff]/.test(char) ? 1 : /\s/.test(char) ? .05 : .25;
  return Math.max(0, Math.ceil(units));
}

function messageUnits(messages: ForgeMessage[]) {
  return messages.reduce((total, message) => total + 4 + estimateNormalizedUnits(message.segments.join("\n\n")), 0);
}

function selectRecentMessages(messages: ForgeMessage[], maxMessages: number, budgetUnits: number) {
  const candidates = messages.slice(-maxMessages);
  const selected: ForgeMessage[] = [];
  let usedUnits = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const message = candidates[index];
    const nextUnits = 4 + estimateNormalizedUnits(message.segments.join("\n\n"));
    if (selected.length > 0 && usedUnits + nextUnits > budgetUnits) break;
    selected.unshift(message);
    usedUnits += nextUnits;
  }
  return selected;
}

function truncateToUnits(text: string, maxUnits: number) {
  let used = 0;
  let result = "";
  for (const char of text) {
    const next = estimateNormalizedUnits(char);
    if (used + next > maxUnits) break;
    result += char;
    used += next;
  }
  return result.trim();
}

function contextMessages(messages: ForgeMessage[], previous?: Pick<StoredContinuity, "summary" | "handoff" | "recentTurnIds">) {
  if (!previous?.summary || !previous.recentTurnIds.length) return messages;
  const firstRetained = messages.findIndex((message) => message.id === previous.recentTurnIds[0]);
  return firstRetained >= 0 ? messages.slice(firstRetained) : messages.slice(-previous.recentTurnIds.length);
}

function storageStatus(messages: ForgeMessage[], previous: Pick<StoredContinuity, "summary" | "handoff" | "recentTurnIds"> | undefined, thresholdUnits: number, reserveUnits: number): ContinuityStorageStatus {
  const usedUnits = messageUnits(contextMessages(messages, previous)) + estimateNormalizedUnits(previous?.summary ?? "") + estimateNormalizedUnits(previous?.handoff ?? "");
  const safeThresholdUnits = Math.max(1, thresholdUnits - reserveUnits);
  const remainingUnits = Math.max(0, safeThresholdUnits - usedUnits);
  return {
    usedUnits,
    thresholdUnits,
    reserveUnits,
    safeThresholdUnits,
    remainingUnits,
    percentRemaining: Math.max(0, Math.min(100, Math.round((remainingUnits / safeThresholdUnits) * 100))),
    shouldForge: usedUnits >= safeThresholdUnits,
    unit: "normalized-token-estimate",
  };
}

function previousFromInput(input: ForgeInput, logicalConversationId: string): Omit<StoredContinuity, "updatedAt"> | undefined {
  if (!input.previous || typeof input.previous !== "object") return undefined;
  const value = input.previous as Record<string, unknown>;
  return {
    logicalConversationId,
    physicalSessionId: typeof value.physicalSessionId === "string" ? value.physicalSessionId : `${logicalConversationId}:generation-1`,
    generation: Number.isFinite(Number(value.generation)) ? Number(value.generation) : 1,
    summary: typeof value.summary === "string" ? value.summary : "",
    handoff: typeof value.handoff === "string" ? value.handoff : "",
    recentTurnIds: Array.isArray(value.recentTurnIds) ? value.recentTurnIds.filter((id): id is string => typeof id === "string") : [],
    forgedAt: typeof value.forgedAt === "string" ? value.forgedAt : undefined,
    source: value.source === "provider" || value.source === "gateway-deterministic" || value.source === "gateway-staging" ? value.source : "local-fallback",
    storage: value.storage && typeof value.storage === "object" ? value.storage as Record<string, unknown> : undefined,
  };
}

function deterministicSummary(messages: ForgeMessage[], previousSummary: string) {
  const topics = messages.filter((message) => message.role === "user").flatMap((message) => message.segments).slice(-6);
  const prefix = previousSummary ? `此前连续性：${previousSummary.slice(0, 600)}\n` : "";
  return `${prefix}最近的用户话题：${topics.join("；") || "继续当前共同生活与项目"}。`;
}

async function providerSummary(providers: ProviderRegistry, messages: ForgeMessage[], previousSummary: string) {
  const providerId = process.env.OCEAN_FORGE_SUMMARY_PROVIDER?.trim();
  if (!providerId) return null;
  const modelId = process.env.OCEAN_FORGE_SUMMARY_MODEL?.trim();
  const transcript = messages.map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.segments.join("\n")}`).join("\n\n");
  const input = [
    "为长期对话续接生成一份紧凑、忠实的中文摘要。保留关系状态、当前话题、未完成事项、用户偏好、承诺和重要时间事实；不要编造，不要宣布换窗，只输出摘要正文。",
    previousSummary ? `已有摘要：\n${previousSummary}` : "",
    `待收拢对话：\n${transcript}`,
  ].filter(Boolean).join("\n\n");
  const request: ProviderChatRequest = { input, providerId, modelId: modelId || undefined, messages: [{ role: "user", content: input }], settings: { reasoning: "low" }, context: { mode: "continuity-forge" } };
  const resolved = providers.resolve(request);
  let summary = "";
  for await (const event of providers.adapter(resolved.provider).stream(request, resolved.modelId)) if (event.type === "segment") summary += `${summary ? "\n\n" : ""}${event.value}`;
  return summary.trim() || null;
}

export class ContinuityService {
  private readonly thresholdUnits = positiveInteger(process.env.OCEAN_FORGE_THRESHOLD_UNITS, 12000);
  private readonly reserveUnits = positiveInteger(process.env.OCEAN_FORGE_RESERVE_UNITS, 2000);
  private readonly recentTurns = positiveInteger(process.env.OCEAN_FORGE_RECENT_TURNS, 20);

  constructor(private readonly store: JsonStore, private readonly providers: ProviderRegistry) {}

  async evaluate(input: ForgeInput): Promise<ContinuityResult> {
    const logicalConversationId = typeof input.logicalConversationId === "string" ? input.logicalConversationId : "living-main";
    const messages = normalizedMessages(input.messages);
    const stored = this.store.getContinuity(logicalConversationId);
    const clientPrevious = previousFromInput(input, logicalConversationId);
    const base = stored && (!clientPrevious || stored.generation >= clientPrevious.generation) ? stored : clientPrevious;
    const generation = base?.generation ?? (Number.isFinite(Number(input.generation)) ? Number(input.generation) : 1);
    const current: Omit<StoredContinuity, "updatedAt"> = base ? { ...base } : {
      logicalConversationId,
      physicalSessionId: `${logicalConversationId}:generation-${generation}:${crypto.randomUUID()}`,
      generation,
      summary: "",
      handoff: "",
      recentTurnIds: [],
      source: "gateway-deterministic",
    };
    const before = storageStatus(messages, current, this.thresholdUnits, this.reserveUnits);
    const force = input.force === true;
    if (!force && !before.shouldForge) {
      await this.store.saveContinuity({ ...current, storage: before });
      return { ...current, storage: before, forged: false };
    }
    const latestMessageId = messages.at(-1)?.id;
    if (latestMessageId && stored?.lastForgeMessageId === latestMessageId) {
      const status = storageStatus(messages, stored, this.thresholdUnits, this.reserveUnits);
      return { ...stored, storage: status, forged: false };
    }
    // One conversational round is a user message plus its assistant reply. The
    // original-message window is also budget bounded so forging creates space.
    const safeThresholdUnits = Math.max(1, this.thresholdUnits - this.reserveUnits);
    const recent = selectRecentMessages(messages, this.recentTurns * 2, Math.max(1, Math.floor(safeThresholdUnits * .6)));
    const older = messages.slice(0, Math.max(0, messages.length - recent.length));
    let summary: string | null = null;
    let summaryProviderFailed = false;
    try { summary = await providerSummary(this.providers, older.length ? older : messages, current.summary); }
    catch (error) {
      summary = null;
      summaryProviderFailed = true;
      console.warn(JSON.stringify({
        event: "ocean_continuity_summary",
        at: new Date().toISOString(),
        status: "provider_failed_deterministic_fallback",
        logicalConversationId,
        providerId: process.env.OCEAN_FORGE_SUMMARY_PROVIDER?.trim() || null,
        modelId: process.env.OCEAN_FORGE_SUMMARY_MODEL?.trim() || null,
        error: error instanceof Error ? error.message.slice(0, 240) : "unknown",
      }));
    }
    const nextGeneration = generation + 1;
    const handoff = "自然续接当前话题，不向用户宣布内部换窗；摘要只作为连续性背景，最近二十轮原文优先于摘要。";
    const next: Omit<StoredContinuity, "updatedAt"> = {
      logicalConversationId,
      physicalSessionId: `${logicalConversationId}:generation-${nextGeneration}:${crypto.randomUUID()}`,
      generation: nextGeneration,
      summary: truncateToUnits(summary ?? deterministicSummary(older.length ? older : messages, current.summary), Math.max(1, Math.floor(safeThresholdUnits * .3))),
      handoff,
      recentTurnIds: recent.map((message) => message.id),
      forgedAt: new Date().toISOString(),
      source: summary ? "provider" : "gateway-deterministic",
      lastForgeMessageId: latestMessageId,
    };
    const after = storageStatus(recent, { ...next, recentTurnIds: [] }, this.thresholdUnits, this.reserveUnits);
    await this.store.saveContinuity({ ...next, storage: after });
    return { ...next, storage: after, forged: true, ...(summaryProviderFailed ? { warning: "provider-summary-failed" as const } : {}) };
  }
}
