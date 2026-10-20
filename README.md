# Pi Workbench

Lightweight desktop code editor with Pi Agent integration, built with Electron + React.

**Version**: 0.1.0 · **Status**: Phase 1 complete · **Updated**: 2026-10-20

---

## Features

- **Code editor** — Monaco Editor with multi-tab editing and 2s debounced auto-save
- **File explorer** — browse, create, rename, delete; live refresh via file watching
- **AI chat** — real Pi Agent with read / write / edit / bash tools
- **Diff viewer** — automatically shows files the agent modified during a turn
- **Flexible providers** — Anthropic, OpenAI, or any OpenAI-compatible endpoint (DeepSeek, gateways…)
- **Model discovery** — fetch the real model list from the provider and pick one
- **Secure config** — API keys encrypted at rest with Electron `safeStorage`
- **Session persistence** — conversations resume across restarts per workspace
- **Portable** — all data lives next to the executable (`config/`, `cache/`, `data/`, `logs/`)
- **Bilingual UI** — Chinese / English

---

## Requirements

- **Node.js ≥ 22.19** (required by the Pi SDK; Electron 44 bundles Node 24)
- Windows, macOS, or Linux
- Git for Windows (optional — enables the agent's `bash` tool)

---

## Quick start

```bash
npm install
npm run dev        # builds bridge + main, then starts Vite + Electron
```

Web-only UI/agent debugging:

```bash
npm run web:dev
```

> In web mode the agent and file APIs run through Vite dev-server middleware
> (working directory = project root). Use Electron for the full application.

### Quality checks

```bash
npm run type-check
npm test
npm run lint
npm run build
```

### Package

```bash
npm run package:win
npm run package:mac
npm run package:linux
```

Output: `release/`. See [BUILD_AND_PACKAGE.md](docs/guides/BUILD_AND_PACKAGE.md).

---

## Configuration

Open **Settings** and configure:

1. **Provider** — Anthropic / OpenAI / Custom (OpenAI-compatible)
2. **API URL** — base endpoint, e.g. `https://api.deepseek.com/v1`
3. **API Key**
4. **Fetch Available Models** → select a model
5. **Save Configuration**

The API key is encrypted with the OS keystore via Electron `safeStorage`
(`enc:<base64>` in `config/api-config.json`). Plaintext keys are never written
to `models.json`; the agent reads the key from an environment variable.

---

## Project structure

```
electron/        Electron main process (main.ts, preload.cts)
src/             React renderer (components, stores, api, i18n)
pi-bridge/       Pi Agent bridge (AgentManager, runs in main process)
tests/           Vitest unit tests
docs/            Project documentation
```

Detailed architecture: [docs/architecture/PROJECT_STRUCTURE.md](docs/architecture/PROJECT_STRUCTURE.md)

---

## Data locations (portable)

```
{appDir}/config/    settings.json, api-config.json (encrypted key)
{appDir}/cache/     temporary files
{appDir}/data/      agent models.json + sessions
{appDir}/logs/      logs
```

Workspace data: `{workspace}/.pi-workbench/`

---

## Docs

- [Project plan](docs/PROJECT_PLAN.md)
- [Project structure](docs/architecture/PROJECT_STRUCTURE.md)
- [Build & packaging](docs/guides/BUILD_AND_PACKAGE.md)
- [Agent testing checklist](docs/guides/AGENT-TESTING.md)
- [Status](docs/progress/STATUS.md)
- [Phase 1 report](docs/progress/PHASE-1-COMPLETE.md)

Chinese README: [README_ZH.md](README_ZH.md)

---

## License

See [LICENSE](LICENSE).
