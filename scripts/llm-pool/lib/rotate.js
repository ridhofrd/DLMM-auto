import { loadConfig, loadAccounts } from "./config.js";
import { loadState, saveState, getAccountMeta, pushRotationHistory, setCooldown } from "./state.js";
import { createLogger } from "./logger.js";
import { patchEnv } from "./env-patcher.js";
import { selectNext, markAccount, listAccountsWithMeta } from "./pool.js";
import { getProvider } from "../providers/index.js";
import { withLockAsync } from "./lock.js";

export async function probeAccount(accountId, { config: cfg } = {}) {
  const config = cfg || loadConfig();
  const accounts = loadAccounts(config);
  const account = accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`Account not found: ${accountId}`);

  const provider = getProvider(config.provider);
  return provider.probe(account, config);
}

export async function probeActive({ config: cfg } = {}) {
  const config = cfg || loadConfig();
  const state = loadState(config);
  if (!state.active_account_id) {
    return { ok: false, error: "No active account in state" };
  }
  return probeAccount(state.active_account_id, { config });
}

export async function recoverCooldowns({ config: cfg } = {}) {
  const config = cfg || loadConfig();
  const state = loadState(config);
  const accounts = loadAccounts(config);
  const log = createLogger(config.log_file);
  let recovered = 0;

  for (const acc of accounts) {
    const meta = getAccountMeta(state, acc.id);
    if (!meta.cooldown_until) continue;
    if (Date.now() < new Date(meta.cooldown_until).getTime()) continue;

    meta.state = "healthy";
    meta.cooldown_until = null;
    meta.last_error = null;
    recovered++;
    log("info", `Recovered ${acc.id} from cooldown → healthy`);
  }

  saveState(config, state);
  return { recovered };
}

export async function rotate({ reason = "manual", force = false, config: cfg } = {}) {
  return withLockAsync(async () => {
    const config = cfg || loadConfig();
    const log = createLogger(config.log_file);
    const provider = getProvider(config.provider);
    const accounts = loadAccounts(config);
    const state = loadState(config);
    const fromId = state.active_account_id;

    if (!force && fromId) {
      const current = accounts.find((a) => a.id === fromId);
      if (current) {
        const probe = await provider.probe(current, config);
        if (probe.ok) {
          log("info", `Active account ${fromId} still healthy — no rotation`);
          return { rotated: false, active: fromId, probe };
        }
        const kind = probe.classification?.kind;
        if (kind === "transient" && state.consecutive_failures < config.max_retries_before_rotate) {
          state.consecutive_failures++;
          saveState(config, state);
          log("warn", `Transient error on ${fromId} (${state.consecutive_failures}/${config.max_retries_before_rotate}) — not rotating yet`);
          return { rotated: false, active: fromId, probe, deferred: true };
        }
        applyFailure(state, fromId, probe, config, log);
      }
    } else if (fromId) {
      markAccount(state, fromId, { state: "exhausted", last_error: reason });
    }

    const next = selectNext(accounts, state, config, { excludeId: fromId });
    if (!next) {
      log("error", "Pool depleted — no selectable accounts");
      saveState(config, state);
      await maybeNotify(config, `llm-pool: pool depleted. No keys available. Last reason: ${reason}`);
      return { rotated: false, depleted: true, active: fromId };
    }

    let activated = null;
    let lastProbe = null;

    for (let attempt = 0; attempt < accounts.length; attempt++) {
      const candidate = attempt === 0 ? next : selectNext(accounts, state, config, { excludeId: activated?.id || fromId });
      if (!candidate) break;

      const probe = await provider.probe(candidate, config);
      lastProbe = probe;

      if (probe.ok) {
        activated = candidate;
        break;
      }

      log("warn", `Candidate ${candidate.id} failed probe: ${probe.error || probe.statusCode}`);
      applyFailure(state, candidate.id, probe, config, log);
    }

    if (!activated) {
      saveState(config, state);
      await maybeNotify(config, "llm-pool: all candidates failed probe");
      return { rotated: false, depleted: true, active: fromId, lastProbe };
    }

    patchEnv(config.env_file, {
      keys: config.env_keys,
      apiKey: activated.api_key,
      baseUrl: config.base_url,
      baseUrlKey: config.env_base_url_key,
      activeId: activated.id,
    });

    if (fromId && fromId !== activated.id) {
      markAccount(state, fromId, { state: fromId === activated.id ? "active" : getAccountMeta(state, fromId).state });
    }

    for (const acc of accounts) {
      const meta = getAccountMeta(state, acc.id);
      meta.state = acc.id === activated.id ? "active" : meta.state === "active" ? "healthy" : meta.state;
    }

    const activatedMeta = markAccount(state, activated.id, {
      state: "active",
      last_used_at: new Date().toISOString(),
      last_error: null,
      fail_count: 0,
    });
    activatedMeta.cooldown_until = null;

    state.active_account_id = activated.id;
    state.last_rotation_at = new Date().toISOString();
    state.consecutive_failures = 0;

    pushRotationHistory(state, {
      at: state.last_rotation_at,
      from: fromId,
      to: activated.id,
      reason,
      provider: config.provider,
    });

    saveState(config, state);
    log("info", `Rotated ${fromId || "(none)"} → ${activated.id} (${reason})`);

    await maybeNotify(
      config,
      `llm-pool: rotated ${fromId || "none"} → ${activated.id}\nReason: ${reason}`,
    );

    return {
      rotated: true,
      from: fromId,
      active: activated.id,
      reason,
      probe: lastProbe,
    };
  });
}

