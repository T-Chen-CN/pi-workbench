<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
    <img src="docs/assets/banner-light.svg" alt="Pi Workbench — a local-first workbench with a real coding agent" width="880">
  </picture>
</p>

# Pi Workbench

A local-first desktop workbench where a real coding agent sits next to your editor — it reads, writes, edits and runs commands on your actual files, and the permission boundary is yours to set.

[![CI](https://github.com/T-Chen-CN/pi-workbench/actions/workflows/ci.yml/badge.svg)](https://github.com/T-Chen-CN/pi-workbench/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/T-Chen-CN/pi-workbench)](https://github.com/T-Chen-CN/pi-workbench/releases/latest)
[![License](https://img.shields.io/github/license/T-Chen-CN/pi-workbench)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-2b2b2b)](#download)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-2b2b2b)](package.json)

[简体中文](README.md) · **English** · [Download](#download) · [Docs](docs/README.md)

---

## Contents

1. [Highlights](#highlights)
2. [Download](#download)
3. [Getting started](#getting-started)
4. [Configuration](#configuration)
5. [Project status](#project-status)
6. [How it works](#how-it-works)
7. [Project structure](#project-structure)
8. [Contributing](#contributing)
9. [Docs](#docs)
10. [License](#license)

---

## Highlights

### The agent changes files — and only the ones you allow

Not "please don't touch anything" in a prompt, but a runtime boundary. The agent runs inside the main process, every tool call is checked against the session mode, anything that needs a decision raises an approval card, and a timeout counts as a refusal.

- **Four session modes**: read-only / plan / ask / full. Read-only denies instead of asking — there is no "I clicked allow and it wrote to disk" failure mode.
- **Plan mode makes it show its work first**: only read-only tools are enabled, and it must submit a plan card (steps, files at risk, risks). Approving flips the session into execution mode atomically and the plan becomes a live checklist.
- **Approvals cover four kinds of action** (read / write / command / other): allow once, for this session, always, or deny. Silence times out as a denial, it never just hangs.

### One session, one worktree — parallel tasks stop colliding

Switching tasks no longer means stash and copy. Bind a session to a Git worktree, every turn lands there, and the history is still there when you switch back.

- **The binding is on disk**: `.pi-workbench/session-git.json` remembers session ↔ worktree; switching takes effect only at turn boundaries, never mid-turn.
- **Dependencies install themselves**: the lockfile is detected (pnpm / bun / yarn / npm / uv), installs run serially in the background with a hard timeout, results are cached by hash — unchanged lockfiles are reused.
- **The Git panel covers all branches**: classified refs, merge markers, commit detail with per-file diffs, plus PR and CI status for the current branch.

### It actually opens your PDF, Word and Excel files

No MCP server, no "convert to Markdown first". The same `read` tool sniffs the format by magic bytes and hands back the actual content.

- **Six formats**: `.pdf` / `.docx` / `.xlsx` / `.pptx` / `.odt` / `.epub`, parsed with zero added dependencies.
- **Scans are not dropped**: PDFs without a text layer are rendered to images and go through the vision channel; legacy `.doc` / `.xls` / `.ppt` are not guessed at — you get a "save as" pointer instead.
- **Readable in the editor too**: Markdown / HTML rendering, image, audio and video preview, a self-drawn pdf.js reader (page navigation, 50%–400% zoom), and read-only Office previews.

### Every change is reviewable, and revertible one file at a time

The agent does not just say "done". Every file it touched in that turn shows up in the conversation — review the diff, or throw it away.

- **Inline change cards**: one per file, open the diff, revert one file or all of them; files with unsaved edits are refused rather than silently overwritten.
- **The process is visible**: thinking and tool calls render as a timeline with durations, arguments and result previews; `write` / `edit` jump straight to the diff.
- **History is not lost**: history and export read the session record (entry chain), so pre-compaction messages survive and the compaction marker lands on the turn where it happened.
- **You can change your mind**: queue or steer mid-turn, regenerate and switch branches, edit-and-resend a user message.

### Close the window; it keeps working

This is not an IDE plugin but a standalone workbench: closing the window only parks it in the tray, while sessions, file watchers and update checks keep running.

- **Workspaces stay resident**: switching tabs only toggles visibility — editors, diffs, terminal and agent sessions are all kept, not torn down.
- **Panels detach**: pull the file tree, Git view, chat or terminal into its own window; they share one store, and the terminal keeps its PTY and scrollback.
- **Context has a meter**: token usage and cost sit above the composer, with an optional budget cap; only 80% / 95% change colour.

### Local-first: your data stays on your machine

| Location                     | Contents                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `{appDir}/config/`           | `settings.json`, `api-config.json`, `web-search.json` (keys encrypted)                 |
| `{appDir}/data/`             | `models.json`, session records, `workspaces.db`                                        |
| `{appDir}/cache/`            | temp files, downloaded update packages                                                 |
| `{appDir}/logs/`             | `main.log`, `agent.log` (rotated at 5MB)                                               |
| `{workspace}/.pi-workbench/` | editor tabs, chat tabs, session extras, worktree binding, terminal logs, plugin config |

- API keys are encrypted with Electron `safeStorage` as `enc:<base64>`; plaintext never reaches disk, logs or the workspace.
- The renderer is sandboxed with no Node access; every IPC channel validates its sender; file operations are confined to trusted workspaces plus `{appDir}/cache/`.
- No telemetry, no account, fully offline-capable; web search is optional.
- On macOS the app bundle is read-only, so data lives in `~/Library/Application Support/pi-workbench`.

> **Everything else** (useful, but not the selling point): multi-tab Monaco editing with 2s debounced auto-save, file tree operations with live refresh, an xterm.js + node-pty terminal, command palette and workspace plugins, Paper / Ink themes, Chinese / English UI, crash-recovered drafts, auto-update.

---

## Download

Grab the installer for your platform from the [latest release](https://github.com/T-Chen-CN/pi-workbench/releases/latest).

| Platform | Asset                                  | Notes                                                                                |
| -------- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| Windows  | `Pi-Workbench-Setup-<version>.exe`     | NSIS installer; upgrades replace program files and keep `config/ data/ logs/ cache/` |
| macOS    | `Pi-Workbench-<version>-universal.dmg` | Universal binary (Apple Silicon + Intel)                                             |
| Linux    | `Pi-Workbench-<version>.AppImage`      | `chmod +x` and run                                                                   |

Builds are produced by GitHub Actions on a version tag. They are **not code-signed or notarized**, so the first launch triggers Windows SmartScreen or macOS Gatekeeper — confirm once.

Updates: a silent check runs 12 seconds after launch; Windows / Linux download in the background but **never install on their own** (you confirm), macOS only checks and links to the download. Upgrading replaces program files and leaves the data directories untouched.

---

## Getting started

### A. Install and run

Install, open, fill in the API settings once (next section). No Node, no extra runtime.

### B. From source

```bash
npm install
npm run dev        # builds the bridge + main process, then starts Vite + Electron
```

**Node ≥ 24** is required (Electron 44 bundles Node 24, and workspace history uses `node:sqlite`). The `bash` tool needs a real bash on the system (Git for Windows on Windows).

UI and agent debugging only (browser mode — files / Git / terminal are mocked):

```bash
npm run web:dev
```

### C. Package it yourself

```bash
npm run package:win
npm run package:mac
npm run package:linux
```

Artifacts land in `release/`. Building, signing, auto-update and troubleshooting: [BUILD_AND_PACKAGE](docs/guides/BUILD_AND_PACKAGE.md).

### Quality gates

```bash
npm run type-check
npm test           # 1,200+ Vitest cases
npm run lint
npm run build
```

---

## Configuration

Open **Settings** on first run and complete five steps:

1. **Provider** — Anthropic, OpenAI, or any OpenAI-compatible endpoint (DeepSeek, a gateway, a local server).
2. **API URL** — base endpoint, e.g. `https://api.deepseek.com/v1`.
3. **API key** — stored as `enc:<base64>` in `config/api-config.json` via `safeStorage`; the agent reads it from an environment variable at runtime.
4. **Fetch available models** — pull the provider's real model list, then set the context window (64K / 128K / 256K / 1M) and image capability per model.
5. **Web search** (optional) — pick one of ten providers; the key is encrypted into `config/web-search.json`.

---

## Project status

| Item            | State                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current version | `0.8.0` (2026-11-08)                                                                                                                                          |
| Releases        | 16 GitHub releases; installers and `latest*.yml` produced by CI on tags                                                                                       |
| Phases          | Phase 0–4 done · Phase 5 (Fleet background jobs) removed 2026-10-24 · Phase 6 ongoing                                                                         |
| Quality         | type-check + lint + 1,300+ Vitest cases + full build; CI also runs a Windows packaging smoke test                                                             |
| Stack           | Electron 44 · React 19 · TypeScript 5.9 · Monaco 0.57 · `@earendil-works/pi-coding-agent` 1.3                                                                 |
| Known limits    | Not signed or notarized; legacy Office formats are not parsed; no OCR for scans; Linux tray degrades to minimize; manual platform acceptance is still pending |

**In progress**: a top-level agent that orchestrates across workspaces (dispatching sub-sessions, delegated grants, headless workspaces) is still at the requirements-draft stage — see [TOP_LEVEL_AGENT_BRIEF](docs/requirements/TOP_LEVEL_AGENT_BRIEF.md). Current state is in [STATUS](docs/progress/STATUS.md); tasks and parked items in [BACKLOG](docs/progress/BACKLOG.md).

---

## How it works

```
Renderer (sandboxed, no Node)
  React + Zustand + Monaco
  window.electronAPI  ←  contextBridge  ←  preload
        │  IPC: every channel goes through handleIpc (sender-validated, fail-closed)
Main process (Electron 44 / Node 24)
  fs · dialogs · safeStorage · watchers · PTY · PDF / OOXML extraction
  AgentManager (pi-coding-agent) ──HTTP──> model provider
  read / write / edit / bash operate on the workspace directly
```

The agent never runs in a child process, a worker or an HTTP service — it is a main-process runtime. That is what makes permission enforcement, approval timeouts and worktree binding possible.

---

## Project structure

```
electron/     main process: IPC domains, agent registry, git, document extraction, terminal, updater
src/          renderer: components, stores, hooks, api (IPC wrappers), i18n, theme
pi-bridge/    AgentManager: sessions, tool policy and titles on top of pi-coding-agent
tests/        Vitest suites (flat, one file per source file)
docs/         project documentation
examples/     plugin examples (git-tools)
```

Process model, data flow and the IPC channel table: [PROJECT_STRUCTURE](docs/architecture/PROJECT_STRUCTURE.md).

---

## Contributing

- **Report a bug**: include reproduction steps and the relevant slice of `logs/main.log` / `logs/agent.log` (keys never reach the logs).
- **Send a PR**: run `npm run type-check` / `npm test` / `npm run lint` / `npm run build` first; UI changes must also pass `tests/design-system.test.ts`.
- **Translate**: UI strings live in `src/i18n/`; keep Chinese and English in sync.
- **Write a plugin**: start from [examples/plugins/git-tools](examples/plugins/git-tools); commands and hooks are documented in [PROJECT_STRUCTURE](docs/architecture/PROJECT_STRUCTURE.md).

Rules for agents working on this repo: [AGENTS.md](AGENTS.md). Copy guidelines: [PUBLIC_COPY](docs/guides/PUBLIC_COPY.md).

---

## Docs

- [Docs index](docs/README.md) — everything, indexed by task
- [Project plan](docs/PROJECT_PLAN.md) — positioning, process model, technical decisions
- [Project structure](docs/architecture/PROJECT_STRUCTURE.md) — code layout, data flow, IPC channels
- [Design system](docs/design/DESIGN_SYSTEM.md) — the single source of truth for color, type, spacing, components
- [Agent runtime](docs/agent/agent-runtime.md) — sessions, permissions, plans, tool policy, compaction, export
- [Git and worktrees](docs/agent/git-and-worktrees.md) — worktree binding, Git view, GitHub integration
- [Build & packaging](docs/guides/BUILD_AND_PACKAGE.md) — building, releasing, auto-update, troubleshooting
- [Status](docs/progress/STATUS.md) — what is done, per phase

---

## License

MIT — see [LICENSE](LICENSE). Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Chinese README: [README.md](README.md)
