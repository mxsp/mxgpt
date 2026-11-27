# mx-Cowork — Native Desktop AI Coworker (Linux & Windows)

**mx-Cowork** is a native Electron desktop application (zero local web server, zero browser tabs) matching the visual design of the **mx-GPT** web app, upgraded with direct OS file navigation & live editing, built-in login (`https://max.fyreflysystems.de` default), multi-provider support, and a built-in GitHub Release updater.

## Modes
- **Fast (`lfm3:latest`)** — Instant replies, quick file lookups, and fast rewrites.
- **Smart (`inkling-2-mini:latest`)** — Direct deep reasoning and writing.
- **Copilot (Hybrid Orchestrator)** — **Smart** plans & decomposes the task, delegates heavy local file searching, PDF/DOCX/XLSX reading, folder auditing, and web research distillation to the configured **Subagent / Worker** model, then synthesizes the result and generates undoable File Actions, Container Code Runs, and live Artifacts.
- **Copilot (B) (`nemotron-3.5-lightning`)** — Alternate hybrid orchestrator using `nemotron-3.5-lightning` with local tools & Fast workers.

## Features
- **Live Artifact Display Canvas**: Automatically opens in the right panel whenever Copilot streams HTML, SVG, React/JSX, or Mermaid blocks — showing live code while building and flipping straight to an interactive sandboxed Preview when finished, with Copy, Save As, Open in Browser, and Refresh actions.
- **WebUI-Aligned Settings (Models, Providers & Token Usage)**: Configure per-role models (**Fast**, **Smart**, **Copilot B**, **Subagent Worker**, **Graph Mapper**), default mode/thinking depth, and global custom instructions; save and 1-click switch reusable **Provider Profiles** (`mx-GPT`, OpenAI, Anthropic, OpenRouter, Groq, Gemini, Mistral, Direct Ollama, LM Studio, custom OpenAI-compatible APIs); and inspect local **Token Usage Statistics** (KPI cards, 14-day chart, breakdowns by model, role, and chat).
- **First-Class Projects & Workspace Rules**: Manage projects with local paths, custom colors, custom instructions, **Auto-Accept Edits** toggle (with 1-click Undo), container overrides, and automatic background **Fast-model Knowledge Graph** mapping.
- **Interactive Project Knowledge Graph**: 3 layouts (**Force** with cluster zones, **Radial** hubs, **Hierarchy** tree), curved Bezier edges, Fast-model semantic roles & links, clickable inspector (`Edit`, `Pin`, `Ask Cowork`), and fullscreen mode.
- **OS Navigation, Find & Built-in File Editor**: Navigate any local OS folder, search filenames & contents (`.pdf`, `.docx`, `.xlsx`, `.md`, code), create/rename/delete files, and edit directly in-app (`Ctrl+S`) with automatic **1-click Undo** snapshots.
- **Container Code Execution (`Docker` / `Podman`)**: Run Python, Node.js, or Shell scripts inside hardened ephemeral containers mounted at `/workspace` (`--cap-drop=ALL`, `--network=none` default, memory/CPU caps, live streaming output).
- **Automatic Software Updater**: Checks `mxsp/mxgpt` GitHub Releases, verifies `SHA256SUMS.txt`, and supports automatic in-app install & restart on Linux AppImage, Linux `.deb`, and Windows `.zip`.

## Running
- **Linux**: Download `mx-Cowork-1.5.0.AppImage` (`chmod +x` and run) or install `mx-cowork_1.5.0_amd64.deb` (`sudo apt install ./mx-cowork_1.5.0_amd64.deb`).
- **Windows**: Extract `mx-Cowork-1.5.0-win-x64.zip` and double-click `mx-Cowork.exe`.
- **From source**: `cd cowork && npm install && npm start`
