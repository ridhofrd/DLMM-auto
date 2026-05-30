import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const ALLOWED_USER_IDS = new Set(
  String(process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

let chatId = process.env.TELEGRAM_CHAT_ID || null;
let _offset = 0;
let _polling = false;
let _liveMessageDepth = 0;
let _warnedMissingChatId = false;
let _warnedMissingAllowedUsers = false;

// ─── chatId persistence ──────────────────────────────────────────
function loadChatId() {
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      if (cfg.telegramChatId) chatId = cfg.telegramChatId;
    }
  } catch (error) {
    log("telegram_warn", `Invalid user-config.json; chatId not loaded: ${error.message}`);
  }
}

function saveChatId(id) {
  try {
    let cfg = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
    cfg.telegramChatId = id;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log("telegram_error", `Failed to persist chatId: ${e.message}`);
  }
}

loadChatId();

function isAuthorizedIncomingMessage(msg) {
  const incomingChatId = String(msg.chat?.id || "");
  const senderUserId = msg.from?.id != null ? String(msg.from.id) : null;
  const chatType = msg.chat?.type || "unknown";

  if (!chatId) {
    if (!_warnedMissingChatId) {
      log("telegram_warn", "Ignoring inbound Telegram messages because TELEGRAM_CHAT_ID / user-config.telegramChatId is not configured. Auto-registration is disabled for safety.");
      _warnedMissingChatId = true;
    }
    return false;
  }

  if (incomingChatId !== chatId) return false;

  if (chatType !== "private" && ALLOWED_USER_IDS.size === 0) {
    if (!_warnedMissingAllowedUsers) {
      log("telegram_warn", "Ignoring group Telegram messages because TELEGRAM_ALLOWED_USER_IDS is not configured. Set explicit allowed user IDs for command/control.");
      _warnedMissingAllowedUsers = true;
    }
    return false;
  }

  if (ALLOWED_USER_IDS.size > 0) {
    if (!senderUserId || !ALLOWED_USER_IDS.has(senderUserId)) return false;
  }

  return true;
}

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled() {
  return !!TOKEN;
}

async function postTelegram(method, body) {
  if (!TOKEN || !chatId) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...body }),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

const TELEGRAM_MAX_MESSAGE = 4096;

/** Split plain text into Telegram-safe chunks (prefer paragraph breaks). */
export function splitTelegramPlainChunks(text, maxLen = TELEGRAM_MAX_MESSAGE) {
  const s = String(text ?? "");
  if (s.length <= maxLen) return s ? [s] : [];
  const chunks = [];
  let rest = s;
  while (rest.length > 0) {
    if (rest.length <= maxLen) {
      chunks.push(rest);
      break;
    }
    let cut = rest.lastIndexOf("\n\n", maxLen);
    if (cut < maxLen * 0.5) cut = rest.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    if (cut <= 0) cut = maxLen;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  return chunks.filter(Boolean);
}

/** Send text as one or more messages (avoids 4096 truncation). */
export async function sendLongPlainText(text) {
  if (!TOKEN || !chatId) return;
  const parts = splitTelegramPlainChunks(text);
  for (let i = 0; i < parts.length; i++) {
    await postTelegram("sendMessage", { text: parts[i] });
  }
}

export async function sendMessage(text) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: String(text).slice(0, TELEGRAM_MAX_MESSAGE) });
}

export async function sendHTML(html) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: html.slice(0, TELEGRAM_MAX_MESSAGE), parse_mode: "HTML" });
}

async function editMessage(text, messageId) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, TELEGRAM_MAX_MESSAGE),
  });
}

function hasActiveLiveMessage() {
  return _liveMessageDepth > 0;
}

