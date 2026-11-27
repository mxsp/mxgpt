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
- **Pre-Send Follow-Up Queue & Live Copilot Cursor on `.xlsx` / `.csv` Spreadsheets**: Pre-send and queue follow-up messages while Copilot is still working (auto-dispatched in order when the current turn finishes), open any project Office document (`.xlsx`, `.csv`, `.docx`, `.pdf`) in 1 click from the Office Docs strip, edit Excel/CSV cells directly with automatic Undo, and watch the animated **Live Copilot Cursor** read and edit cells live on screen with full awareness of your open file and selected cell!
- **Nested Drag-and-Drop Projects (`Projects (chat 1, chat 2...)`) & Concurrent Multi-Model Streaming**: Organize chats inside collapsible projects via drag-and-drop (or drag OS folders into the sidebar to create projects), and run multiple models simultaneously across different chats without losing stream state when switching chats or tabs.
- **On-Machine (Host) & Container Code Execution**: Execute Python, Node.js, or Shell/PowerShell either inside hardened ephemeral Docker/Podman containers (`--cap-drop=ALL`, `--network=none`) OR directly **On-Machine** in your workspace.
- **2-Tier Token Usage Limits (Non-Resettable Telemetry)**: **Fast** tier is **Unlimited** (no cap across Fast, Subagent Workers, and Graph Mapper); **Smart** tier enforces configurable rolling **4-hour** and **Daily** token limits with live progress bars and reset countdowns.
- **Visual Diff, Document Compare & Office/PDF Exports**: Red/green diff previews inside AI file-action cards, side-by-side **Compare 2 Files** (PDF/DOCX/CSV/code), built-in CSV/Excel **Data Desk** table viewer, and 1-click **Word (`.docx`)**, **Excel (`.xlsx`)**, **PDF**, and **Calendar Invite (`.ics`)** exports.
- **Company Worker Productivity Suite**: Reusable `/workflows` autocomplete (`/meeting-notes`, `/weekly-update`, `/rewrite`, `/translate`, `/audit-data`, `/report`, `/action-items`, `/compare` + custom templates), **Project Tasks** board, **Privacy / PII Redaction Shield** (masks emails, IBANs, phones, secrets & custom client names locally before cloud calls and restores locally), **Private Offline Document Knowledge Base** (BM25 search over PDFs/DOCX/XLSX/MD), **Local Scheduled Automations & Folder Watchers**, **System Tray + `Alt+Space` Clipboard Quick-Ask**, and **`Ctrl+V` Screenshot Paste**.

## Running
- **Linux**: Download `mx-Cowork-1.7.1.AppImage` (`chmod +x` and run) or install `mx-cowork_1.7.1_amd64.deb` (`sudo apt install ./mx-cowork_1.7.1_amd64.deb`).
- **Windows**: Extract `mx-Cowork-1.7.1-win-x64.zip` and double-click `mx-Cowork.exe`.
- **From source**: `cd cowork && npm install && npm start`
