import fs from "fs";
import { ensureParentDir } from "./paths.js";

export function loadState(config) {
  if (!fs.existsSync(config.state_file)) {
    return defaultState();
  }
  try {
    return { ...defaultState(), ...JSON.parse(fs.readFileSync(config.state_file, "utf8")) };
  } catch (error) {
    throw new Error(`Invalid state file ${config.state_file}: ${error.message}`);
  }
}

export function saveState(config, state) {
  ensureParentDir(config.state_file);
  state.updated_at = new Date().toISOString();
  fs.writeFileSync(config.state_file, JSON.stringify(state, null, 2));
}

function defaultState() {
  return {
    active_account_id: null,
    last_rotation_at: null,
    consecutive_failures: 0,
    account_meta: {},
    rotation_history: [],
    updated_at: null,
  };
}

export function getAccountMeta(state, accountId) {
  if (!state.account_meta[accountId]) {
    state.account_meta[accountId] = {
      state: "healthy",
      last_error: null,
      last_used_at: null,
      cooldown_until: null,
      fail_count: 0,
    };
  }
  return state.account_meta[accountId];
}

export function isCooldownExpired(meta) {
  if (!meta.cooldown_until) return true;
  return Date.now() >= new Date(meta.cooldown_until).getTime();
}

export function setCooldown(meta, hours) {
  meta.cooldown_until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  meta.state = "cooldown";
}

export function pushRotationHistory(state, entry, max = 50) {
  state.rotation_history.unshift(entry);
  if (state.rotation_history.length > max) state.rotation_history.length = max;
}