function createTypingIndicator() {
  if (!TOKEN || !chatId) {
    return { stop() { } };
  }

  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    await postTelegram("sendChatAction", { action: "typing" });
    timer = setTimeout(() => {
      tick().catch(() => null);
    }, 4000);
  }

  tick().catch(() => null);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function toolLabel(name) {
  const labels = {
    get_token_info: "get token info",
    get_token_narrative: "get token narrative",
    get_token_holders: "get token holders",
    get_top_candidates: "get top candidates",
    get_pool_detail: "get pool detail",
    get_active_bin: "get active bin",
    deploy_position: "deploy position",
    close_position: "close position",
    claim_fees: "claim fees",
    swap_token: "swap token",
    update_config: "update config",
    get_my_positions: "get positions",
    get_wallet_balance: "get wallet balance",
    check_smart_wallets_on_pool: "check smart wallets",
    study_top_lpers: "study top LPers",
    get_top_lpers: "get top LPers",
    search_pools: "search pools",
    discover_pools: "discover pools",
  };
  return labels[name] || name.replace(/_/g, " ");
}

function summarizeToolResult(name, result) {
  if (!result) return "";
  if (result.error) return result.error;
  if (result.reason && result.blocked) return result.reason;
  switch (name) {
    case "deploy_position":
      return result.position ? `position ${String(result.position).slice(0, 8)}...` : "submitted";
    case "close_position":
      return result.success ? "closed" : (result.reason || "failed");
    case "claim_fees":
      return result.claimed_amount != null ? `claimed ${result.claimed_amount}` : "done";
    case "update_config":
      return Object.keys(result.applied || {}).join(", ") || "updated";
    case "get_top_candidates":
      return `${result.candidates?.length ?? 0} candidates`;
    case "get_my_positions":
      return `${result.total_positions ?? result.positions?.length ?? 0} positions`;
    case "get_wallet_balance":
      return `${result.sol ?? "?"} SOL`;
    case "study_top_lpers":
    case "get_top_lpers":
      return `${result.lpers?.length ?? 0} LPers`;
    default:
      return result.success === false ? "failed" : "done";
  }
}

