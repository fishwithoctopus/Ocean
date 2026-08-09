# Ocean integration audit

Audited against the working tree on 2026-07-20. A clickable control is not considered integrated until its source of truth, server boundary, response contract, persistence path, offline behavior, and failure state are all explicit.

## State vocabulary

- `real`: the production-shaped path is implemented and talks to its intended service.
- `staging`: the contract and durable intermediary exist, but the final service or production store is not connected.
- `mock`: the interaction is intentionally simulated.
- `unconfigured`: the implementation boundary exists but runtime configuration is missing.

The Gateway exposes the same vocabulary through `GET /v1/integrations`. UI copy must not call `staging` data “saved to Memory 3.0”.

## Screen and service matrix

| Surface | Current source of truth | Gateway or adapter contract | State | Next acceptance test |
| --- | --- | --- | --- | --- |
| Living-room chat | Gateway provider stream plus server-side Memory recall when live mode is enabled; local mock fallback | `POST /v1/chat/stream` | `real` | Stream text, optional reasoning, usage and cache tokens; verify relevant Memory context is injected after the stable prefix |
| Chat attachments | System camera/image picker, local TXT/Markdown/JSON/CSV, optional provider-neutral connectors | `attachments[]` on `POST /v1/chat/stream` | `real` for supported formats | Device-test one photo and one text file on each capable provider |
| Provider/model picker | Gateway provider registry | `GET /v1/providers`, `GET /v1/models`, provider test | `real` | Select and test DeepSeek, Kimi and Qwen without exposing keys to the browser |
| Usage ledger | Normalized stream events plus built-in/configured prices | `usage` NDJSON event | `real` with estimates | Reconcile one provider invoice sample; label estimated cost as estimated |
| Scoped conversations | Browser local-first state plus persistent Gateway JSON store; fresh-device restore only fills empty local scopes and preserves pending/local content | `GET/POST /v1/conversations`, `GET /v1/continuities` | `staging` storage, `real` single-device restore | Device-test a fresh install; verify living/project/reading/meeting scopes and Forge state restore without overwriting a non-empty local scope |
| Session forge | Persistent Gateway continuity state with local fallback; a real rotation stages one reviewable event candidate | `POST /v1/continuity/forge` | `real` | Device-test one automatic rotation, compare the first post-forge answer, and verify one deduplicated candidate |
| Memory candidates | Browser outbox, validated boundary events, Gateway candidate store and optional MCP `hold` commit | `GET/POST /v1/memory/candidates`, `POST /v1/memory/events` | `real` in explicit/direct mode; otherwise `staging` | Verify explicit save plus Forge/project/book/meeting candidates without duplicates; surface external ID/failure state |
| Home countdowns and todos | Browser local-first state plus Gateway home snapshot | `GET/PUT /v1/home` | `staging` | Restore edits on a second device and resolve concurrent writes |
| Home emotional calendar | Memory daily impressions with safe demo fallback | `GET /v1/memory/daily-impressions` | `real` when configured | Verify month boundaries and intensity mapping on device |
| Home paper notes | Previous-day Memory daily impression plus a real Gateway model | `GET /v1/paper-notes`, `POST /v1/paper-notes/generate` | `real` when Memory and a provider are configured | Verify one four-note package, progressive time-window reveal, restart persistence and one Web Push delivery |
| Palace memory/search | Memory MCP pulse/read/breath with safe demo fallback | buckets, detail, semantic search, evidence chain and four-block portrait | `real` for buckets, search, evidence, portrait and daily impressions when configured | Verify candidate acknowledgement and portrait manual-override policy |
| Co-reading | Gateway REST proxy, in-app EPUB/TXT/Markdown import, per-book provider conversation and Forge state, with local Mock fallback | `/v1/reading/*`, `POST /v1/chat/stream`, scoped conversation | `real` when configured | Device-test one EPUB import, two books, one page question and one pushed annotation; verify refresh, histories and page-context ledgers stay isolated |
| Forum | Server-only companion account through Community v2 MCP; free-time exposes browse only | `FORUM_MCP_URL`, `FORUM_MCP_AUTH_TOKEN`, `GET /v1/forum/health`, local `browse_forum` model tool | `real` when configured, read-only | Verify a real latest-thread result is returned and a narrated browse without a tool call is rejected; confirm no write/interaction tool is exposed |
| Project registry and workspace | Persistent Gateway project store plus one server project directory per `projectId`, shared by Project and Meeting | `GET/POST /v1/projects`, `PATCH/DELETE /v1/projects/:id`, `/v1/projects/:id/workspace`, `/documents`, `/files` | `real` for the current single-server deployment | Create a project, save its brief/document/file, reload, then verify the same project and context appear in Meeting |
| Project chat | Shared provider stream with local Mock fallback, isolated per project | `POST /v1/chat/stream`, scoped conversation and Forge state | `real` | Device-test two projects and verify neither history nor Forge summary crosses scopes |
| Poetry | Browser local-first poems plus Gateway poetry archive; pushing reuses the current `living-main` model, history, Forge state and Usage path | `POST /v1/chat/stream`, `POST /v1/conversations` for `poetry:shared` and `living-main` | `real` for current-device push and response; cross-device poem CRUD remains `staging` | Push one selected poem on device, verify it and the current model response appear in the existing living-room session, then verify the poem archive copy reaches Gateway |
| Meeting | Gateway model registry plus sequential client orchestration | Existing `POST /v1/chat/stream`, isolated `meeting:<projectId>` conversation | `real` when at least two approved models are connected | Device-test GPT participant + Opus host, then add Kimi/Sonnet; verify failure skips only one participant and confirmed minutes create one candidate |
| Free-time rules and activity history | Gateway scheduler config, run store and explicit outcome writeback | `/v1/free-time/*`, `PUT /v1/free-time/runs/:id/outcome` | `real` | Verify quiet hours, cooldown, active hours, probability, pause, completed summary and V/A audit |
| Free-time dispatch | Independent model dispatcher or optional webhook | `FREE_TIME_PROVIDER_ID`, `FREE_TIME_MODEL_ID`, `FREE_TIME_AUTO_DISPATCH`, `FREE_TIME_DISPATCH_URL` | `real` for manual runs; automatic disabled by default | Verify one enabled Can Do action, persisted result/V-A/usage/cost; enable automatic dispatch only after cost review |
| Notifications | Installed-PWA permission, persistent Push Subscription, test, free-time and due paper-note delivery | `/v1/notifications/*`, service worker `push`/`notificationclick` | `real` | Verify one scheduled paper-note notification on iPhone after deployment |
| Music | Server-side NetEase QR session, real playlists/tracks, short-lived playback URLs, touch wheel and playback controls | `/v1/music/*` with server-only persisted cookie | `real` | iPhone QR login, playlist switching, playback, pause/resume, next track and playback modes verified; monitor upstream API compatibility |

