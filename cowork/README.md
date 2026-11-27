# mx-Cowork — Native Desktop AI Coworker (Linux & Windows)

**mx-Cowork** is a native Electron desktop application (zero local web server, zero browser tabs) with direct OS IPC, native folder picker & Save As dialogs, system file explorer integration, and drag-and-drop file pinning.

## Modes
- **Fast (`lfm3:latest`)** — Instant replies, quick file lookups, fast email rewrites (~27 tok/s).
- **Smart (`inkling-2-mini:latest`)** — Direct deep reasoning and writing.
- **Copilot (Hybrid Orchestrator)** — **Smart** plans & decomposes the task, delegates heavy local file searching, PDF/DOCX/XLSX reading, folder auditing, and web research distillation to **Fast**, then **Smart** synthesizes the result and generates ready-to-apply Email Drafts & undoable File Actions.

## Features
- **Native Desktop UX**: Dedicated OS window, native app menu + keyboard shortcuts (`Ctrl+N`, `Ctrl+O`, `Ctrl+,`, `Ctrl+1/2/3`), native folder picker (`Browse…`), Reveal in Explorer/Files, Open with Default App, and drag-and-drop file pinning.
- **Local File Search & Management**: Pure-JS full-text search across `.pdf`, `.docx`, `.xlsx`, `.pptx`, `.md`, JSON, CSV, and source code; interactive approval cards for `mkdir`, `write`, `move`, `rename`, `copy`, and soft-`delete` (`.mx-cowork-trash`) with 1-click **Undo**.
- **Email Drafting Studio**: Auto-populated drafts from Copilot, 1-click AI refinements (`Shorter`, `Formal`, `Friendly`, `Direct`, `Fix Grammar`, `→ DE`, `→ EN`), native Save As `.eml`, and direct OS Mail Client launching.
- **Research Desk**: Local DuckDuckGo + Wikipedia + readable web fetcher with saved briefs and native Save As `.md`.

## Running
- **Linux**: Download `mx-Cowork-1.1.0.AppImage` (chmod `+x` and run) or install `mx-cowork_1.1.0_amd64.deb` (`sudo apt install ./mx-cowork_1.1.0_amd64.deb`).
- **Windows**: Download `mx-Cowork Setup 1.1.0.exe` (installer), `mx-Cowork 1.1.0.exe` (portable), or extract `mx-Cowork-1.1.0-win-x64.zip` and double-click `mx-Cowork.exe`.
- **From source**: `cd cowork && npm install && npm start`