export async function createLiveMessage(title, intro = "Starting...") {
  if (!TOKEN || !chatId) return null;
  const typing = createTypingIndicator();

  const state = {
    title,
    intro,
    toolLines: [],
    footer: "",
    messageId: null,
    flushTimer: null,
    flushPromise: null,
    flushRequested: false,
    isFlushing: false,
  };

  function render() {
    const sections = [state.title];
    if (state.intro) sections.push(state.intro);
    if (state.toolLines.length > 0) sections.push(state.toolLines.join("\n"));
    if (state.footer) sections.push(state.footer);
    return sections.join("\n\n").slice(0, TELEGRAM_MAX_MESSAGE);
  }

  async function flushNow() {
    state.isFlushing = true;
    state.flushTimer = null;
    state.flushRequested = false;

    try {
      const text = render();
      if (!state.messageId) {
        const sent = await sendMessage(text);
        state.messageId = sent?.result?.message_id ?? null;
      } else {
        await editMessage(text, state.messageId);
      }
    } finally {
      state.isFlushing = false;
      if (state.flushRequested) {
        scheduleFlush(1000);
      }
    }
  }

  function scheduleFlush(delay = 1000) {
    if (state.flushTimer || state.isFlushing) {
      state.flushRequested = true;
      return;
    }
    state.flushTimer = setTimeout(() => {
      state.flushPromise = flushNow().catch(() => null);
    }, delay);
  }

  async function upsertToolLine(name, icon, suffix = "") {
    const label = toolLabel(name);
    const line = `${icon} ${label}${suffix ? ` ${suffix}` : ""}`;
    const idx = state.toolLines.findIndex((entry) => entry.includes(` ${label}`));
    if (idx >= 0) state.toolLines[idx] = line;
    else state.toolLines.push(line);
    scheduleFlush();
  }

  _liveMessageDepth += 1;
  await flushNow();

  return {
    async toolStart(name) {
      await upsertToolLine(name, "ℹ️", "...");
    },
    async toolFinish(name, result, success) {
      const icon = success ? "✅" : "❌";
      const summary = summarizeToolResult(name, result);
      await upsertToolLine(name, icon, summary ? `— ${summary}` : "");
    },
    async note(text) {
      state.intro = text;
      scheduleFlush();
    },
    async finalize(finalText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      const headerParts = [state.title, state.intro, state.toolLines.length > 0 ? state.toolLines.join("\n") : null].filter(Boolean);
      const header = headerParts.join("\n\n");
      const body = finalText ? String(finalText) : "";
      const combined = body ? `${header}\n\n${body}` : header;
      if (combined.length <= TELEGRAM_MAX_MESSAGE) {
        state.footer = finalText;
        await flushNow();
      } else {
        state.footer =
          "✅ Done — full report is too long for one message. Continued below ⬇️";
        await flushNow();
        const overflow = body.trim() ? body : combined;
        await sendLongPlainText(overflow);
      }
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
    async fail(errorText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = `❌ ${errorText}`;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
  };
}


// ─── Long polling ────────────────────────────────────────────────
async function poll(onMessage) {
  while (_polling) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?offset=${_offset}&timeout=30`,
        { signal: AbortSignal.timeout(35_000) }
      );
      if (!res.ok) { await sleep(5000); continue; }
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;
        if (!isAuthorizedIncomingMessage(msg)) continue;
        await onMessage(msg);
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) {
        log("telegram_error", `Poll error: ${e.message}`);
      }
      await sleep(5000);
    }
  }
}

export function startPolling(onMessage) {
  if (!TOKEN) return;
  _polling = true;
  poll(onMessage); // fire-and-forget
  log("telegram", "Bot polling started");
}

export function stopPolling() {
  _polling = false;
}

// ─── Notification helpers ────────────────────────────────────────
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function notifyDeploy({
  pair,
  amountSol,
  position,
  tx,
  priceRange,
  binStep,
  baseFee,
  strategy,
  binsBelow,
  binsAbove,
  gmgn_risk,
  gmgn_sm,
  volumeTrend,
}) {
  if (hasActiveLiveMessage()) return;
  const priceStr = priceRange
    ? `Price range: ${priceRange.min < 0.0001 ? priceRange.min.toExponential(3) : priceRange.min.toFixed(6)} – ${priceRange.max < 0.0001 ? priceRange.max.toExponential(3) : priceRange.max.toFixed(6)}\n`
    : "";
  const coverageStr = rangeCoverage
    ? `Range cover: ${fmtPct(rangeCoverage.downside_pct)} downside | ${fmtPct(rangeCoverage.upside_pct)} upside | ${fmtPct(rangeCoverage.width_pct)} total\n`
    : "";
  const poolStr = (binStep || baseFee)
    ? `Bin step: ${binStep ?? "?"}  |  Base fee: ${baseFee != null ? baseFee + "%" : "?"}\n`
    : "";
  const stratStr = strategy ? `Strategy: <b>${escapeHtml(strategy)}</b>\n` : "";
  const trendStr = volumeTrend ? `Volume trend: <b>${escapeHtml(volumeTrend)}</b>\n` : "";
  const binsStr =
    binsBelow != null || binsAbove != null
      ? `Bins: below <code>${binsBelow ?? 0}</code> / above <code>${binsAbove ?? 0}</code>\n`
      : "";

  const gmgnStr = (gmgn_risk || gmgn_sm)
    ? `\n🛡️ <b>GMGN Intelligence:</b>\n` +
    (gmgn_risk ? `Risk: ${gmgn_risk === 'high' ? '🔴 HIGH' : gmgn_risk === 'medium' ? '🟡 MED' : '🟢 SAFE'}\n` : "") +
    (gmgn_sm != null ? `Smart Money: 🚀 ${gmgn_sm} wallets\n` : "")
    : "";

  await sendHTML(
    `✅ <b>Deployed</b> ${escapeHtml(pair)}\n` +
    stratStr +
    trendStr +
    binsStr +
    `Amount: ${escapeHtml(String(amountSol))} SOL\n` +
    priceStr +
    coverageStr +
    poolStr +
    gmgnStr +
    `\nPosition: <code>${position?.slice(0, 8)}...</code>\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`
  );
}

export async function notifyQueueForTracking({
  pair,
  pool,
  amountSol,
  strategy,
  binsBelow,
  binsAbove,
  initialVolumeChangePct,
  llmReasoning,
}) {
  if (hasActiveLiveMessage()) return;
  const stratStr = strategy ? `Strategy: <b>${escapeHtml(strategy)}</b>\n` : "";
  const binsStr =
    binsBelow != null || binsAbove != null
      ? `Bins: below <code>${binsBelow ?? 0}</code> / above <code>${binsAbove ?? 0}</code>\n`
      : "";

  await sendHTML(
    `🔭 <b>Queued for Observation</b>\n\n` +
    `<b>Pair:</b> ${escapeHtml(pair)}\n` +
    `<b>Pool:</b> <code>${pool}</code>\n\n` +
    stratStr +
    binsStr +
    `Amount: ${escapeHtml(String(amountSol))} SOL\n` +
    `Baseline VCP: <b>${initialVolumeChangePct}%</b>\n\n` +
    `<i>Reasoning:</i>\n${escapeHtml(llmReasoning || "Agent determined it has potential but needs volume confirmation.")}`
  );
}

function fmtMoney(value, solMode = false) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "?";
  const sign = n >= 0 ? "+" : "";
  if (solMode) return `${sign}◎${Math.abs(n).toFixed(4)}`;
  return `${sign}$${n.toFixed(2)}`;
}

function fmtPctLine(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "PnL %: <i>pending / unavailable</i>";
  const sign = n >= 0 ? "+" : "";
  return `PnL %: <b>${sign}${n.toFixed(2)}%</b>`;
}

function describeCloseTrigger(reason) {
  const r = String(reason || "").toLowerCase();
  if (r.includes("emergency stop")) return "Emergency stop-loss poller (fast)";
  if (r.includes("take profit") && r.includes("poller")) return "Take-profit poller (30s)";
  if (r.includes("(poller)")) return "Exit poller (30s) — trailing TP, stop-loss, OOR, or low yield";
  if (r.includes("trailing tp") || r.includes("trailing take")) return "Trailing take-profit";
  if (r === "stop loss" || r.includes("stop loss:") || r.includes("stop-loss")) return "Stop-loss rule";
  if (r.includes("take profit") || r === "take profit") return "Take-profit rule";
  if (r.includes("low yield")) return "Low fee/TVL yield rule";
  if (r.includes("pumped far above") || r.includes("pumped above")) return "Price pumped above LP range";
  if (r.includes("out of range") || r === "oor" || r.endsWith(" oor")) return "Out-of-range (OOR) rule";
  if (r.includes("telegram") || r.includes("manual")) return "Manual close (Telegram / operator)";
  if (r.includes("instruction")) return "Custom position instruction";
  if (r.includes("agent decision")) return "Agent / tool decision";
  return "Automated management";
}

function formatTxList(txs) {
  if (!txs?.length) return null;
  return txs.map((t) => `<code>${escapeHtml(String(t).slice(0, 20))}…</code>`).join(" ");
}

/**
 * Verbose Telegram alert for any position close (JS direct or LLM via executor).
 * Always sends when Telegram is configured (not suppressed by live management UI).
 */
export async function notifyPositionClose({
  pair,
  pool,
  position,
  reason,
  pnlUsd,
  pnlPct,
  preClosePnlPct,
  feesUsd,
  minutesHeld,
  minutesOOR,
  initialValueUsd,
  finalValueUsd,
  closeTxs,
  claimTxs,
  relay,
  solMode = false,
}) {
  if (!TOKEN || !chatId) return;

  const trigger = describeCloseTrigger(reason);
  const cur = solMode ? "◎" : "$";
  const lines = [
    `🔒 <b>POSITION CLOSED</b>`,
    ``,
    `<b>Pair:</b> ${escapeHtml(pair || "unknown")}`,
    `<b>Why:</b> ${escapeHtml(reason || "unspecified")}`,
    `<b>Trigger:</b> ${escapeHtml(trigger)}`,
    ``,
    fmtPctLine(pnlPct),
  ];

  if (Number.isFinite(preClosePnlPct) && preClosePnlPct !== pnlPct) {
    lines.push(`PnL % at signal: <b>${preClosePnlPct >= 0 ? "+" : ""}${preClosePnlPct.toFixed(2)}%</b>`);
  }

  if (Number.isFinite(pnlUsd)) {
    lines.push(`PnL ${cur === "◎" ? "value" : "USD"}: <b>${fmtMoney(pnlUsd, solMode)}</b>`);
  }

  if (Number.isFinite(feesUsd) && feesUsd > 0) {
    lines.push(`Fees earned: <b>${fmtMoney(feesUsd, solMode)}</b>`);
  }

  if (Number.isFinite(initialValueUsd) && initialValueUsd > 0) {
    lines.push(`Deployed (approx): <b>${fmtMoney(initialValueUsd, solMode)}</b>`);
  }
  if (Number.isFinite(finalValueUsd) && finalValueUsd > 0) {
    lines.push(`Withdrawn (approx): <b>${fmtMoney(finalValueUsd, solMode)}</b>`);
  }

  const holdParts = [];
  if (minutesHeld != null) holdParts.push(`held ${minutesHeld}m`);
  if (minutesOOR != null && minutesOOR > 0) holdParts.push(`OOR ${minutesOOR}m`);
  if (holdParts.length) lines.push(`Time: ${holdParts.join(" | ")}`);

  lines.push(``);
  if (pool) lines.push(`Pool: <code>${escapeHtml(pool)}</code>`);
  if (position) lines.push(`Position: <code>${escapeHtml(position)}</code>`);
  if (relay) lines.push(`Execution: LPAgent relay`);
  const claimStr = formatTxList(claimTxs);
  const closeStr = formatTxList(closeTxs);
  if (claimStr) lines.push(`Claim tx: ${claimStr}`);
  if (closeStr) lines.push(`Close tx: ${closeStr}`);

  await sendHTML(lines.join("\n"));
}

export async function notifyPositionCloseFailed({
  pair,
  position,
  pool,
  reason,
  error,
  preClosePnlPct,
  solMode = false,
}) {
  if (!TOKEN || !chatId) return;

  const lines = [
    `❌ <b>POSITION CLOSE FAILED</b>`,
    ``,
    `<b>Pair:</b> ${escapeHtml(pair || "unknown")}`,
    `<b>Intended reason:</b> ${escapeHtml(reason || "unspecified")}`,
    `<b>Trigger:</b> ${escapeHtml(describeCloseTrigger(reason))}`,
  ];

  if (Number.isFinite(preClosePnlPct)) {
    lines.push(fmtPctLine(preClosePnlPct));
  }

  lines.push(`<b>Error:</b> ${escapeHtml(error || "unknown error")}`);
  if (pool) lines.push(`Pool: <code>${escapeHtml(pool)}</code>`);
  if (position) lines.push(`Position: <code>${escapeHtml(position)}</code>`);

  await sendHTML(lines.join("\n"));
}

/** @deprecated Use notifyPositionClose — kept for callers passing minimal fields */
export async function notifyClose({ pair, pnlUsd, pnlPct, reason, position, pool }) {
  return notifyPositionClose({ pair, pnlUsd, pnlPct, reason: reason || "agent decision", position, pool });
}

export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
  if (hasActiveLiveMessage()) return;
  await sendHTML(
    `🔄 <b>Swapped</b> ${inputSymbol} → ${outputSymbol}\n` +
    `In: ${amountIn ?? "?"} | Out: ${amountOut ?? "?"}\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`
  );
}

export async function notifyOutOfRange({ pair, minutesOOR }) {
  if (hasActiveLiveMessage()) return;
  await sendHTML(
    `⚠️ <b>Out of Range</b> ${pair}\n` +
    `Been OOR for ${minutesOOR} minutes`
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}
