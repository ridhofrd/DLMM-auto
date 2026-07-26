import { log } from "../../logger.js";
import { config } from "../../config.js";
const fmtPct = (v) => v != null ? (v * 100).toFixed(2) + "%" : "?";
import { sendMessage, sendHTML, createLiveMessage, sendLongPlainText } from "../../telegram.js";
import { getWalletBalances, swapToken } from "../../tools/wallet.js";
import { getMyPositions, closePosition } from "../../tools/dlmm.js";
import { executeTool } from "../../tools/executor.js";
import { agentLoop } from "../../agent.js";
import { generateBriefing } from "../../briefing.js";
import { setPositionInstruction } from "../../data/state.js";
import { ensureAgentId, getHiveMindPullMode, isHiveMindEnabled, pullHiveMindLessons, pullHiveMindPresets, registerHiveMindAgent } from "../../hivemind.js";
import { getPerformanceSummary, evolveThresholds } from "../../data/lessons.js";
import { reloadScreeningThresholds } from "../../config.js";
import { getTopCandidates } from "../../tools/pool-scanner.js";

import { isManagementBusy, isScreeningBusy } from "../cycles/concurrency.js";
import { isCliBusy, setCliBusy, sessionHistory, appendHistory } from "../cli/concurrency.js";
import { formatHelpText, formatWalletStatus, formatConfigSnapshot, parseConfigValue, describeLatestCandidates, formatCandidates } from "../cli/formatters.js";
import { runDeterministicScreen, deployLatestCandidate } from "../cli/actions.js";
import { stripThink } from "../utils/helpers.js";

const _telegramQueue = [];