## Conversation and memory policy already decided

- Ordinary chat, each project, each co-reading book, and each meeting use separate conversation scopes.
- Free-time activity shares the ordinary-chat scope.
- Long-term memory remains owned by Memory 3.0 rather than the conversation store.
- Ordinary chat may propose memory on a threshold, model relevance judgment, or explicit user request.
- Co-reading stages one deduplicated candidate when the final reading block is marked complete.
- Projects propose memory on a threshold or explicit user request.
- Meeting minutes stage a candidate only when the user presses Save Minutes; they do not auto-commit.
- Session forge keeps a stable logical conversation, rotates the physical backend session, injects a summary plus the latest 20 original turns, and must remain visually seamless.
- Stable prompt prefixes must not contain per-request timestamps; dynamic time facts belong near the end of the request to protect provider cache hits.

## Product decisions still open

These are intentionally not guessed in code:

1. Whether to enable an optional model-authored Forge summary after measuring the deterministic summary; default remains no-cost.
2. Home conflict policy when two devices edit todos or countdowns while offline.
3. Production push provider and notification permission flow.

## P0/P1 execution order

1. Keep the real single-provider living-room slice stable across DeepSeek, Kimi and Qwen.
2. Verify portrait candidate acknowledgement/manual overrides and one explicit-write acknowledgement test.
3. Keep the completed shared Project/Meeting workspace stable: briefs, documents, files and confirmed meeting minutes now persist in the Gateway project-directory boundary.
4. Keep the completed four-window paper-note contract stable: daily-impression derivation, idempotent Gateway storage, progressive reveal and Web Push delivery.
5. Configure and test free-time dispatch in the ordinary-chat scope.
6. NetEase Cloud Music uses server-side QR login, persisted server-only cookies, real playlists/tracks and short-lived playback URLs. QR login and iPhone playback/control testing are complete; meeting orchestration now uses the approved live model registry and sequential round control.

## Security boundary

- The PWA may receive public provider/model/capability manifests and masked integration status.
- API keys, connector tokens and Memory credentials stay in the Gateway environment or a later encrypted secret store.
- Production exposes HTTPS `443`; raw Gateway and internal-service ports remain private.
- Portable exports never include credentials.
- Production deploys preserve the existing server-side provider environment instead of overwriting it with a workstation snapshot; provider secrets are restored once after the migration and then survive subsequent app releases.
- Project, reading and meeting duration labels use separate local-calendar-day buckets. They begin at zero, advance only while that mode is foreground-visible, roll over at local midnight, and never use demonstration hours.