function applyFailure(state, accountId, probe, config, log) {
  const classification = probe.classification || { kind: "unknown" };
  const meta = getAccountMeta(state, accountId);
  meta.fail_count = (meta.fail_count || 0) + 1;
  meta.last_error = probe.error || `HTTP ${probe.statusCode}` || "probe failed";

  if (classification.kind === "invalid") {
    meta.state = "invalid";
    log("warn", `${accountId} marked invalid`);
    return;
  }

  if (classification.kind === "quota") {
    const hours = classification.cooldownHours ?? config.cooldown_session_hours;
    setCooldown(meta, hours);
    meta.state = "exhausted";
    log("warn", `${accountId} exhausted — cooldown ${hours}h`);
    return;
  }

  if (classification.kind === "transient") {
    log("warn", `${accountId} transient error — not marking exhausted`);
    return;
  }

  meta.state = "exhausted";
  setCooldown(meta, config.cooldown_session_hours);
}

async function maybeNotify(config, text) {
  const tg = config.notify?.telegram;
  if (!tg?.bot_token || !tg?.chat_id) return;

  try {
    await fetch(`https://api.telegram.org/bot${tg.bot_token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: tg.chat_id, text }),
    });
  } catch {
    /* optional */
  }
}

export function formatStatus(config, accounts, state) {
  const rows = listAccountsWithMeta(accounts, state);
  const lines = [
    `Provider: ${config.provider}`,
    `Active: ${state.active_account_id || "(none)"}`,
    `Env: ${config.env_file}`,
    `Strategy: ${config.selection_strategy}`,
    "",
    "Accounts:",
  ];

  for (const row of rows) {
    const m = row.meta;
    const cd = m.cooldown_until ? ` until ${m.cooldown_until}` : "";
    lines.push(
      `  - ${row.id} [${m.state}] tier=${row.tier || "?"} priority=${row.priority ?? "-"}${cd}`,
    );
    if (m.last_error) lines.push(`      last_error: ${m.last_error.slice(0, 120)}`);
  }

  if (state.rotation_history?.length) {
    lines.push("", "Recent rotations:");
    for (const r of state.rotation_history.slice(0, 5)) {
      lines.push(`  ${r.at}  ${r.from || "?"} → ${r.to}  (${r.reason})`);
    }
  }

  return lines.join("\n");
}

export async function activateAccount(accountId, { config: cfg } = {}) {
  const config = cfg || loadConfig();
  const accounts = loadAccounts(config);
  const account = accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`Account not found: ${accountId}`);

  const provider = getProvider(config.provider);
  const probe = await provider.probe(account, config);
  if (!probe.ok) {
    throw new Error(`Probe failed for ${accountId}: ${probe.error || probe.statusCode}`);
  }

  const state = loadState(config);
  patchEnv(config.env_file, {
    keys: config.env_keys,
    apiKey: account.api_key,
    baseUrl: config.base_url,
    baseUrlKey: config.env_base_url_key,
    activeId: account.id,
  });

  for (const acc of accounts) {
    const meta = getAccountMeta(state, acc.id);
    if (acc.id === account.id) {
      meta.state = "active";
      meta.last_used_at = new Date().toISOString();
      meta.cooldown_until = null;
    } else if (meta.state === "active") {
      meta.state = "healthy";
    }
  }

  state.active_account_id = account.id;
  saveState(config, state);

  return { active: account.id, probe };
}
