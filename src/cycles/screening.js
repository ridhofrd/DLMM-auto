import { log } from "../../logger.js";
import { getMyPositions, getActiveBin } from "../../tools/dlmm.js";
import { getWalletBalances } from "../../tools/wallet.js";
import { config, computeDeployAmount } from "../../config.js";
import { isEnabled as telegramEnabled, createLiveMessage, sendLongPlainText } from "../../telegram.js";
import { getTopCandidates } from "../../tools/pool-scanner.js";
import { getActiveStrategy } from "../../strategy-library.js";
import { checkSmartWalletsOnPool } from "../../smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "../../tools/token.js";
import { getGMGNTokenAnalysis } from "../../tools/gmgn.js";
import { evaluateTrackedPool } from "../domain/observation.js";
import { recallForPool } from "../../pool-memory.js";
import { appendDecision } from "../../decision-log.js";
import { agentLoop } from "../../agent.js";
import { stageSignals } from "../../signal-tracker.js";
import { getWeightsSummary } from "../../signal-weights.js";

import { stripThink, sanitizeUntrustedPromptText } from "../utils/helpers.js";
import { isScreeningBusy, setScreeningBusy, setScreeningLastTriggered, timers } from "./concurrency.js";

export async function runScreeningCycle({ silent = false } = {}) {
  if (isScreeningBusy()) {
    log("cron", "Screening skipped — previous cycle still running");
    return null;
  }
  setScreeningBusy(true); // set immediately — prevents TOCTOU race with concurrent callers
  setScreeningLastTriggered(Date.now());

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions, preBalance;
  let liveMessage = null;
  let screenReport = null;
  let trackedPools = [];
  let noSlotsForNew = false;
  try {
    const { getTrackedPools } = await import("../../tools/pool-tracker.js");
    [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
    trackedPools = getTrackedPools();
    const totalConsumedSlots = prePositions.total_positions + trackedPools.length;

    // Only skip the cycle if OPEN positions are full. If we have tracked pools taking up slots, we must run the cycle to evaluate/deploy/discard them.
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("cron", `Screening skipped — max open positions reached (${prePositions.total_positions} / ${config.risk.maxPositions})`);
      screenReport = `Screening skipped — max open positions reached (${prePositions.total_positions} / ${config.risk.maxPositions}).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Max open positions reached (${prePositions.total_positions} / ${config.risk.maxPositions})`,
      });
      setScreeningBusy(false);
      return screenReport;
    }

    // Check if we have slots for NEW candidates
    noSlotsForNew = totalConsumedSlots >= config.risk.maxPositions;
    const minRequired = config.management.deployAmountSol + config.management.gasReserve;
    const isDryRun = process.env.DRY_RUN === "true";
    if (!isDryRun && preBalance.sol < minRequired) {
      log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
      screenReport = `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired})`,
      });
      setScreeningBusy(false);
      return screenReport;
    }
  } catch (e) {
    log("cron_error", `Screening pre-check failed: ${e.message}`);
    screenReport = `Screening pre-check failed: ${e.message}`;
    setScreeningBusy(false);
    return screenReport;
  }
  if (!silent && telegramEnabled()) {
    liveMessage = await createLiveMessage("🔍 Screening Cycle", "Scanning candidates...");
  }
  timers.screeningLastRun = Date.now();
  log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);

  // Capture market conditions at screening time
  try {
    const { takeMarketSnapshot } = await import("../../market-snapshot.js");
    await takeMarketSnapshot({ trigger: "screening_cycle" });
  } catch (snapErr) {
    log("snapshot_warn", `Market snapshot failed: ${snapErr.message}`);
  }

  try {
    // Reuse pre-fetched balance — no extra RPC call needed
    const currentBalance = preBalance;
    const deployAmount = computeDeployAmount(currentBalance.sol);
    log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL)`);

    // Load active strategy
    const activeStrategy = getActiveStrategy();
    const strategyBlock = activeStrategy
      ? `ACTIVE STRATEGY: ${activeStrategy.name} — LP: ${activeStrategy.lp_strategy} | bins_above: ${activeStrategy.range?.bins_above ?? 0} (FIXED — never change) | deposit: ${activeStrategy.entry?.single_side === "sol" ? "SOL only (amount_y, amount_x=0)" : "dual-sided"} | best for: ${activeStrategy.best_for}`
      : `No active strategy — use default bid_ask, bins_above: 0, SOL only.`;

    // Fetch top candidates, then recon each sequentially with a small delay to avoid 429s
    const topCandidates = await getTopCandidates({ limit: 10 }).catch(() => null);
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 10);
    const earlyFilteredExamples = topCandidates?.filtered_examples || [];

    const allCandidates = [];
    for (const pool of candidates) {
      const mint = pool.base?.mint;
      const [smartWallets, narrative, tokenInfo, gmgn] = await Promise.allSettled([
        checkSmartWalletsOnPool({ pool_address: pool.pool }),
        mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
        mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
        mint ? getGMGNTokenAnalysis(mint) : Promise.resolve(null),
      ]);
      allCandidates.push({
        pool,
        sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
        n: narrative.status === "fulfilled" ? narrative.value : null,
        ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
        mem: recallForPool(pool.pool),
        gmgn: gmgn.status === "fulfilled" ? gmgn.value : null,
      });
      await new Promise(r => setTimeout(r, 150)); // avoid 429s
    }

    // Hard filters after token recon — block launchpads and excessive Jupiter bot holders
    const filteredOut = [];
    const passing = allCandidates.filter(({ pool, ti }) => {
      const launchpad = ti?.launchpad ?? null;
      if (launchpad && config.screening.allowedLaunchpads?.length > 0 && !config.screening.allowedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — launchpad ${launchpad} not in allow-list`);
        filteredOut.push({ name: pool.name, reason: `launchpad ${launchpad} not in allow-list` });
        return false;
      }
      if (launchpad && config.screening.blockedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — blocked launchpad (${launchpad})`);
        filteredOut.push({ name: pool.name, reason: `blocked launchpad (${launchpad})` });
        return false;
      }
      const botPct = ti?.audit?.bot_holders_pct;
      const maxBotHoldersPct = config.screening.maxBotHoldersPct;
      if (botPct != null && maxBotHoldersPct != null && botPct > maxBotHoldersPct) {
        log("screening", `Bot-holder filter: dropped ${pool.name} — bots ${botPct}% > ${maxBotHoldersPct}%`);
        filteredOut.push({ name: pool.name, reason: `bot holders ${botPct}% > ${maxBotHoldersPct}%` });
        return false;
      }
      return true;
    });

    // Pre-fetch active_bin for all passing candidates in parallel
    const activeBinResults = await Promise.allSettled(
      passing.map(({ pool }) => getActiveBin({ pool_address: pool.pool }))
    );

    // Build compact candidate blocks
    const candidateBlocks = passing.map(({ pool, sw, n, ti, mem, gmgn }, i) => {
      const botPct = ti?.audit?.bot_holders_pct ?? "?";
      const top10Pct = ti?.audit?.top_holders_pct ?? "?";
      const feesSol = ti?.global_fees_sol ?? "?";
      const launchpad = ti?.launchpad ?? null;
      const priceChange = ti?.stats_1h?.price_change;
      const netBuyers = ti?.stats_1h?.net_buyers;
      const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;

      const gmgnParts = [
        gmgn?.security?.is_honeypot ? "honeypot: YES" : null,
        gmgn?.security?.risk_level ? `risk_level: ${gmgn.security.risk_level}` : null,
        gmgn?.stats?.smart_money_count != null ? `smart_money: ${gmgn.stats.smart_money_count}` : null,
        gmgn?.stats?.whale_count != null ? `whales: ${gmgn.stats.whale_count}` : null,
        gmgn?.stats?.sniper_count != null ? `snipers: ${gmgn.stats.sniper_count}` : null,
      ].filter(Boolean).join(", ");

      // OKX signals
      const okxParts = [
        pool.risk_level != null ? `risk=${pool.risk_level}` : null,
        pool.bundle_pct != null ? `bundle=${pool.bundle_pct}%` : null,
        pool.sniper_pct != null ? `sniper=${pool.sniper_pct}%` : null,
        pool.suspicious_pct != null ? `suspicious=${pool.suspicious_pct}%` : null,
        pool.new_wallet_pct != null ? `new_wallets=${pool.new_wallet_pct}%` : null,
        pool.is_rugpull != null ? `rugpull=${pool.is_rugpull ? "YES" : "NO"}` : null,
        pool.is_wash != null ? `wash=${pool.is_wash ? "YES" : "NO"}` : null,
      ].filter(Boolean).join(", ");
      const okxUnavailable = !okxParts && pool.price_vs_ath_pct == null;

      const okxTags = [
        pool.smart_money_buy ? "smart_money_buy" : null,
        pool.kol_in_clusters ? "kol_in_clusters" : null,
        pool.dex_boost ? "dex_boost" : null,
        pool.dex_screener_paid ? "dex_screener_paid" : null,
        pool.dev_sold_all ? "dev_sold_all(bullish)" : null,
      ].filter(Boolean).join(", ");
      const pvpLine = pool.is_pvp
        ? `  pvp: HIGH — rival ${pool.pvp_rival_name || pool.pvp_symbol} (${pool.pvp_rival_mint?.slice(0, 8)}...) has pool ${pool.pvp_rival_pool?.slice(0, 8)}..., tvl=$${pool.pvp_rival_tvl}, holders=${pool.pvp_rival_holders}, fees=${pool.pvp_rival_fees}SOL`
        : null;

      const block = [
        `POOL: ${pool.name} (${pool.pool})`,
        `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.active_tvl}, volatility=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}${pool.token_age_hours != null ? `, age=${pool.token_age_hours}h` : ""}`,
        `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${launchpad ? `, launchpad=${launchpad}` : ""}`,
        gmgnParts ? `  gmgn: ${gmgnParts}` : null,
        pvpLine,
        okxParts ? `  okx: ${okxParts}` : okxUnavailable ? `  okx: unavailable` : null,
        okxTags ? `  tags: ${okxTags}` : null,
        pool.price_vs_ath_pct != null ? `  ath: price_vs_ath=${pool.price_vs_ath_pct}%${pool.top_cluster_trend ? `, top_cluster=${pool.top_cluster_trend}` : ""}` : null,
        `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
        activeBin != null ? `  active_bin: ${activeBin}` : null,
        priceChange != null ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
        n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
        mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
        `  metrics: vol_trend: ${pool.volume_trend} (${pool.volume_change_pct}%)`
      ].filter(Boolean).join("\n");

      if (config.darwin?.enabled) {
        stageSignals(pool.pool, {
          organic_score: pool.organic_score ?? null,
          fee_tvl_ratio: pool.fee_active_tvl_ratio ?? null,
          volume: pool.volume_window ?? null,
          mcap: pool.mcap ?? null,
          holder_count: ti?.holders ?? null,
          smart_wallets_present: (sw?.in_pool?.length ?? 0) > 0,
          narrative_quality: n?.narrative ? "present" : "absent",
          volatility: pool.volatility ?? null,
          volume_trend: pool.volume_trend ?? null,
        });
      }

      return block;
    });

    const weightsSummary = config.darwin?.enabled ? getWeightsSummary() : null;

    // Evaluate tracked pools
    const trackedPoolBlocks = [];
    if (config.screening.enablePoolObservation) {
      const { getPoolDetail } = await import("../../tools/pool-scanner.js");
      for (const p of trackedPools) {
        let detail = null;
        try {
          detail = await getPoolDetail({ pool_address: p.pool_address, timeframe: config.screening.timeframe });
        } catch (e) {
          log("cron_warn", `Failed to fetch detail for tracked pool ${p.pool_name}: ${e.message}`);
        }

        const evalResult = evaluateTrackedPool(p, detail, config.screening);
        
        if (evalResult.action === "PROMOTE") {
          trackedPoolBlocks.push(
            `TRACKED POOL READY FOR EVALUATION: ${p.pool_name} (${p.pool_address})\n` +
            `  baseline_vcp: ${p.initial_volume_change_pct}%\n` +
            `  current_vcp: ${evalResult.newVcp}%\n` +
            `  delta: ${evalResult.delta.toFixed(2)}%\n` +
            `  threshold_required: ${evalResult.thresholdRequired}%\n` +
            `  original_deploy_args: ${JSON.stringify(p.deploy_args)}\n` +
            `  action_required: You MUST call deploy_position using the exact original_deploy_args and add 'volume_trend' = 'Accelerated by +${evalResult.delta.toFixed(2)}%'.`
          );
        } else if (evalResult.action === "DISCARD") {
          log("screening", `Tracked pool ${p.pool_name} discarded: ${evalResult.reason}`);
          const { discardTrackedPool } = await import("../../tools/pool-tracker.js");
          discardTrackedPool(p.pool_address);
          if (!silent && telegramEnabled()) {
            sendLongPlainText(`🔭 Final Decision (Observation Exceeded)\n\nPool: ${p.pool_name}\nDecision: ⛔ DISCARDED\nReason: ${evalResult.reason}`).catch(() => { });
          }
        }
      }
    }

    if (passing.length === 0 && trackedPoolBlocks.length === 0) {
      const combined = filteredOut.length > 0 ? filteredOut : earlyFilteredExamples;
      const combinedExamples = combined.slice(0, 3)
        .map((entry) => `- ${entry.name}: ${entry.reason}`)
        .join("\n");
      screenReport = combinedExamples
        ? `No candidates available.\nFiltered examples:\n${combinedExamples}`
        : `No candidates available (all filtered by launchpad / holder-quality rules).`;
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "No candidates available",
        reason: combinedExamples || "All candidates filtered before deploy",
        rejected: combined.slice(0, 5).map((entry) => `${entry.name}: ${entry.reason}`),
      });
      return screenReport;
    }

    let promptSteps = "";
    if (config.screening.enablePoolObservation) {
      promptSteps = `STEPS:
1. TRACKED POOLS FIRST: Check if there are TRACKED POOLS READY FOR EVALUATION.
   - For EACH tracked pool, you MUST call deploy_position using its exact original_deploy_args. Include 'volume_trend' = 'Accelerated by +X%'. Then stop (do not deploy anything else).

2. NEW CANDIDATES: ${noSlotsForNew ?
          "You currently have NO open slots for new candidates (tracked pools are consuming them). DO NOT queue any new candidates. Report ⛔ NO DEPLOY." :
          `If no tracked pools were deployed, check the PRE-LOADED CANDIDATES.
   - If there are candidates available, pick ONE best candidate. You MUST queue it for observation by calling queue_for_tracking (MUST include 'volume_change_pct' and 'llm_reasoning').
   - When calling queue_for_tracking, calculate bins_below: round((35*1.5) + (volatility/5)*55) clamped to [35,200]. For single-side SOL deploys, set amount_y only, keep amount_x = 0, keep bins_above = 0.`}

3. FINAL REPORTING:
   - If you deployed a tracked pool, report: 🚀 DEPLOYED FROM OBSERVATION (explain why it passed)
   - If you queued a new candidate, report: 🔭 QUEUED FOR OBSERVATION (explain why)
   - If you had no tracked pools and no candidates, report: ⛔ NO DEPLOY`;
    } else {
      promptSteps = `STEPS:
1. Check the PRE-LOADED CANDIDATES.
   - If there are candidates available, evaluate them and pick ONE best candidate.
   - If there are NO candidates available, report ⛔ NO DEPLOY and stop.
2. Call deploy_position to deploy the chosen pool.
3. When calling deploy_position, calculate bins_below:
   bins_below = round((35*1.5) + (volatility/5)*55) clamped to [35,200].
   For single-side SOL deploys, set amount_y only, keep amount_x = 0, keep bins_above = 0.
4. Report your final action in this exact format (no tables, no extra sections):
   🚀 DEPLOYED (or ⛔ NO DEPLOY)`;
    }

    const { content } = await agentLoop(`
SCREENING CYCLE
${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL

${trackedPoolBlocks.length > 0 ? `TRACKED POOLS READY FOR EVALUATION:\n${trackedPoolBlocks.join("\n\n")}\n\n` : ""}PRE-LOADED CANDIDATES (${passing.length} pools):
${candidateBlocks.length > 0 ? candidateBlocks.join("\n\n") : "(No pre-loaded candidates available)"}

${promptSteps}

   <pool name>
   <pool address>

   ◎ <deploy amount> SOL | <strategy> | bin <active_bin>
   Range: <minPrice> → <maxPrice>
   Range cover: <downside %> downside | <upside %> upside | <total width %> total

   IMPORTANT:
   - Do NOT calculate the range percentages yourself.
   - Use the actual deploy_position tool result:
     range_coverage.downside_pct
     range_coverage.upside_pct
     range_coverage.width_pct

   STRATEGY & RANGE (extended — required)
   Strategy: <bid_ask or spot> — why this LP shape for this pool (vs the alternative), and how it fits ACTIVE STRATEGY above.
   Bins: bins_below=<n> bins_above=<m> — cite pool volatility, bin_step, and how wide/tight the range is in practice.
   Price risk: <what happens if price dumps vs pumps relative to your bins; why this asymmetry is acceptable here>
   Tradeoffs: <fee capture vs risk of going OOR; anything you narrowed or widened vs the default formula and why>
   Could have done differently: <one concrete alternative (e.g. wider bins, spot) and why you rejected it>

   MARKET
   Fee/TVL: <x>%
   Volume: $<x>
   TVL: $<x>
   Volatility: <x>
   Organic: <x>
   Mcap: $<x>
   Age: <x>h

   AUDIT
   Top10: <x>%
   Bots: <x>%
   Fees paid: <x> SOL
   Smart wallets: <names or none>

   RISK
   <If OKX advanced/risk data exists, list only the fields that actually exist: Risk level, Bundle, Sniper, Suspicious, ATH distance, Rugpull, Wash.>
   <If only rugpull/wash exist, list just those.>
   <If OKX enrichment is missing, write exactly: OKX: unavailable>

   GMGN
   <If GMGN data exists, list the following fields: Honeypot, Risk Level, Smart Money, Whales, Snipers>
   <If missing, write exactly: GMGN: unavailable>

   WHY THIS WON
   <2-4 concise sentences on why this pool won, key risks, and why it still beat the alternatives>
4. If no pool qualifies, report in this exact format instead:
   ⛔ NO DEPLOY

   Cycle finished with no valid entry.

   BEST LOOKING CANDIDATE
   <name or none>

   WHY SKIPPED
   <2-4 concise sentences explaining why nothing was good enough>

   REJECTED
   <short flat list of top candidate names and why they were skipped>
IMPORTANT:
- Never write "unknown" for OKX. Use real values, omit missing fields, or write exactly "OKX: unavailable".
- MARKET / AUDIT / RISK / WHY THIS WON stay compact and scannable. STRATEGY & RANGE must be substantive (roughly 5–10 short lines), not one-liners.
      `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 2048, {
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
    });
    screenReport = content;
    if (/⛔\s*NO DEPLOY/i.test(content)) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "LLM chose no deploy",
        reason: stripThink(content).slice(0, 500),
      });
    }
  } catch (error) {
    log("cron_error", `Screening cycle failed: ${error.message}`);
    screenReport = `Screening cycle failed: ${error.message}`;
  } finally {
    setScreeningBusy(false);
    if (!silent && telegramEnabled()) {
      if (screenReport) {
        const screenOut = stripThink(screenReport);
        if (liveMessage) await liveMessage.finalize(screenOut).catch(() => { });
        else sendLongPlainText(`🔍 Screening Cycle\n\n${screenOut}`).catch(() => { });
      }
    }
  }
  return screenReport;
}
