# mx-Cowork

Local AI Coworker desktop application for **Linux** and **Windows (.exe)** connected to your private `https://max.fyreflysystems.de` (or direct LAN Ollama) endpoint.

## Modes
- **Fast (`lfm3:latest`)** — Instant replies, quick file lookups, fast email rewrites (~27 tok/s).
- **Smart (`inkling-2-mini:latest`)** — Direct deep reasoning and writing.
- **Copilot (Hybrid Orchestrator)** — **Smart** plans & decomposes the task, delegates heavy local file searching, PDF/DOCX reading, folder auditing, and web research distillation to **Fast**, then **Smart** synthesizes the executive result and generates ready-to-apply Email Drafts & undoable File Actions.

## Features
- **Local File Search & Management**: Full-text search & preview across code, Markdown, JSON, CSV, `.pdf`, `.docx`, `.xlsx`, `.pptx`; safe approval cards for `mkdir`, `write`, `move`, `rename`, `copy`, and soft-`delete` (into `.mx-cowork-trash`) with 1-click **Undo**.
- **Email Drafting Studio**: Auto-populated drafts from Copilot, 1-click AI refinements (`Shorter`, `Formal`, `Friendly`, `Direct`, `Fix Grammar`, `EN↔DE`), `mailto:` launch, and RFC-5322 `.eml` export for Outlook / Thunderbird / Apple Mail.
- **Research Desk**: Local DuckDuckGo + Wikipedia + readable web-page extraction with saved briefs and 1-click Markdown export to your workspace.

## Running the Prebuilt Executables
- **Linux**: `./dist/mx-cowork-linux-x64`
- **Windows**: Double-click `dist\mx-cowork-win-x64.exe`
- Optional CLI flags: `--port 4318`, `--no-open`

## Rebuilding from Source
```bash
npm install
npm run build:all
```
