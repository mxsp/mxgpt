# Architecture & Performance Engineering

This document explains the core architectural decisions that make **mx-GPT** and **mx-Cowork** responsive on CPU-hosted local LLMs.

---

## 1. CPU-Aware Inference Queue (`deploy/ollama-queue.cjs`)

Ollama's built-in `OLLAMA_NUM_PARALLEL=1` queues concurrent requests to the **same** model, but still executes **different** loaded models simultaneously (e.g., `inkling-2-mini:latest` and `lfm3:latest` each spawning 20 threads = 40 threads thrashing on 20 physical cores).

`deploy/ollama-queue.cjs` sits cleanly in front of Ollama (`:11435 → :11434`):
- **Metadata passthrough** (`/api/tags`, `/api/ps`, `/api/version`, `/api/show`): <1 ms direct proxy.
- **Exclusive CPU gate** for `/api/chat` and `/api/generate`: ensures only one heavy inference runs at a time, preserving full steady-state tok/s under multi-user load.
- **Short-job priority lane**: Fast (`<3B`) and subagent requests (`X-Mx-Priority: subagent|fast`) execute ahead of queued heavy Smart jobs so quick 1–4s turns don't wait behind multi-minute turns.
- **Anti-starvation aging**: After 2 consecutive Fast jumps or once a Smart job waits >12 seconds, the next slot is guaranteed to Smart.
- **Fair per-user round-robin**: Interleaves queued users (`X-Mx-User`) fairly.
- **Live queue heartbeats**: When clients pass `X-Mx-Queue-Events: 1`, queued streams immediately flush NDJSON `_mx_queue` position updates so the UI renders `Queued #N · waiting for Smart (Inkling 26B)…` and transitions seamlessly into generation the millisecond the slot opens.
- **Instant cancellation**: Client aborts remove queued jobs immediately without hitting Ollama.

---

## 2. Smart Per-Group Tool Routing & KV Checkpoint Stability

On CPU-hosted 26B models (~20–24 tok/s prompt evaluation), injecting 15+ unused JSON tool schemas adds ~1,000–1,800 prompt tokens (**+45–80s TTFT**). Worse, changing the active tool list between turns mutates token position 0 and invalidates Ollama's KV context checkpoint.

`server/server.js` solves both:
1. **Per-group zero-latency routing** for local models: Web (`web_search`, `deep_research`, `browse_url`, `wiki_lookup`), Utility (`calculate`, `get_datetime`, `run_js`), Notes, and Subagents schemas are injected only when the prompt matches that capability.
2. **Monotonic per-chat stickiness (`chatToolGroups`)**: Once a tool group is enabled in a chat, follow-up turns preserve the exact same system prompt + tool prefix so Ollama reuses its KV context checkpoint cleanly.

---

## 3. Native Inkling 2 Mini Thinking Calibration

In Ollama 0.40.18, `inkling-2-mini:latest` exposes native thinking levels (`false`, `true`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), and its `inkling2` renderer still generates hidden internal reasoning tokens on `false`/`none`.

`server/ollama.js` and `cowork/src/endpoint.js` calibrate Inkling specifically:
- UI `Off` / `Low` → native `minimal` (immediate streaming, short crisp reasoning, ~1.6× faster wall time with zero quality degradation).
- UI `Med` → native `low`.
- UI `High` → native `high`.

---

## 4. Detached Background Runs & Sub-3B Subagents

- Chat execution runs detached from the initiating HTTP socket (`activeRuns` map in `server/server.js`), allowing users to switch chats or refresh the browser and re-attach seamlessly via `GET /api/chats/:id/stream` (which sends a full `snapshot` event first).
- Subagents (`server/subagents.js`) restrict execution strictly to `<3B` local models, preferring the prewarmed Fast model (`lfm3:latest`) for ~1 ms runner load time, pre-announcing all parallel subtasks immediately (`queued → running → done`), and routing cleanly through the scheduler's subagent priority lane.
