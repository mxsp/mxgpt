# Installation & Operations Manual

Complete setup, deployment, tuning, and troubleshooting guide for **mx-GPT** and **mx-Cowork**.

---

## 1. Prerequisites

| Component | Requirement | Notes |
| --- | --- | --- |
| **Node.js** | v20.0+ (v22 LTS recommended) | Required for running from source; **not** needed for prebuilt `mx-Cowork` executables |
| **Ollama** | v0.40+ recommended | Needed on your inference host (`lfm3:latest` + `inkling-2-mini:latest`) |
| **RAM** | 24 GB+ (32–64 GB ideal for 26B Smart + 1.7B Fast) | Both models stay hot in RAM simultaneously (~20 GB total at 32k context) |
| **OS** | Linux, macOS, Windows 10/11 | Prebuilt `mx-Cowork` binaries provided for Linux x64 and Windows x64 |

---

## 2. Quick Installation

### Linux / macOS
```bash
git clone https://github.com/mxsp/mxgpt.git
cd mxgpt
./scripts/setup.sh
```

### Windows (PowerShell)
```powershell
git clone https://github.com/mxsp/mxgpt.git
cd mxgpt
.\scripts\setup.ps1
```

### Docker Compose
```bash
cp .env.example .env
docker compose up -d --build
```

---

## 3. Production Linux Deployment (systemd)

1. Copy the repository to `/opt/mxgpt` and create `/opt/mxgpt/.env` from `.env.example`.
2. Install and enable both services:
   ```bash
   sudo cp deploy/mxgpt-queue.service /etc/systemd/system/
   sudo cp deploy/mxgpt.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now mxgpt-queue.service mxgpt.service
   ```
3. Verify health:
   ```bash
   curl -s http://127.0.0.1:11435/_queue/status
   curl -s http://127.0.0.1:8088/api/models
   ```

### Multi-User Container Isolation (Optional)
For semi-public exposure (e.g., via Cloudflare Tunnel), run per-user sandboxed containers built from `Dockerfile` (`MXGPT_SANDBOX=1`) behind an authenticated reverse proxy, and point every container's `OLLAMA_URL` to the host queue scheduler (`http://<docker-bridge-ip>:11435`). Restrict port `11435` via `nftables` to `lo` and the container subnet only so Ollama stays inaccessible from public networks.

---

## 4. CPU & Ollama Performance Tuning

On CPU-only Linux servers (especially dual-socket Xeon / EPYC systems), these settings yield **2–15× better TTFT and throughput**:

1. **Pin Ollama to physical cores only (no Hyper-Threading) with NUMA interleaving**:
   ```ini
   ExecStart=/usr/bin/numactl --interleave=all --physcpubind=0-19 /path/to/ollama serve
   ```
   Using all physical cores across both sockets with `--interleave=all` doubles effective DRAM memory bandwidth.
2. **Use `performance` CPU frequency governor & disable AutoNUMA**:
   ```bash
   for g in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do echo performance | sudo tee "$g" >/dev/null; done
   sudo sysctl -w kernel.numa_balancing=0
   ```
3. **Lock uniform `num_ctx` and `num_thread` across every client**:
   Ollama unloads and reloads a model (12–18s stall) whenever `num_ctx` or `num_thread` changes between requests. Set `OLLAMA_CONTEXT_LENGTH=32768`, `OLLAMA_KV_CACHE_TYPE=q8_0`, `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KEEP_ALIVE=-1`, and match `MXGPT_NUM_THREAD` to your physical core count everywhere (`.env`, containers, prewarm script, and Modelfile).
4. **Always route traffic through `deploy/ollama-queue.cjs`**:
   Prevents two models (`inkling-2-mini` + `lfm3`) from fighting over the same CPU cores simultaneously.

---

## 5. Configuration Reference (`.env`)

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` / `PORT` | `0.0.0.0` / `8088` | HTTP listen address for mx-GPT |
| `OLLAMA_URL` | `http://127.0.0.1:11435` | Upstream Ollama or queue scheduler URL |
| `DEFAULT_MODEL` | `lfm3:latest` | Default model for new chats |
| `MXGPT_FAST_MODEL` | `lfm3:latest` | Model backing **Fast** mode and warm subagents |
| `MXGPT_SMART_MODEL` | `inkling-2-mini:latest` | Model backing **Smart** mode |
| `MXGPT_NUM_THREAD` | `20` | Physical CPU thread count passed to Ollama |
| `AUTH_REQUIRED` | `1` | Require password sign-in (`0` behind external auth gateway) |
| `MXGPT_SANDBOX` | `0` | `1` disables host file writes and LAN Ollama admin endpoints |

---

## 6. Troubleshooting

- **Slow Smart TTFT**: Verify `OLLAMA_KEEP_ALIVE=-1` and check `curl http://127.0.0.1:11434/api/ps` to confirm both models stay warm with identical `context_length: 32768`.
- **Throughput drops under concurrent users**: Ensure all clients/containers point to `deploy/ollama-queue.cjs` (`:11435`), not directly to `:11434`. Check live state at `http://127.0.0.1:11435/_queue/status`.
- **403 on Ollama Settings**: Expected over public URLs / Cloudflare Tunnel — access Ollama Settings from a private LAN IP (`192.168.x.x` / `10.x.x.x` / `127.0.0.1`).