export function createTelegramHandler(opts = {}) {
  const {
    refreshPrompt = () => {},
    startCronJobs = () => {},
    stopCronJobs = () => {},
    isCronStarted = () => true,
    setCronStarted = () => {},
    shutdown = async () => {}
  } = opts;

  async function drainTelegramQueue() {
    while (_telegramQueue.length > 0 && !isManagementBusy() && !isScreeningBusy() && !isCliBusy) {
      const queued = _telegramQueue.shift();
      await telegramHandler(queued);
    }
  }

  async function telegramHandler(msg) {
    const text = msg?.text?.trim();
    if (!text) return;

    if (isManagementBusy() || isScreeningBusy() || isCliBusy) {
      if (_telegramQueue.length < 5) {
        _telegramQueue.push(msg);
        sendMessage(`⏳ Queued (${_telegramQueue.length} in queue): "${text.slice(0, 60)}"`).catch(() => { });
      } else {
        sendMessage("Queue is full (5 messages). Wait for the agent to finish.").catch(() => { });
      }
      return;
    }

    if (text === "/briefing") {
      try {
        const briefing = await generateBriefing();
        await sendHTML(briefing);
      } catch (e) {
        await sendMessage(`Error: ${e.message}`).catch(() => { });
      }
      return;
    }

    if (text === "/help") {
      await sendMessage(formatHelpText()).catch(() => { });
      return;
    }

    if (text === "/wallet" || text === "/status") {
      try {
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
        const suffix = text === "/status" && positions.total_positions
          ? `\n\nUse /positions for the numbered list.`
          : "";
        await sendMessage(`${formatWalletStatus(wallet, positions)}${suffix}`).catch(() => { });
      } catch (e) {
        await sendMessage(`Error: ${e.message}`).catch(() => { });
      }
      return;
    }

    if (text === "/config") {
      await sendMessage(formatConfigSnapshot()).catch(() => { });
      return;
    }

    if (text === "/positions") {
      try {
        const { positions, total_positions } = await getMyPositions({ force: true, enrich_gmgn: true });
        if (total_positions === 0) { await sendMessage("No open positions."); return; }
        const cur = config.management.solMode ? "◎" : "$";
        const lines = positions.map((p, i) => {
          const pnl = p.pnl_usd >= 0 ? `+${cur}${p.pnl_usd}` : `-${cur}${Math.abs(p.pnl_usd)}`;
          const age = p.age_minutes != null ? `${p.age_minutes}m` : "?";
          const oor = !p.in_range ? " ⚠️OOR" : "";
          const safety = p.gmgn_security?.risk_level === "high" ? " 🔴" : "";
          return `${i + 1}. ${p.pair} | ${cur}${p.total_value_usd} | PnL: ${pnl} | fees: ${cur}${p.unclaimed_fees_usd} | ${age}${oor}${safety}`;
        });
        await sendMessage(`📊 Open Positions (${total_positions}):\n\n${lines.join("\n")}\n\n/close <n> to close | /set <n> <note> to set instruction`);
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => { }); }
      return;
    }

    if (text === "/tracked") {
      try {
        const { getTrackedPools } = await import("../../tools/pool-tracker.js");
        const tracked = getTrackedPools();
        if (tracked.length === 0) { await sendMessage("No tracked pools."); return; }
        const lines = tracked.map((p, i) => {
          const dateStr = p.first_seen_at ? new Date(p.first_seen_at).toLocaleTimeString() : "?";
          return `${i + 1}. ${p.pool_name || p.pool_address.slice(0, 8)} | ${p.pool_address.slice(0, 8)}... | baseline VCP: ${p.initial_volume_change_pct}% | queued: ${dateStr}`;
        });
        await sendMessage(`🔭 Tracked Pools (${tracked.length}):\n\n${lines.join("\n")}\n\n/deque <n> to remove`);
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => { }); }
      return;
    }

    const dequeMatch = text.match(/^\/deque\s+(\d+)$/i);
    if (dequeMatch) {
      try {
        const idx = parseInt(dequeMatch[1]) - 1;
        const { getTrackedPools, discardTrackedPool } = await import("../../tools/pool-tracker.js");
        const tracked = getTrackedPools();
        if (idx < 0 || idx >= tracked.length) { await sendMessage("Invalid number. Use /tracked first."); return; }
        const pos = tracked[idx];
        discardTrackedPool(pos.pool_address);
        await sendMessage(`✅ Removed ${pos.pool_name || pos.pool_address.slice(0, 8)} from tracked pools.`);
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => { }); }
      return;
    }

    const poolMatch = text.match(/^\/pool\s+(\d+)$/i);
    if (poolMatch) {
      try {
        const idx = parseInt(poolMatch[1]) - 1;
        const { positions } = await getMyPositions({ force: true });
        if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
        const pos = positions[idx];
        await sendMessage([
          `${idx + 1}. ${pos.pair}`,
          `Pool: ${pos.pool}`,
          `Position: ${pos.position}`,
          `Range: ${pos.lower_bin} → ${pos.upper_bin} | active ${pos.active_bin}`,
          `PnL: ${pos.pnl_pct ?? "?"}% | fees: ${config.management.solMode ? "◎" : "$"}${pos.unclaimed_fees_usd ?? "?"}`,
          `Value: ${config.management.solMode ? "◎" : "$"}${pos.total_value_usd ?? "?"}`,
          `Age: ${pos.age_minutes ?? "?"}m | ${pos.in_range ? "IN RANGE" : `OOR ${pos.minutes_out_of_range ?? 0}m`}`,
          pos.instruction ? `Note: ${pos.instruction}` : null,
        ].filter(Boolean).join("\n"));
      } catch (e) {
        await sendMessage(`Error: ${e.message}`).catch(() => { });
      }
      return;
    }

    const closeMatch = text.match(/^\/close\s+(\d+)$/i);
    if (closeMatch) {
      try {
        const idx = parseInt(closeMatch[1]) - 1;
        const { positions } = await getMyPositions({ force: true });
        if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
        const pos = positions[idx];
        await sendMessage(`Closing ${pos.pair}...`);
        const result = await closePosition({
          position_address: pos.position,
          reason: `Manual close via Telegram /close (index ${idx + 1})`,
        });
        if (!result.success) {
          await sendMessage(`❌ Close failed: ${JSON.stringify(result)}`);
        } else if (result.base_mint) {
          try {
            const bal = await getWalletBalances();
            const token = bal.tokens?.find(t => t.mint === result.base_mint);
            if (token && token.usd >= 0.10) {
              await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: token.balance });
            }
          } catch (e) {
            log("telegram", "Auto swap after manual close failed: " + e.message);
          }
        }
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => { }); }
      return;
    }

    if (text === "/closeall") {
      try {
        const { positions } = await getMyPositions({ force: true });
        if (!positions.length) { await sendMessage("No open positions."); return; }
        await sendMessage(`Closing ${positions.length} position(s)...`);
        const results = [];
        for (const pos of positions) {
          try {
            const result = await closePosition({
              position_address: pos.position,
              reason: "Manual close via Telegram /closeall",
            });
            results.push(`${pos.pair}: ${result.success ? "closed" : `failed (${result.error || "unknown"})`}`);
          } catch (error) {
            results.push(`${pos.pair}: failed (${error.message})`);
          }
        }
        await sendMessage(`Close-all finished.\n\n${results.join("\n")}`).catch(() => { });
      } catch (e) {
        await sendMessage(`Error: ${e.message}`).catch(() => { });
      }
      return;
    }

    const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
    if (setMatch) {
      try {
        const idx = parseInt(setMatch[1]) - 1;
        const note = setMatch[2].trim();
        const { positions } = await getMyPositions({ force: true });
        if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
        const pos = positions[idx];
        setPositionInstruction(pos.position, note);
        await sendMessage(`✅ Note set for ${pos.pair}:\n"${note}"`);
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => { }); }
      return;
    }

    const setCfgMatch = text.match(/^\/setcfg\s+([A-Za-z0-9_]+)\s+(.+)$/i);
    if (setCfgMatch) {
      try {
        const key = setCfgMatch[1];
        const value = parseConfigValue(setCfgMatch[2]);
        const result = await executeTool("update_config", {
          changes: { [key]: value },
          reason: "Telegram slash command /setcfg",
        });
        if (!result?.success) {
          await sendMessage(`Config update failed.\nUnknown: ${(result?.unknown || []).join(", ") || "none"}`).catch(() => { });
          return;
        }
        await sendMessage(`✅ Updated ${key} = ${JSON.stringify(value)}`).catch(() => { });
      } catch (e) {
        await sendMessage(`Error: ${e.message}`).catch(() => { });
      }
      return;
    }

    if (text === "/screen") {
      try {
        await sendMessage(await runDeterministicScreen(5)).catch(() => { });
      } catch (e) {
        await sendMessage(`Error: ${e.message}`).catch(() => { });
      }
      return;
    }

    if (text === "/candidates") {
      await sendMessage(describeLatestCandidates(5)).catch(() => { });
      return;
    }

    const deployMatch = text.match(/^\/deploy\s+(\d+)$/i);
    if (deployMatch) {
      try {
        const idx = parseInt(deployMatch[1]) - 1;
        const { candidate, result, deployAmount, binsBelow } = await deployLatestCandidate(idx);
        const coverage = result.range_coverage
          ? `Range: ${fmtPct(result.range_coverage.downside_pct)} downside | ${fmtPct(result.range_coverage.upside_pct)} upside`
          : `Strategy: ${config.strategy.strategy} | binsBelow: ${binsBelow}`;
        await sendMessage([
          `✅ Deployed ${candidate.name}`,
          `Pool: ${candidate.pool}`,
          `Amount: ${deployAmount} SOL`,
          coverage,
          `Position: ${result.position || "n/a"}`,
          result.txs?.length ? `Tx: ${result.txs[0]}` : null,
        ].filter(Boolean).join("\n")).catch(() => { });
      } catch (e) {
        await sendMessage(`Error: ${e.message}`).catch(() => { });
      }
      return;
    }

    if (text === "/pause") {
      stopCronJobs();
      setCronStarted(false);
      await sendMessage("⏸ Paused autonomous cycles. Telegram control still works. Use /resume to start again.").catch(() => { });
      return;
    }

    if (text === "/resume") {
      if (!isCronStarted()) {
        setCronStarted(true);
        startCronJobs();
        await sendMessage("▶️ Autonomous cycles resumed.").catch(() => { });
      } else {
        await sendMessage("Autonomous cycles are already running.").catch(() => { });
      }
      return;
    }

    if (text.startsWith("/gmgn")) {
      const mint = text.split(" ")[1];
      if (!mint) {
        await sendMessage("Usage: /gmgn <mint_address>");
      } else {
        try {
          const { getGMGNTokenAnalysis, formatGMGNReport } = await import("../../tools/gmgn.js");
          await sendMessage(`Fetching GMGN report for ${mint}...`);
          const data = await getGMGNTokenAnalysis(mint);
          await sendMessage(formatGMGNReport(mint, data));
        } catch (e) {
          await sendMessage(`Error: ${e.message}`);
        }
      }
      return;
    }

    if (text === "/thresholds") {
      const s = config.screening;
      const perf = getPerformanceSummary();
      const lines = [
        "Current screening thresholds:",
        `  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`,
        `  minOrganic:           ${s.minOrganic}`,
        `  minHolders:           ${s.minHolders}`,
        `  minTvl:               ${s.minTvl}`,
        `  maxTvl:               ${s.maxTvl}`,
        `  minVolume:            ${s.minVolume}`,
        `  minTokenFeesSol:      ${s.minTokenFeesSol}`,
        `  maxBundlePct:         ${s.maxBundlePct}`,
        `  maxBotHoldersPct:     ${s.maxBotHoldersPct}`,
        `  maxTop10Pct:          ${s.maxTop10Pct}`,
        `  timeframe:            ${s.timeframe}`,
        ""
      ];
      if (perf) {
        lines.push(`Based on ${perf.total_positions_closed} closed positions`);
        lines.push(`Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        lines.push("No closed positions yet — thresholds are preset defaults.");
      }
      await sendMessage(lines.join("\n"));
      return;
    }

    if (text.startsWith("/learn")) {
      try {
        const parts = text.split(" ");
        const poolArg = parts[1] || null;
        let poolsToStudy = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          await sendMessage("Fetching top pool candidates to study...");
          const { candidates } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) {
            await sendMessage("No eligible pools found to study.");
            return;
          }
          poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
        }

        const poolList = poolsToStudy.map((p, i) => `${i + 1}. ${p.name} (${p.pool})`).join("\n");
        await sendMessage(`Studying top LPers across ${poolsToStudy.length} pools...\n${poolList}`);

        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:\n\n${poolList}\n\nFor each pool, call study_top_lpers then move to the next. After studying all pools:\n1. Identify patterns that appear across multiple pools.\n2. Note pool-specific patterns where behaviour differs significantly.\n3. Derive 4-8 concrete, actionable lessons using add_lesson.\n4. Summarize what you learned.`,
          config.llm.maxSteps, [], "GENERAL"
        );
        await sendMessage(reply);
      } catch (e) {
        await sendMessage(`Error: ${e.message}`);
      }
      return;
    }

    if (text === "/evolve") {
      try {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          await sendMessage(`Need at least 5 closed positions to evolve. ${needed} more needed.`);
          return;
        }
        const fs = await import("fs");
        const lessonsData = JSON.parse(fs.default.readFileSync("./lessons.json", "utf8"));
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          await sendMessage("No threshold changes needed — current settings already match performance data.");
        } else {
          reloadScreeningThresholds();
          const lines = ["Thresholds evolved:"];
          for (const [key, val] of Object.entries(result.changes)) {
            lines.push(`  ${key}: ${result.rationale[key]}`);
          }
          lines.push("\nSaved to user-config.json. Applied immediately.");
          await sendMessage(lines.join("\n"));
        }
      } catch (e) {
        await sendMessage(`Error: ${e.message}`);
      }
      return;
    }

    if (text === "/stop") {
      await shutdown();
      return;
    }

    if (text === "/hive" || text === "/hive pull") {
      try {
        const enabled = isHiveMindEnabled();
        const agentId = ensureAgentId();
        if (!enabled) {
          await sendMessage(`HiveMind: disabled\nAgent ID: ${agentId}\nSet hiveMindApiKey to connect.`).catch(() => { });
          return;
        }
        const isManualPull = text === "/hive pull";
        const pullMode = getHiveMindPullMode();
        const [registerResult, lessons, presets] = await Promise.all([
          registerHiveMindAgent({ reason: isManualPull ? "telegram_pull" : "telegram_status" }),
          (pullMode === "auto" || isManualPull) ? pullHiveMindLessons(12) : Promise.resolve(null),
          (pullMode === "auto" || isManualPull) ? pullHiveMindPresets() : Promise.resolve(null),
        ]);
        await sendMessage([
          "HiveMind: enabled",
          `Agent ID: ${agentId}`,
          `URL: ${config.hiveMind.url}`,
          `Pull mode: ${pullMode}`,
          `Register: ${registerResult ? "ok" : "warn"}`,
          `Shared lessons: ${Array.isArray(lessons) ? lessons.length : (pullMode === "manual" ? "manual" : 0)}`,
          `Presets: ${Array.isArray(presets) ? presets.length : (pullMode === "manual" ? "manual" : 0)}`,
          isManualPull ? "Manual pull: completed" : null,
        ].join("\n")).catch(() => { });
      } catch (e) {
        await sendMessage(`HiveMind error: ${e.message}`).catch(() => { });
      }
      return;
    }

    setCliBusy(true);
    let liveMessage = null;
    try {
      log("telegram", `Incoming: ${text}`);
      const isScreenOnly = /^\/screen\b/i.test(text) || /\bscreen\s+only\b/i.test(text);
      const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
      const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
      const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
      const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
      
      liveMessage = await createLiveMessage("🤖 Live Update", `Request: ${text.slice(0, 240)}`);
      
      const goal = isScreenOnly
        ? `SCREEN ONLY (NO DEPLOY)

You must ONLY research/screen and return recommendations. Do NOT deploy, do NOT call deploy_position, do NOT claim/close/swap. Provide 1-3 best candidates with concise reasons and key metrics.

User request: ${text}`
        : text;

      const { content } = await agentLoop(goal, config.llm.maxSteps, sessionHistory, agentRole, agentModel, null, {
        requireTool: true, // Only if it's not standard chat
        interactive: true,
        toolBlacklist: isScreenOnly ? ["deploy_position", "close_position", "claim_fees", "swap_token"] : [],
        onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
      });
      appendHistory(text, content);
      const reply = stripThink(content);
      if (liveMessage) await liveMessage.finalize(reply);
      else await sendLongPlainText(reply);
    } catch (e) {
      if (liveMessage) await liveMessage.fail(e.message).catch(() => { });
      else await sendMessage(`Error: ${e.message}`).catch(() => { });
    } finally {
      setCliBusy(false);
      refreshPrompt();
      drainTelegramQueue().catch(() => { });
    }
  }

  return telegramHandler;
}
