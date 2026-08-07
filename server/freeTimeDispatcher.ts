import type { FishingGameConnector } from "./games/fishing.js";
import type { FreeTimeConfig, FreeTimePromptPreview } from "./freeTime.js";
import type { ProviderRegistry } from "./providers/registry.js";
import type { GatewayStreamEvent, ProviderChatRequest } from "./providers/types.js";

export type FreeTimeModelUsage = {
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens?: number;
  cost?: number;
  currency?: string;
};

export type FreeTimeModelOutcome = {
  summary: string;
  valence: number;
  arousal: number;
  action: string;
  usage?: FreeTimeModelUsage;
};

type ModelDecision = {
  action: string;
  summary: string;
  command?: string;
  valence: number;
  arousal: number;
};

const clampAffect = (value: unknown, fallback: number) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
};

export function parseFreeTimeDecision(raw: string, allowedActions: string[]): ModelDecision {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  const parsed = JSON.parse(candidate) as Record<string, unknown>;
  const action = typeof parsed.action === "string" && allowedActions.includes(parsed.action) ? parsed.action : "rest";
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 360) : "安静地待了一会儿。";
  return {
    action,
    summary: summary || "安静地待了一会儿。",
    command: typeof parsed.command === "string" ? parsed.command.trim().slice(0, 300) : undefined,
    valence: clampAffect(parsed.valence, 0.5),
    arousal: clampAffect(parsed.arousal, 0.35),
  };
}

function readingConfig() {
  return {
    baseUrl: (process.env.CO_READING_BASE_URL ?? "http://127.0.0.1:8788").replace(/\/$/, ""),
    authToken: process.env.CO_READING_AUTH_TOKEN?.trim() ?? "",
  };
}

async function readingSnapshot() {
  const { baseUrl, authToken } = readingConfig();
  const response = await fetch(`${baseUrl}/api/continue`, {
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
  });
  if (!response.ok) throw new Error(`Co-reading snapshot failed with ${response.status}`);
  const page = await response.json() as Record<string, unknown>;
  return JSON.stringify({
    bookId: page.bookId,
    title: page.title,
    author: page.author,
    chunk: page.chunk,
    text: typeof page.text === "string" ? page.text.slice(0, 2800) : "",
    progress: page.progress,
  });
}

async function optionalSnapshot(label: string, task: () => Promise<unknown>) {
  try {
    const value = await task();
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    return `<${label}>${serialized.slice(0, 4000)}</${label}>`;
  } catch (error) {
    return `<${label}_unavailable>${error instanceof Error ? error.message : "unavailable"}</${label}_unavailable>`;
  }
}

export async function dispatchFreeTimeWithModel(input: {
  config: FreeTimeConfig;
  preview: FreeTimePromptPreview;
  providers: ProviderRegistry;
  fishing: FishingGameConnector | null;
}): Promise<FreeTimeModelOutcome> {
  const providerId = process.env.FREE_TIME_PROVIDER_ID?.trim() || "kimi";
  const configuredModel = process.env.FREE_TIME_MODEL_ID?.trim() || "kimi-k3";
  const allowedActions = ["rest"];
  const snapshots: string[] = [];

  for (const action of input.config.canDo.filter((item) => item.enabled)) {
    if (action.id === "reading" && process.env.CO_READING_BASE_URL) {
      allowedActions.push("reading");
      snapshots.push(await optionalSnapshot("reading_snapshot", readingSnapshot));
    } else if (action.id && !action.connector && action.id !== "message") {
      allowedActions.push(action.id);
    }
  }
  if (input.fishing && input.config.games.some((game) => game.connector === "fishing")) allowedActions.push("fishing");

  const prompt = [
    input.preview.prompt,
    ...snapshots,
    "从本次真实可用的行动中选择一个。不要声称执行未提供的能力。rest 代表什么都不做，也完全有效。",
    `可选 action：${[...new Set(allowedActions)].join(", ")}`,
    "只输出一个 JSON 对象，不要 Markdown：",
    '{"action":"rest","summary":"第一人称、简短记录实际做了什么","command":"仅 fishing 时填写游戏命令","valence":0.5,"arousal":0.35}',
    allowedActions.includes("fishing") ? "选择 fishing 时优先使用省 token 的批量指令，例如 cast 10 stop=new,rare,event，或用分号把购买、移动与连钓合并为一次 command；不要一竿一轮。" : "",
  ].join("\n\n");

  const request: ProviderChatRequest = {
    input: prompt,
    providerId,
    modelId: `${providerId}:${configuredModel}`,
    messages: [{ role: "user", content: prompt }],
    settings: providerId === "kimi" ? { reasoning: "max" } : { reasoning: "low", thinking: "disabled" },
    context: { mode: "free-time" },
  };
  const { provider, modelId } = input.providers.resolve(request);
  let raw = "";
  let usage: FreeTimeModelUsage | undefined;
  for await (const event of input.providers.adapter(provider).stream(request, modelId)) {
    if (event.type === "segment") raw += `${raw ? "\n\n" : ""}${event.value}`;
    if (event.type === "usage") usage = usageFromEvent(event);
    if (event.type === "error") throw new Error(event.message);
  }
  const decision = parseFreeTimeDecision(raw, [...new Set(allowedActions)]);
  let summary = decision.summary;
  if (decision.action === "fishing" && input.fishing) {
    const result = await input.fishing.play(decision.command || "看看现在能做什么");
    summary = `${summary}\n${result}`.slice(0, 500);
  }
  return { summary, valence: decision.valence, arousal: decision.arousal, action: decision.action, usage };
}

function usageFromEvent(event: Extract<GatewayStreamEvent, { type: "usage" }>): FreeTimeModelUsage {
  return {
    providerId: event.providerId,
    modelId: event.modelId,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cachedTokens: event.cachedTokens,
    cacheWriteTokens: event.cacheWriteTokens,
    cost: event.cost,
    currency: event.currency,
  };
}
