import type { FreeTimeConfig, FreeTimePromptPreview, FreeTimeRun } from "../domain/freeTime";
import type { ContinuitySnapshot, DailyImpressionSummary, IntegrationManifest, MemoryBucketSummary, MemoryEvidenceChain, MemoryPortrait, MemorySearchHit, MessageTurn, ModelOption, ProviderSummary } from "../domain/ocean";
import type { MusicPlayback, MusicPlaylist, MusicQrLogin, MusicQrState, MusicStatus, MusicTrack } from "../domain/music";
import { getGatewayBaseUrl } from "../config/gateway";

export interface GatewayHealth { status: "ok" | "degraded"; version: string; providers: string[] }
export interface ReadingHealth { status: "ok"; provider: "co-reading-mcp"; books: number; baseUrl: string }
export interface ForumHealth { status: "ok"; provider: "community-v2-mcp"; name: string; version: string; tools: string[]; mode: "read-only" }
export interface OceanAccessStatus { required: boolean; authenticated: boolean }
export interface OceanProject {
  id: string;
  name: string;
  description?: string;
  status: "todo" | "done";
  createdAt: string;
  updatedAt: string;
}
export type OceanProjectDocumentKind = "brief" | "note" | "output" | "meeting-minutes";
export interface OceanProjectDocument { id: string; title: string; kind: OceanProjectDocumentKind; content: string; createdAt: string; updatedAt: string }
export interface OceanProjectFile { id: string; name: string; mimeType: string; size: number; kind: "image" | "text" | "file"; createdAt: string }
export interface OceanProjectWorkspace { projectId: string; brief: string; documents: OceanProjectDocument[]; files: OceanProjectFile[]; createdAt: string; updatedAt: string }
export interface OceanNotionStatus { available: true; configured: boolean; connected: boolean; autoSync: boolean; parentPageConfigured: boolean; workspaceName?: string; parentTitle?: string; lastError?: string }
export interface OceanNotionProjectStatus { configured: boolean; autoSync: boolean; synced: boolean; url?: string; lastSyncedAt?: string; documentsSynced: number }
export interface OceanNotionSyncResult { projectId: string; projectPageId: string; url: string; lastSyncedAt: string; documentsSynced: number; filesReferenced: number }
export interface OceanPaperNote { id: string; slot: "morning" | "noon" | "evening" | "night"; time: string; text: string; visibleAt: string }
export interface OceanPaperNoteResponse { date: string; sourceDate?: string; sourceImpressionId?: string; generatedAt?: string; notes: OceanPaperNote[] }
export interface OpenRouterBalance { providerId: "openrouter"; currency: "USD"; totalCredits: number; totalUsage: number; remaining: number; fetchedAt: string }
export interface GatewayCapabilities {
  scheduler?: {
    persistent: boolean;
    automaticDispatch: boolean;
    providerId?: string | null;
    modelId?: string | null;
  };
}

