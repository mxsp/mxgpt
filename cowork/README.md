# mx-Cowork — Native Desktop AI Coworker (Linux & Windows)

**mx-Cowork** is a native Electron desktop application (zero local web server, zero browser tabs) matching the visual design of the **mx-GPT** web app, upgraded with direct OS file navigation & live editing, built-in login (`https://max.fyreflysystems.de` default), multi-provider support, and a built-in GitHub Release updater.

## Modes
- **Fast (`lfm3:latest`)** — Instant replies, quick file lookups, fast email rewrites (~27 tok/s).
- **Smart (`inkling-2-mini:latest`)** — Direct deep reasoning and writing.
- **Copilot (Hybrid Orchestrator)** — **Smart** plans & decomposes the task, delegates heavy local file searching, PDF/DOCX/XLSX reading, folder auditing, and web research distillation to **Fast**, then **Smart** synthesizes the result and generates ready-to-apply Email Drafts & undoable File Actions.

## Features
- **Built-in Login & Multi-Provider Support**: Connects to **`https://max.fyreflysystems.de`** by default with native sign-in, plus 1-click presets for **OpenAI**, **Anthropic Claude**, **OpenRouter**, **Groq**, **Google Gemini**, **Mistral**, **Direct Ollama**, **LM Studio**, and custom OpenAI-compatible APIs (with live model fetching).
- **OS Navigation, Find & Built-in File Editor**: Navigate any local OS folder (Quick folders, parent `↑`, direct path bar, native OS dialog), search filenames & file contents (`.pdf`, `.docx`, `.xlsx`, `.md`, code), create/rename/delete files, and edit files directly in-app (`Ctrl+S`) with automatic **1-click Undo** snapshots.
- **Container Code Execution (`Docker` / `Podman`)**: Run Python, Node.js, or Shell scripts inside hardened ephemeral containers mounted at `/workspace` (`--cap-drop=ALL`, `--network=none` default, memory/CPU caps, live streaming output, approval-gated inline chat cards + dedicated **Container** sandbox pane).
- **Interactive Project Knowledge Graph**: Zero-dependency force-directed canvas graph mapping local files, folders, imports, Markdown links, packages, and symbols — with zoom/pan, node drag, neighborhood highlight, fullscreen mode, clickable inspector (`Edit`, `Pin`, `Ask Cowork`), and AI architectural summaries.
- **Built-in Software Updater**: Checks `mxsp/mxgpt` GitHub Releases, verifies `SHA256SUMS.txt`, and supports 1-click download, verify & relaunch on Linux AppImage and Windows (and verified `.deb` download on Debian/Ubuntu).
- **Email Drafting Studio & Research Desk**: Auto-populated drafts from Copilot, 1-click AI refinements, native Save As `.eml`, direct OS Mail launching, and DuckDuckGo + Wikipedia research briefs with `.md` export.

## Running
- **Linux**: Download `mx-Cowork-1.3.0.AppImage` (`chmod +x` and run) or install `mx-cowork_1.3.0_amd64.deb` (`sudo apt install ./mx-cowork_1.3.0_amd64.deb`).
- **Windows**: Extract `mx-Cowork-1.3.0-win-x64.zip` and double-click `mx-Cowork.exe`.
- **From source**: `cd cowork && npm install && npm start`
