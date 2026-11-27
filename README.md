# mx-GPT & mx-Cowork — Self-Hosted Private AI Workspace & Local Desktop Coworker

**mx-GPT** is a fast, zero-build, self-hosted ChatGPT-class web workspace designed for semi-public and LAN deployments on Ollama (plus optional OpenAI-compatible remote providers). It ships alongside **mx-Cowork**, a standalone local desktop coworker app for **Linux** and **Windows (`.exe`)** built for research, email drafting, and local file search & management.

- **Three Intelligent Execution Modes (`Fast` · `Smart` · `Copilot`)**:
  - **Fast (`lfm3:latest`, 1.7B)** — Instant responses, quick lookups, and fast rewrites (~27 tok/s on CPU).
  - **Smart (`inkling-2-mini:latest`, 26B)** — Deep reasoning, coding, and synthesis.
  - **Copilot (Hybrid Orchestrator in mx-Cowork)** — Uses the **Smart** model to plan and synthesize while delegating heavy local file scanning, PDF/DOCX reading, folder auditing, and web research distillation to the **Fast** model.
- **CPU-Aware Multi-Request Inference Scheduler (`deploy/ollama-queue.cjs`)** — Eliminates cross-model thread thrashing on multi-user CPU hosts via an exclusive execution gate, a Fast/Subagent priority lane with anti-starvation aging, fair per-user round-robin, instant dequeue on cancel, and real-time `Queued #N` UI feedback.
- **Sub-3B Subagents & Live Artifacts** — Multi-role `<3B` subagent cards (`Coder`, `Researcher`, `Analyst`, `Summarizer`, `Helper`) with live Markdown streaming, detached server-side background chat runs, and smooth live HTML/SVG/JSX/Mermaid artifact preview.
- **LAN-Only Ollama Administration** — Runtime tuning and model management (`/api/ollama/*`) are blocked with `403` on public proxies (Cloudflare Tunnel / gateway / containers) and accessible only from the local network.
- **Standalone Desktop Coworker (`mx-cowork-linux-x64` & `mx-cowork-win-x64.exe`)** — Native local workspace search (`.pdf`, `.docx`, `.xlsx`, `.md`, code), approval-gated & undoable file management, built-in Email Drafting Studio with RFC-5322 `.eml` export, and a local Research Desk.

> **Manuals:** See the [Installation & Operations Manual](./docs/MANUAL.md), [mx-Cowork Desktop Guide](./docs/COWORK.md), and [Architecture & Performance Guide](./docs/ARCHITECTURE.md).  
> **License:** MIT — see [LICENSE](./LICENSE).

---

## System Architecture

```mermaid
flowchart LR
    U1["Web Users (HTTPS / LAN)"] --> GW["Gateway / mx-GPT (:8088)"]
    U2["mx-Cowork Desktop\n(Linux / Windows .exe)"] -->|"Fast / Smart / Copilot"| GW
    U2 -->|"Direct LAN (optional)"| Q
    U2 -->|"Local Files · Research · .eml"| OS["Local OS Workspace"]
    GW --> Q["CPU-Aware Queue Scheduler\ndeploy/ollama-queue.cjs (:11435)"]
    Q -->|"1 active inference\nFast priority + fair RR"| OL["Ollama (:11434)\n20 phys cores · NUMA interleave"]
    LAN["LAN Admin Only"] -->|"403 on Public/Proxy"| OL
```

---

## One-Time Setup & Quick Start

### Option 1: Native Desktop Coworker App (Linux & Windows — Zero WebUI)

