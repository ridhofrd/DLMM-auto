import fs from "fs";
import path from "path";
import { POOL_DIR, resolveFromRepo } from "./paths.js";
import { getProvider } from "../providers/index.js";

const CONFIG_NAMES = ["llm-pool.config.json", "llm-pool.config.local.json"];

export function loadConfig() {
  let merged = null;

  for (const name of CONFIG_NAMES) {
    const filePath = path.join(POOL_DIR, name);
    if (!fs.existsSync(filePath)) continue;
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    merged = merged ? { ...merged, ...data } : data;
  }

  if (!merged) {
    throw new Error(
      `Missing config. Copy llm-pool.config.example.json → llm-pool.config.json in ${POOL_DIR}`,
    );
  }

  const providerName = merged.provider || "ollama";
  const provider = getProvider(providerName);
  const providerDefaults = provider.defaultConfig?.() || {};

  const config = {
    provider: providerName,
    accounts_file: path.join(POOL_DIR, "accounts.pool.json"),
    state_file: path.join(POOL_DIR, "llm-pool.state.json"),
    env_file: resolveFromRepo(merged.env_file || ".env"),
    env_keys: merged.env_keys || ["LLM_API_KEY", "OLLAMA_API_KEY", "OPENROUTER_API_KEY"],
    env_base_url_key: merged.env_base_url_key || "LLM_BASE_URL",
    base_url: merged.base_url ?? providerDefaults.api_base,
    selection_strategy: merged.selection_strategy || "round-robin",
    probe_interval_min: merged.probe_interval_min ?? 15,
    probe_timeout_ms: merged.probe_timeout_ms ?? 60_000,
    max_retries_before_rotate: merged.max_retries_before_rotate ?? 2,
    cooldown_session_hours: merged.cooldown_session_hours ?? providerDefaults.cooldown_session_hours ?? 5,
    cooldown_weekly_days: merged.cooldown_weekly_days ?? providerDefaults.cooldown_weekly_days ?? 7,
    log_file: path.join(POOL_DIR, "llm-pool.log"),
    notify: merged.notify || {},
    ...providerDefaults,
    ...merged,
    provider: providerName,
  };

  config.accounts_file = resolveFromRepo(merged.accounts_file) || config.accounts_file;
  config.state_file = resolveFromRepo(merged.state_file) || config.state_file;

  return config;
}

export function loadAccounts(config) {
  if (!fs.existsSync(config.accounts_file)) {
    throw new Error(
      `Missing accounts file. Copy accounts.pool.example.json → accounts.pool.json`,
    );
  }
  const data = JSON.parse(fs.readFileSync(config.accounts_file, "utf8"));
  if (!Array.isArray(data.accounts) || data.accounts.length === 0) {
    throw new Error("accounts.pool.json must contain a non-empty accounts array");
  }
  for (const acc of data.accounts) {
    if (!acc.id || !acc.api_key) {
      throw new Error(`Each account needs id and api_key (bad entry: ${JSON.stringify(acc)})`);
    }
  }
  return data.accounts;
}
