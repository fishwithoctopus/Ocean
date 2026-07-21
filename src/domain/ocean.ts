export type MessageRole = "user" | "assistant";

export interface ReasoningSummary {
  title: string;
  content: string;
}

export interface MessageTurn {
  id: string;
  role: MessageRole;
  createdAt: string;
  segments: string[];
  attachments?: MessageAttachment[];
  reasoning?: ReasoningSummary;
  source?: "chat" | "free-time";
}

export interface MessageAttachment {
  id: string;
  kind: "image";
  name: string;
  mimeType: string;
  size: number;
  previewDataUrl: string;
}

export interface ChatAttachment {
  id: string;
  kind: "image" | "text" | "connector";
  name: string;
  mimeType: string;
  size: number;
  data: string;
  previewDataUrl?: string;
}

export interface ChatContext {
  mode: "living-room" | "project" | "reading" | "meeting";
  nightTalk: boolean;
  elapsedSinceLastTurn?: string;
  messages?: Array<{ role: MessageRole; content: string }>;
  providerId?: string;
  modelId?: string;
  settings?: Record<string, string>;
  continuitySummary?: string;
  continuityHandoff?: string;
  physicalSessionId?: string;
  modeInstruction?: string;
  attachments?: ChatAttachment[];
}

export type ChatStreamEvent =
  | { type: "reasoning"; value: ReasoningSummary }
  | { type: "segment"; value: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens?: number; providerId?: string; modelId?: string; cost?: number; currency?: string; costEstimated?: boolean; pricingSource?: "provider" | "built-in" | "gateway-config"; memoryRecall?: { status: "hit" | "miss" | "skipped" | "disabled" | "unavailable"; count: number; directCount: number; relatedCount: number } }
  | { type: "error"; message: string; code?: string; retryable?: boolean; providerId?: string; modelId?: string }
  | { type: "done" };

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  providerId?: string;
  upstreamModelId?: string;
  profiles: ModelProfile[];
  settings: ModelSetting[];
  capabilities: string[];
}

export interface ProviderSummary {
  id: string;
  name: string;
  kind: "mock" | "openai-responses" | "anthropic-messages" | "openai-compatible";
  configured: boolean;
  defaultModel: string | null;
  capabilities: string[];
  models: Array<Omit<ModelOption, "provider">>;
}

export interface ModelProfile {
  id: string;
  label: string;
}

export interface ModelSetting {
  id: string;
  label: string;
  defaultValue: string;
  options: ModelProfile[];
}

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  estimatedCost: number;
  currency: "CNY";
}

export interface ContinuitySnapshot {
  logicalConversationId: string;
  physicalSessionId: string;
  generation: number;
  summary: string;
  handoff: string;
  recentTurnIds: string[];
  forgedAt?: string;
  source?: "local-fallback" | "gateway-deterministic" | "gateway-staging" | "provider";
  warning?: "provider-summary-failed";
  forged?: boolean;
  storage?: {
    usedUnits: number;
    thresholdUnits: number;
    reserveUnits: number;
    safeThresholdUnits: number;
    remainingUnits: number;
    percentRemaining: number;
    shouldForge: boolean;
    unit: "normalized-token-estimate";
  };
}

export type IntegrationState = "real" | "staging" | "mock" | "unconfigured";

export interface IntegrationStatus {
  id: string;
  state: IntegrationState;
  source: string;
  detail: string;
}

export interface IntegrationManifest {
  generatedAt: string;
  services: IntegrationStatus[];
}

export interface MemoryCandidate {
  id: string;
  content: string;
  source: string;
  status: "candidate" | "saved" | "dismissed";
  createdAt: string;
  externalId?: string;
  error?: string;
}

export interface MemoryBucketSummary {
  id: string;
  title: string;
  domain: string;
  valence: number;
  arousal: number;
  importance: number;
  score: number;
  tags: string[];
  pinned: boolean;
  archived: boolean;
  kind: "memory" | "feel" | "whisper";
}

export interface DailyImpressionSummary {
  id: string;
  date: string;
  title: string;
  valence: number;
  arousal: number;
  intensity: number;
}

export interface MemorySearchHit {
  id: string;
  title: string;
  snippet: string;
  kind: "direct" | "related";
  created?: string;
}

export interface MemoryEvidenceEntry {
  id: string;
  title: string;
  snippet: string;
  sourceType: string;
}

export interface MemoryEvidenceChain {
  bucketId: string;
  summary: string;
  direct: MemoryEvidenceEntry[];
  derived: MemoryEvidenceEntry[];
  context: MemoryEvidenceEntry[];
  warnings: string[];
}

export interface MemoryPortraitItem {
  text: string;
  emotions: string[];
  trigger?: string;
  action?: string;
  avoid?: string;
}

export interface MemoryPortraitGroup {
  title: string;
  items: MemoryPortraitItem[];
}

export interface MemoryPortraitSection {
  id: "user" | "self" | "bond" | "continuity";
  title: string;
  groups: MemoryPortraitGroup[];
}

export interface MemoryPortrait {
  sections: MemoryPortraitSection[];
  source: "memory-3-profile";
}
