# Ocean

Ocean is a noncommercial source-available, self-hosted, provider-neutral PWA for continuous AI conversations. It combines a mobile interface with a server-side Gateway that owns model credentials, normalized streaming, scoped conversations, usage data, optional long-term memory, projects, reading sessions, meetings, notifications, music, and replaceable connectors.

The public repository contains no API keys, private connector tokens, personal memory database, poems, countdowns, Todos, or relationship history. Fresh installations start with empty user content.

> [!IMPORTANT]
> **DeepSeek V4 compatibility (2026-07-26):** DeepSeek retired the legacy API names
> `deepseek-chat` and `deepseek-reasoner` on 2026-07-24 15:59 UTC. Older
> Ocean Memory 3.0 deployments can therefore stop producing daily
> impressions, portraits, enrichment, and downstream Ocean paper notes. The
> current `fishwithoctopus/Ombre-Ocean-Memory` defaults use V4 model names.
> Existing deployments should apply the compatibility patch **only** when they
> use the official DeepSeek API and still report a legacy model or the
> documented HTTP 400 error. See the
> [Ocean Memory 3.0 migration and rollback guide](https://github.com/fishwithoctopus/Ombre-Ocean-Memory/blob/main/docs/DEEPSEEK_V4_MIGRATION.md).

## What is included

- Installable mobile PWA with day/night themes and reusable color tokens.
- OpenAI-compatible provider registry for services such as OpenRouter, DeepSeek, Kimi, and Qwen.
- Streaming chat with paragraph bubbles, optional reasoning status, usage, cache, attachments, and retry/copy controls.
- Scoped conversations for the living room, projects, books, and meetings.
- Session Forge continuity: rotate physical sessions while retaining a summary and recent original turns.
- Project workspaces, co-reading, poetry, multi-model meetings, free-time scheduling, Web Push, and NetEase Cloud Music adapters.
- Optional Memory 3.0 integration for recall, explicit writes, buckets, evidence chains, portraits, and daily impressions.
- Empty-by-default game library with a documented adapter boundary.

## Optional rooms and customization

Ocean's rooms are product modules, not requirements for every deployment. The Study Room currently groups projects, co-reading, poetry, and multi-model meetings; Leisure, Palace, music, notifications, games, and external service adapters can also be omitted when a deployment does not need them.

These modules are not yet exposed as one-click feature flags. When preparing a customized fork, a coding agent can remove an unused module. Ask it to remove the navigation entry, routes, UI components, persistent stores, Gateway endpoints, model tools, background jobs, assets, environment variables, tests, and documentation together. Hiding only the tab is not sufficient because it can leave unused credentials or capabilities running on the server.

For example:

> Remove Poetry from this fork. Delete its navigation and UI, poetry data stores, related Gateway routes and model tools, assets, environment and documentation references, then run the full build and smoke-test suite. Preserve shared Study Room components used by the remaining modes.

## Architecture

```text
PWA (browser / installed app)
        |
        | HTTPS + NDJSON/JSON
        v
Ocean Gateway
  |-- model providers
  |-- conversation and project stores
  |-- notifications and scheduler
  |-- optional service adapters
  `-- Memory 3.0 MCP (optional, separately deployed)
```

Secrets stay in the Gateway environment. The browser receives public provider/model manifests and normalized responses, never raw API keys or private MCP tokens.

## Requirements

- Node.js 20 or newer
- npm
- HTTPS for an installed PWA and Web Push in production
- At least one configured model provider for real chat

Python is only required when a deployment enables a Python-backed optional game adapter.

## Local setup

```powershell
npm ci
Copy-Item .env.example .env
npm run build
npm run server:local
```

In a second terminal:

```powershell
npm run dev
```

Vite prints the local PWA URL. The Gateway listens on its configured server port (the default development port is `8787`). Configure the client Gateway URL according to the deployment environment.

Do not put provider keys in client-side `VITE_*` variables. Copy `.env.example`, fill only the server-side providers and services you use, and keep the resulting `.env` file private.

## Model providers

Providers are defined through Gateway environment variables and exposed to the UI through the provider/model registry. Ocean normalizes OpenAI-compatible chat streams but keeps provider-specific model IDs, reasoning options, token usage, cache statistics, and prices explicit.

Start with one inexpensive provider, verify streaming and Usage, then add further providers. A provider that is not configured does not appear as a working capability.

## Memory 3.0

Ocean integrates with Memory 3.0 over Streamable HTTP MCP. Its separately
published companion implementation is
[fishwithoctopus/Ombre-Ocean-Memory](https://github.com/fishwithoctopus/Ombre-Ocean-Memory),
derived from [Yinglianchun/Ombre-Brain](https://github.com/Yinglianchun/Ombre-Brain)
and [P0luz/Ombre-Brain](https://github.com/P0luz/Ombre-Brain).

The Ocean repository does not embed or redistribute the Ombre-Brain backend.
Memory 3.0 is a separately deployed service connected through the replaceable
server-side adapter. A production deployment may use a private customized fork
while keeping the same MCP boundary.

Deploy the memory service independently with persistent storage, then configure:

```dotenv
OCEAN_MEMORY_MCP_URL=https://memory.example.com/mcp
OCEAN_MEMORY_AUTH_TOKEN=
OCEAN_MEMORY_WRITE_MODE=staging
OCEAN_CHAT_MEMORY_RECALL=enabled
```

Write modes:

- `staging`: create reviewable Gateway candidates; do not commit automatically.
- `explicit`: commit only explicit remember/hold requests.
- `direct`: also allow configured automatic threshold candidates to commit.

Conversation history and long-term memory are separate. Changing chat models does not change the logical conversation scope or ownership of the memory database.

## Optional services

- Co-reading MCP: separately deployed; configure its server-only endpoint.
- Notion: optional one-way project mirror through an internal integration.
- NetEase Cloud Music: server-side QR session and short-lived playback URLs.
- Web Push: configure a VAPID key pair and contact subject.
- Games: the library is empty by default. Add only adapters whose upstream license and deployment model you have reviewed. See [docs/OPTIONAL_CONNECTORS.md](docs/OPTIONAL_CONNECTORS.md).

## Persistence and privacy

- Gateway runtime data is stored under `server/data/` and is ignored by Git.
- Local `.env*` files, connector sources, deployment keys, temporary files, generated pet runs, and personal planning documents are ignored.
- Before publishing a fork, scan the full tree and Git history for secrets and private seed content.
- Public sample configuration contains placeholders only.

## Verification

```powershell
npm run build
npm run server:smoke
npm run server:provider-smoke
npm run server:auth-smoke
npm run server:notion-smoke
```

Also perform device tests for PWA installation, safe areas, keyboard recovery, offline reconnection, attachments, notifications, and any optional connector enabled by the deployment.

## Deployment

Build the client and Gateway, serve the PWA over HTTPS, keep the Gateway and internal connector ports private, and pass secrets through the server environment. Preserve persistent Gateway and Memory volumes across releases.

## License

Ocean is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may use, deploy, study, modify, and redistribute Ocean for permitted noncommercial purposes under that license.

Commercial use, paid hosting, resale, or incorporation into a revenue-generating product or service requires separate written permission from the copyright holder. Ocean is therefore source-available rather than OSI-certified open-source software.

Optional dependencies, assets, model services, and connectors keep their own licenses and terms. Ocean's license does not grant additional rights to those third-party components or services.
