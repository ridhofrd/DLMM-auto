# llm-pool

Generic LLM API key pool manager for Meridian (or any app reading `.env`).

Rotates `LLM_API_KEY` / `OLLAMA_API_KEY` when the active provider account hits quota or auth errors. Provider-specific logic lives in `providers/` (Ollama and OpenRouter included).

## Quick start (Windows / macOS / Linux)

```bash
cd scripts/llm-pool
node cli.js init

# Edit accounts.pool.json — paste API keys from https://ollama.com/settings/keys
# Edit llm-pool.config.json — set provider, env_keys, base_url

node cli.js activate acc-01
node cli.js status
node cli.js probe
```

From repo root:

```bash
npm run llm-pool -- status
npm run llm-pool -- rotate --force --reason "testing"
npm run llm-pool:daemon
```

## Meridian integration

In project `.env` (patched automatically):

```env
LLM_BASE_URL=https://ollama.com/api
LLM_API_KEY=<rotated by llm-pool>
```

Restart Meridian after manual rotation if it already loaded env vars (`npm start`). The daemon patches `.env` while the process is running, but Node won't reload `.env` until restart unless you use a watcher.

**OpenAI-compatible note:** Meridian's agent uses the OpenAI SDK. Ollama Cloud's native API is at `https://ollama.com/api`. If chat fails, use OpenRouter (`provider: openrouter`) or a local OpenAI-compatible proxy and point `LLM_BASE_URL` accordingly — llm-pool only rotates keys, not wire format.

## Commands

| Command | Description |
|---------|-------------|
| `status` | Pool state, cooldowns, recent rotations |
| `probe [id]` | Test active or specific account |
| `activate <id>` | Force-set account + patch `.env` |
| `rotate [--force]` | Move to next healthy key |
| `recover` | Clear expired cooldown timers |
| `providers` | List adapters |

## Switch provider

Change `provider` in `llm-pool.config.json`:

```json
{
  "provider": "openrouter",
  "base_url": "https://openrouter.ai/api/v1",
  "env_keys": ["LLM_API_KEY", "OPENROUTER_API_KEY"]
}
```

No changes to pool rotation logic required.

## Files (gitignored secrets)

| File | Purpose |
|------|---------|
| `accounts.pool.json` | API keys (never commit) |
| `llm-pool.config.json` | Your local config |
| `llm-pool.state.json` | Active account + cooldowns |
| `llm-pool.log` | Daemon log |

## Algorithm summary

1. Probe active key (minimal API call).
2. On `401` → mark invalid, rotate.
3. On `429` / quota body → mark exhausted + cooldown, rotate.
4. On 5xx / network → retry N times, do not rotate.
5. Pick next account (round-robin / priority / LRU).
6. Probe candidate → patch `.env` → save state.

Ollama does not expose a usage API yet; rotation is **reactive** only.

## Disclaimer

Rotating many free-tier accounts may violate provider Terms of Service. Use responsibly for personal/dev workloads.