export class OceanGatewayError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export class OceanGatewayClient {
  constructor(private readonly baseUrl?: string) {}
  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl ?? getGatewayBaseUrl()}${path}`, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
    if (!response.ok) throw new OceanGatewayError(response.status, `Ocean Gateway ${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  }
  health(signal?: AbortSignal) { return this.json<GatewayHealth>("/health", { signal }); }
  accessStatus(signal?: AbortSignal) { return this.json<OceanAccessStatus>("/v1/auth/status", { signal }); }
  login(password: string) { return this.json<{ authenticated: true; expiresAt?: string }>("/v1/auth/login", { method: "POST", body: JSON.stringify({ password }) }); }
  logout() { return this.json<{ authenticated: false }>("/v1/auth/logout", { method: "POST", body: "{}" }); }
  integrations(signal?: AbortSignal) { return this.json<IntegrationManifest>("/v1/integrations", { signal }); }
  capabilities(signal?: AbortSignal) { return this.json<GatewayCapabilities>("/v1/capabilities", { signal }); }
  listProviders(signal?: AbortSignal) { return this.json<ProviderSummary[]>("/v1/providers", { signal }); }
  openRouterBalance(signal?: AbortSignal) { return this.json<OpenRouterBalance>("/v1/providers/openrouter/balance", { signal }); }
  listModels(signal?: AbortSignal, includeUnconfigured = false) { return this.json<ModelOption[]>(`/v1/models${includeUnconfigured ? "?all=true" : ""}`, { signal }); }
  listConnectors(signal?: AbortSignal) { return this.json<Array<{ id: string; configured: boolean; provider: string; automaticPolicy: string }>>("/v1/connectors", { signal }); }
  testProvider(providerId: string) { return this.json<{ ok: true; detail: string }>(`/v1/providers/${encodeURIComponent(providerId)}/test`, { method: "POST", body: "{}" }); }
  listProjects() { return this.json<OceanProject[]>("/v1/projects"); }
  createProject(payload: { name: string; description?: string; id?: string }) { return this.json<OceanProject>("/v1/projects", { method: "POST", body: JSON.stringify(payload) }); }
  updateProject(id: string, payload: { name?: string; description?: string; status?: "todo" | "done" }) { return this.json<OceanProject>(`/v1/projects/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) }); }
  deleteProject(id: string) { return this.json<{ removed: number }>(`/v1/projects/${encodeURIComponent(id)}`, { method: "DELETE" }); }
  projectWorkspace(id: string) { return this.json<OceanProjectWorkspace>(`/v1/projects/${encodeURIComponent(id)}/workspace`); }
  updateProjectWorkspace(id: string, brief: string) { return this.json<OceanProjectWorkspace>(`/v1/projects/${encodeURIComponent(id)}/workspace`, { method: "PUT", body: JSON.stringify({ brief }) }); }
  addProjectDocument(id: string, payload: { title: string; content?: string; kind?: OceanProjectDocumentKind; id?: string }) { return this.json<OceanProjectDocument>(`/v1/projects/${encodeURIComponent(id)}/documents`, { method: "POST", body: JSON.stringify(payload) }); }
  updateProjectDocument(projectId: string, documentId: string, payload: { title?: string; content?: string; kind?: OceanProjectDocumentKind }) { return this.json<OceanProjectDocument>(`/v1/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}`, { method: "PATCH", body: JSON.stringify(payload) }); }
  deleteProjectDocument(projectId: string, documentId: string) { return this.json<{ removed: number }>(`/v1/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" }); }
  addProjectFile(projectId: string, payload: { name: string; mimeType: string; size: number; data: string }) { return this.json<OceanProjectFile>(`/v1/projects/${encodeURIComponent(projectId)}/files`, { method: "POST", body: JSON.stringify(payload) }); }
  notionStatus() { return this.json<OceanNotionStatus>("/v1/notion/status"); }
  testNotion() { return this.json<OceanNotionStatus>("/v1/notion/test", { method: "POST", body: "{}" }); }
  projectNotionStatus(projectId: string) { return this.json<OceanNotionProjectStatus>(`/v1/notion/projects/${encodeURIComponent(projectId)}`); }
  syncProjectToNotion(projectId: string) { return this.json<OceanNotionSyncResult>(`/v1/notion/projects/${encodeURIComponent(projectId)}/sync`, { method: "POST", body: "{}" }); }
  saveConversation(payload: unknown) { return this.json<{ id: string }>("/v1/conversations", { method: "POST", body: JSON.stringify(payload) }); }
  listConversations<T>(scope?: string) { return this.json<T[]>(`/v1/conversations${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`); }
  listContinuities<T>() { return this.json<T[]>("/v1/continuities"); }
  createHandoff(payload: { logicalConversationId: string; generation: number; messages: MessageTurn[]; previous?: ContinuitySnapshot; force?: boolean }) {
    return this.json<ContinuitySnapshot>("/v1/continuity/forge", { method: "POST", body: JSON.stringify(payload) });
  }
  getHome<T>() { return this.json<T | null>("/v1/home"); }
  saveHome(payload: unknown) { return this.json<unknown>("/v1/home", { method: "PUT", body: JSON.stringify(payload) }); }
  getPresence() { return this.json<{ userLastSeenAt?: string; companionLastActiveAt?: string }>("/v1/presence"); }
  markUserVisit() { return this.json<{ userLastSeenAt?: string; companionLastActiveAt?: string }>("/v1/presence/visit", { method: "POST", body: "{}" }); }
  listPaperNotes(date?: string, includeFuture = false) { return this.json<OceanPaperNoteResponse>(`/v1/paper-notes${date ? `?date=${encodeURIComponent(date)}${includeFuture ? "&all=true" : ""}` : includeFuture ? "?all=true" : ""}`); }
  generatePaperNotes(targetDate?: string, force = false) { return this.json<{ status: "generated" | "existing" | "skipped"; reason?: string; package?: OceanPaperNoteResponse }>("/v1/paper-notes/generate", { method: "POST", body: JSON.stringify({ targetDate, force }) }); }
  listMemoryCandidates<T>() { return this.json<T[]>("/v1/memory/candidates"); }
  addMemoryCandidate<T>(payload: unknown) { return this.json<T>("/v1/memory/candidates", { method: "POST", body: JSON.stringify(payload) }); }
  recordMemoryEvent<T>(payload: unknown) { return this.json<T>("/v1/memory/events", { method: "POST", body: JSON.stringify(payload) }); }
  updateMemoryCandidate<T>(id: string, action: "accept" | "dismiss") { return this.json<T>(`/v1/memory/candidates/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ action }) }); }
  memoryHealth(signal?: AbortSignal) { return this.json<{ status: "ok"; provider: "ombre-brain-mcp"; version: string; tools: string[] }>("/v1/memory/health", { signal }); }
  listMemoryBuckets(includeArchive = false, signal?: AbortSignal) { return this.json<MemoryBucketSummary[]>(`/v1/memory/buckets${includeArchive ? "?includeArchive=true" : ""}`, { signal }); }
  readMemoryBucket(bucketId: string, signal?: AbortSignal) { return this.json<{ id: string; content: string }>(`/v1/memory/buckets/${encodeURIComponent(bucketId)}`, { signal }); }
  searchMemory(query: string, limit = 20, signal?: AbortSignal) { return this.json<{ query: string; content: string; results: MemorySearchHit[] }>(`/v1/memory/search?q=${encodeURIComponent(query)}&limit=${limit}`, { signal }); }
  memoryEvidence(bucketId: string, signal?: AbortSignal) { return this.json<MemoryEvidenceChain>(`/v1/memory/buckets/${encodeURIComponent(bucketId)}/evidence`, { signal }); }
  memoryPortrait(signal?: AbortSignal) { return this.json<MemoryPortrait>("/v1/memory/portrait", { signal }); }
  listDailyImpressions(from: string, to: string, signal?: AbortSignal) { return this.json<DailyImpressionSummary[]>(`/v1/memory/daily-impressions?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { signal }); }
  breathMemory(payload: Record<string, unknown>) { return this.json<{ content: string }>("/v1/memory/breath", { method: "POST", body: JSON.stringify(payload) }); }
  readingHealth(signal?: AbortSignal) { return this.json<ReadingHealth>("/v1/reading/health", { signal }); }
  forumHealth(signal?: AbortSignal) { return this.json<ForumHealth>("/v1/forum/health", { signal }); }
  getFreeTimeConfig() { return this.json<FreeTimeConfig>("/v1/free-time/config"); }
  saveFreeTimeConfig(payload: FreeTimeConfig) { return this.json<FreeTimeConfig>("/v1/free-time/config", { method: "PUT", body: JSON.stringify(payload) }); }
  previewFreeTimePrompt(payload?: FreeTimeConfig) { return this.json<FreeTimePromptPreview>("/v1/free-time/preview", { method: "POST", body: JSON.stringify(payload ? { config: payload } : {}) }); }
  triggerFreeTime() { return this.json<FreeTimeRun>("/v1/free-time/trigger", { method: "POST", body: JSON.stringify({ manual: true }) }); }
  listFreeTimeRuns() { return this.json<FreeTimeRun[]>("/v1/free-time/runs"); }
  saveFreeTimeOutcome(id: string, payload: { summary: string; valence?: number; arousal?: number; completedAt?: string }) {
    return this.json<FreeTimeRun>(`/v1/free-time/runs/${encodeURIComponent(id)}/outcome`, { method: "PUT", body: JSON.stringify(payload) });
  }
  markFreeTimeActivity(at = new Date().toISOString()) { return this.json<{ at: string }>("/v1/free-time/activity", { method: "PUT", body: JSON.stringify({ at }) }); }
  notificationPublicKey() { return this.json<{ publicKey: string }>("/v1/notifications/public-key"); }
  subscribeNotifications(subscription: PushSubscriptionJSON, preferences: unknown) { return this.json<{ subscribed: true }>("/v1/notifications/subscribe", { method: "POST", body: JSON.stringify({ subscription, preferences }) }); }
  unsubscribeNotifications(endpoint: string) { return this.json<{ removed: number }>("/v1/notifications/subscribe", { method: "DELETE", body: JSON.stringify({ endpoint }) }); }
  testNotification() { return this.json<{ sent: number; removed: number; skipped: number }>("/v1/notifications/test", { method: "POST", body: "{}" }); }
  musicStatus(refresh = false) { return this.json<MusicStatus>(`/v1/music/status${refresh ? "?refresh=true" : ""}`); }
  createMusicQr() { return this.json<MusicQrLogin>("/v1/music/login/qr", { method: "POST", body: "{}" }); }
  checkMusicQr(key: string) { return this.json<MusicQrState>(`/v1/music/login/qr/${encodeURIComponent(key)}`); }
  disconnectMusic() { return this.json<{ connected: false }>("/v1/music/session", { method: "DELETE", body: "{}" }); }
  listMusicPlaylists() { return this.json<MusicPlaylist[]>("/v1/music/playlists"); }
  listMusicTracks(playlistId: string) { return this.json<MusicTrack[]>(`/v1/music/playlists/${encodeURIComponent(playlistId)}/tracks`); }
  musicPlayback(trackId: string, level = "standard") { return this.json<MusicPlayback>(`/v1/music/tracks/${encodeURIComponent(trackId)}/playback?level=${encodeURIComponent(level)}`); }
}
