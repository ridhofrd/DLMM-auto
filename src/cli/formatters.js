import { config, computeDeployAmount } from "../../config.js";
import { isHiveMindEnabled } from "../../hivemind.js";
import { getLatestCandidatesMeta } from "./state.js";

export function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines = candidates.map((p, i) => {
    const name = (p.name || "unknown").padEnd(20);
    const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const org = String(p.organic_score).padStart(4);

    const sm = p.gmgn_stats?.smart_money_count != null ? `🚀${p.gmgn_stats.smart_money_count}` : "🚀?";
    const safe = p.gmgn_security?.is_honeypot ? "🚫HONEY" : (p.gmgn_security?.risk_level === "high" ? "⚠️HIGH" : "✅SAFE");

    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  org:${org}  SM:${sm.padStart(5)}  Risk:${safe.padStart(6)}`;
  });

  return [
    "  #   pool                  fee/aTVL     org    SM      Risk",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
}

export function describeLatestCandidates(limit = 5) {
  const { candidates, updatedAt } = getLatestCandidatesMeta();
  if (!candidates.length) return "No cached candidates yet. Run /screen first.";
  const lines = candidates.slice(0, limit).map((pool, i) => {
    const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
    const vol = pool.volume_window ?? pool.volume_24h ?? "?";
    const active = pool.active_pct ?? "?";
    const organic = pool.organic_score ?? "?";
    return `${i + 1}. ${pool.name} | fee/aTVL ${feeTvl}% | vol $${vol} | in-range ${active}% | organic ${organic}`;
  });
  const age = updatedAt ? new Date(updatedAt).toLocaleString("en-US", { hour12: false }) : "unknown";
  return `Latest candidates (${candidates.length}) — updated ${age}\n\n${lines.join("\n")}`;
}

export function formatWalletStatus(wallet, positions) {
  const deployAmount = computeDeployAmount(wallet.sol);
  const hive = isHiveMindEnabled() ? "on" : "off";
  return [
    `Wallet: ${wallet.sol} SOL ($${wallet.sol_usd})`,
    `SOL price: $${wallet.sol_price}`,
    `Open positions: ${positions.total_positions}/${config.risk.maxPositions}`,
    `Next deploy amount: ${deployAmount} SOL`,
    `Dry run: ${process.env.DRY_RUN === "true" ? "yes" : "no"}`,
    `HiveMind: ${hive}`,
  ].join("\n");
}

export function formatConfigSnapshot() {
  return [
    "Config snapshot",
    "",
    `Strategy: ${config.strategy.strategy} | binsBelow: ${config.strategy.binsBelow}`,
    `Deploy: ${config.management.deployAmountSol} SOL | gasReserve: ${config.management.gasReserve} | maxPositions: ${config.risk.maxPositions}`,
    `Stop loss: ${config.management.stopLossPct}% | take profit: ${config.management.takeProfitPct}%`,
    `Trailing: ${config.management.trailingTakeProfit ? "on" : "off"} | trigger ${config.management.trailingTriggerPct}% | drop ${config.management.trailingDropPct}%`,
    `OOR: ${config.management.outOfRangeWaitMinutes}m | cooldown ${config.management.oorCooldownTriggerCount}x / ${config.management.oorCooldownHours}h`,
    `Yield floor: ${config.management.minFeePerTvl24h}% | min age ${config.management.minAgeBeforeYieldCheck}m`,
    `Screening: ${config.screening.category} / ${config.screening.timeframe} | TVL ${config.screening.minTvl}-${config.screening.maxTvl}`,
    `Intervals: manage ${config.schedule.managementIntervalMin}m | screen ${config.schedule.screeningIntervalMin}m`,
    `HiveMind: ${isHiveMindEnabled() ? "enabled" : "disabled"}${config.hiveMind.agentId ? ` | ${config.hiveMind.agentId}` : ""}`,
  ].join("\n");
}

export function parseConfigValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value.length) return "";
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^null$/i.test(value)) return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    return JSON.parse(value);
  }
  return value;
}

export function formatHelpText() {
  return [
    "Telegram commands",
    "",
    "/help — show commands",
    "/status — wallet + positions snapshot",
    "/wallet — wallet, deploy amount, HiveMind status",
    "/positions — list open positions",
    "/pool <n> — detailed info for one open position",
    "/close <n> — close one position by index",
    "/closeall — close all open positions",
    "/set <n> <note> — set note/instruction on position",
    "/config — show important runtime config",
    "/setcfg <key> <value> — update persisted config",
    "/screen — refresh deterministic candidate list",
    "/candidates — show latest cached candidates",
    "/deploy <n> — deploy candidate by cached index",
    "/briefing — morning briefing",
    "/hive — HiveMind sync status",
    "/hive pull — manual HiveMind pull now",
    "/pause — stop cron cycles",
    "/resume — start cron cycles again",
    "/stop — shut down agent",
  ].join("\n");
}
