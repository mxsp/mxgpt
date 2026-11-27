# Security Policy

## Architecture & Isolation Principles

1. **LAN-Only Ollama Administration**: Ollama model management and runtime tuning endpoints (`/api/ollama/*`) are strictly blocked (`403 Forbidden`) when accessed through public proxies (Cloudflare Tunnel, gateway headers, or sandboxed user containers).
2. **Per-User Container Isolation**: Public/multi-user deployments run isolated sandboxed containers (`MXGPT_SANDBOX=1`) behind an authenticated gateway, with host firewall (`nftables`) rules restricting inference queue access to loopback and the container bridge only.
3. **Safe Local File Operations (mx-Cowork)**:
   - All file operations are strictly sandboxed within the user-selected local workspace directory (path traversal blocked).
   - Destructive/mutating operations (`write`, `move`, `rename`, `copy`, `delete`) require explicit user approval via interactive Action Cards by default.
   - Deletions move files to `.mx-cowork-trash/` inside the workspace so every operation is reversible via the **Undo Log**.
4. **Local Credential Storage**: `mx-Cowork` binds exclusively to loopback (`127.0.0.1`) and stores settings locally in the OS user configuration directory (`~/.config/mx-cowork` on Linux, `%APPDATA%\mx-cowork` on Windows).

## Reporting a Vulnerability

Please report security issues privately via GitHub Security Advisories on `mxsp/mxgpt` rather than opening a public issue.
