# Contributing to mx-GPT & mx-Cowork

Thank you for contributing!

## Development Workflow

1. Fork & clone the repository:
   ```bash
   git clone https://github.com/mxsp/mxgpt.git
   cd mxgpt
   ./scripts/setup.sh
   ```
2. Both **mx-GPT** (`server/` + `public/`) and **mx-Cowork** (`cowork/src/` + `cowork/public/`) are zero-build Node.js 22+ applications — edit files and restart the process to test immediately.
3. Verify syntax before opening a PR:
   ```bash
   for f in server/*.js public/app.js deploy/*.cjs cowork/src/*.js cowork/public/app.js; do
     node --check "$f"
   done
   ```
4. Never commit `.env`, personal credentials, tokens, or local `data/` directories.