Download the native Electron desktop application directly from **[GitHub Releases](https://github.com/mxsp/mxgpt/releases)** — styled identically to the `mx-GPT` web workspace, with built-in login (`https://max.fyreflysystems.de` default), multi-provider switching, local OS file navigation & live editing, and a built-in GitHub Release updater:

- **Windows:** Extract `mx-Cowork-1.8.1-win-x64.zip` and double-click `mx-Cowork.exe`.
- **Linux (AppImage — supports automatic in-app update & restart):**
  ```bash
  chmod +x mx-Cowork-1.8.1.AppImage
  ./mx-Cowork-1.8.1.AppImage
  ```
- **Linux (Debian / Ubuntu / Kali `.deb`):**
  ```bash
  sudo apt install ./mx-cowork_1.8.1_amd64.deb
  ```
- On launch, sign in to **`https://max.fyreflysystems.de`** (default) or switch to **Other Provider** (**OpenCode Go**, OpenAI, Anthropic, OpenRouter, Groq, Google Gemini, Mistral, Direct Ollama, LM Studio, or any OpenAI-compatible API).

### Option 2: CLI One-Time Setup Script (Linux / macOS / Windows)

Requires **Node.js 20+** and an Ollama server (local or LAN):

**Linux / macOS:**
```bash
git clone https://github.com/mxsp/mxgpt.git
cd mxgpt
./scripts/setup.sh
```

**Windows (PowerShell):**
```powershell
git clone https://github.com/mxsp/mxgpt.git
cd mxgpt
.\scripts\setup.ps1
```

Pull the recommended Fast & Smart models on your Ollama host:
```bash
ollama pull lfm3:latest
ollama pull inkling-2-mini:latest
```

Start the stack:
```bash
node deploy/ollama-queue.cjs   # Smart CPU-aware inference scheduler (:11435 -> :11434)
node server/server.js          # mx-GPT web workspace -> http://127.0.0.1:8088
(cd cowork && npm install && npm start)  # mx-Cowork native desktop app
```

### Option 3: Docker Compose (mx-GPT + Inference Queue Scheduler)

```bash
cp .env.example .env
# Edit .env to set OLLAMA_HOST_IP, MXGPT_NUM_THREAD, and AUTH_REQUIRED
docker compose up -d --build
```

Open `http://127.0.0.1:8088` in your browser.

### Option 4: Build Standalone Cowork Binaries from Source

```bash
./scripts/build-cowork.sh
```

Produces `dist/mx-cowork-linux-x64.tar.gz`, `dist/mx-cowork-windows-x64.zip`, `dist/mx-cowork-win-x64.exe`, and `dist/SHA256SUMS.txt`.

---

## Key Features

### mx-GPT Web Workspace (`server/` & `public/`)
- **Fast / Smart Mode Switcher** with calibrated thinking effort (`Off`, `Low`, `Med`, `High`) and native Inkling 2 Mini level mapping.
- **Smart Per-Group Tool Routing & KV-Cache Preservation**: Only injects Web, Utility (`calculate`, `get_datetime`, `run_js`), Notes, or Subagent schemas when the prompt needs them, and keeps tool groups sticky per chat so Ollama context checkpoints hit cleanly (cutting TTFT up to 10–20× on CPU).
- **Detached Background Runs**: Switch chats or refresh the browser without interrupting generation; live status & quick hover-stop right in the sidebar (no intrusive floating banners).
- **Upgraded Sub-3B Subagents Panel**: 2-column responsive role-colored cards with live Markdown streaming, tool chips, tok/s stats, and copy buttons.
- **Live Streaming Artifacts**: Clean building card + live code stream transitioning smoothly to live HTML/SVG/JSX/Mermaid preview.
- **Usage & Analytics (`/api/usage`)**: Per-user token and throughput tracking.

### mx-Cowork Native Desktop App (`cowork/`)
- **Identical `mx-GPT` Visual Design + Native Login**: Warm parchment / charcoal UI matching `mx-GPT`, with a built-in login screen pre-configured for **`https://max.fyreflysystems.de`** and 1-click switching to **OpenAI**, **Anthropic**, **OpenRouter**, **Groq**, **Google Gemini**, **Mistral**, **Direct Ollama**, **LM Studio**, or any OpenAI-compatible endpoint.
- **4 Execution Modes (`Fast` · `Smart` · `Copilot` · `Copilot (B)`)**: `Copilot` uses your Smart model (`inkling-2-mini`) as orchestrator + Fast workers; **`Copilot (B)`** uses **`nemotron-3.5-lightning`** (configurable) as orchestrator + Fast workers.
- **Container Code Execution (`Docker` / `Podman`)**: Isolated ephemeral containers mounted at `/workspace` (`--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--network=none` default, RAM/CPU limits, live streaming output, 1-click Stop). Models propose approval-gated `code-run` cards in chat, or run Python / Node.js / Bash directly in the **Container** tab.
- **Interactive Project Knowledge Graph**: Force-directed visual map of local files, folders, imports, Markdown links, external packages, and extracted symbols — with zoom/pan, node drag, search spotlight, type filters, fullscreen expand, clickable node inspector (`Edit`, `Pin`, `Ask Cowork`), and AI architectural summaries.
- **OS File Navigation, Live Editor & Local Copilot Tools**: Browse anywhere on your OS, search filenames & contents (`.pdf`, `.docx`, `.xlsx`, `.md`, code), edit files live (`Ctrl+S` with automatic **1-click Undo**), plus **Git Inspector**, **System & Runtimes Info**, **Sandboxed JS Evaluator**, **Persistent Memory Notes**, **Web Search / URL Reader**, and granular **Tool Settings**.
- **Built-in Software Updater (Gimel-style)**: Checks `mxsp/mxgpt` Releases, verifies `SHA256SUMS.txt`, and supports 1-click self-update & relaunch on Linux AppImage and Windows (plus verified `.deb` download).

---

## Repository Layout

```text
server/                 mx-GPT Node.js backend (zero build, pure stdlib)
  server.js             HTTP/SSE router, detached background runs, smart tool routing
  ollama.js             Ollama client with /api/tags TTL cache, queue events, Inkling think calibration
  subagents.js          Sub-3B subagent runner with warm Fast-model preference
  tools.js              17 compact built-in tools (web, calc, JS sandbox, notes, files, subagents)
  browser.js            Cached web search, deep research, and clean HTML reader
  config.js             Unified num_ctx / num_thread configuration & LAN-only guards
  store.js              Chat persistence & per-user token usage statistics
public/                 mx-GPT SPA frontend (index.html, app.js, styles.css, login.html)
cowork/                 mx-Cowork local desktop coworker (Linux + Windows .exe)
  src/copilot.js        Fast / Smart / Copilot hybrid orchestration engine
  src/endpoint.js       Dual-mode client (authenticated mx-GPT remote or direct Ollama)
  src/local-files.js    Pure-JS PDF/DOCX/XLSX/text search & undoable file manager
  src/email.js          RFC-5322 .eml generator & AI email refinement tools
  src/research.js       Local DuckDuckGo + Wikipedia + page reader
  public/               3-pane desktop UI (Copilot cards, Files, Email Studio, Research, Undo)
deploy/                 ollama-queue.cjs scheduler & systemd service units
scripts/                setup.sh, setup.ps1, build-cowork.sh
docs/                   MANUAL.md, COWORK.md, ARCHITECTURE.md
```

---

## Documentation

- [Installation & Operations Manual](./docs/MANUAL.md)
- [mx-Cowork Desktop App Guide](./docs/COWORK.md)
- [Architecture & CPU Performance Guide](./docs/ARCHITECTURE.md)
- [Security Policy](./SECURITY.md)
- [Contributing](./CONTRIBUTING.md)

---

## License

Copyright (c) 2026 FyreFly Systems / mxsp. Licensed under the [MIT License](./LICENSE).
