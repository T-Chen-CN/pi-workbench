# Pi Workbench

Lightweight desktop code editor with Pi Agent integration, built with Electron + React.

**Version**: 0.6.3 · **Status**: Phase 6 ongoing · **Updated**: 2026-10-27

---

## Features

- **Code editor** — Monaco Editor with multi-tab editing, per-file undo history and 2s debounced auto-save
- **File explorer** — browse, create, rename, delete; live refresh via file watching
- **AI chat** — real Pi Agent with read / write / edit / bash tools, streaming output and token usage
- **Diff viewer** — files the agent modified appear as inline change cards in the reply; open a per-file diff on demand
- **Terminal** — xterm.js + node-pty, with output attachable to the agent
- **Workspace plugins** — command and hook extensions loaded in the main process (opt-in per workspace)
- **Paper & Ink UI** — light/dark themes, local fonts, consistent design tokens
- **Crash recovery** — unsaved editor drafts are restored after an unexpected exit
- **Auto update** — silent check on launch; Windows / Linux download automatically but only install on request; macOS checks and links to the release page
- **Flexible providers** — any OpenAI-compatible endpoint (DeepSeek, gateways…)
- **Model discovery** — fetch the real model list from the provider and pick one
- **Secure config** — API keys encrypted at rest with Electron `safeStorage`
- **Session persistence** — conversations resume across restarts per workspace
- **Self-contained data** — all data lives next to the executable (`config/`, `cache/`, `data/`, `logs/`); on macOS it lives in `~/Library/Application Support/pi-workbench` because the app bundle is read-only
- **Bilingual UI** — Chinese / English

---

## Requirements

- **Node.js ≥ 24** (Electron 44 bundles Node 24; node:sqlite is used for workspace history)
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

Output: `release/` — Windows builds produce an NSIS installer.
See [BUILD_AND_PACKAGE.md](docs/guides/BUILD_AND_PACKAGE.md).

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

## Data locations (self-contained)

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
- [Backlog (closed; platform acceptance pending)](docs/progress/BACKLOG.md)
- [Roadmap v1 (completed)](docs/progress/ROADMAP.md)
- [Phase 1 report](docs/progress/PHASE-1-COMPLETE.md)

Chinese README: [README_ZH.md](README_ZH.md)

---

## License

See [LICENSE](LICENSE).
