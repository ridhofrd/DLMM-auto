import { checkSuspectPnl, getDeterministicCloseRule, checkVolumeGuard } from "../domain/position.js";
import { log } from "../../logger.js";
import { getMyPositions, closePosition, claimFees } from "../../tools/dlmm.js";
import { getWalletBalances, swapToken } from "../../tools/wallet.js";
import { config } from "../../config.js";
import { isEnabled as telegramEnabled, createLiveMessage, sendLongPlainText, notifyOutOfRange } from "../../telegram.js";
import { getTrackedPosition, updatePnlAndCheckExits, queuePeakConfirmation, queueTrailingDropConfirmation } from "../../state.js";
import { recordPositionSnapshot, recallForPool } from "../../pool-memory.js";
import { agentLoop } from "../../agent.js";

import { stripThink, shouldUsePnlRecheck, formatCloseReasonForAlert } from "../utils/helpers.js";
import { schedulePeakConfirmation, scheduleTrailingDropConfirmation } from "./trailing-confirm.js";
import { isManagementBusy, setManagementBusy, timers, getScreeningLastTriggered } from "./state.js";

let _triggerScreeningFn = null;
export function setScreeningTrigger(fn) {
  _triggerScreeningFn = fn;
}

const _volumeGuardStrikes = new Map();

export async function runManagementCycle({ silent = false } = {}) {
  if (isManagementBusy()) return null;
  setManagementBusy(true);
  timers.managementLastRun = Date.now();
  log("cron", "Starting management cycle");
  let mgmtReport = null;
  let positions = [];
  let liveMessage = null;
  const screeningCooldownMs = 5 * 60 * 1000;

  try {
    if (!silent && telegramEnabled()) {
      liveMessage = await createLiveMessage("🔄 Jangkrik Bos!!!(Management)", "Posisi sekarang:");
    }
    const livePositions = await getMyPositions({ force: true }).catch(() => null);
    positions = livePositions?.positions || [];

    const { getTrackedPools } = await import("../../tools/pool-tracker.js");
    const trackedPools = getTrackedPools();
    const formatObs = () => {
      if (trackedPools.length === 0) return "";
      return "\n\nSedang dipantau (" + trackedPools.length + "):\n" + trackedPools.map(p => {
        const ageMs = Date.now() - new Date(p.first_seen_at).getTime();
        return `🔭 ${p.pool_name}: ${(ageMs / 60000).toFixed(1)}m / ${config.screening.observationWindowMin}m`;
      }).join("\n");
    };

    if (positions.length === 0) {
      log("cron", "No open positions — triggering screening cycle");
      mgmtReport = "gaada posisi bos" + formatObs();
      if (_triggerScreeningFn) {
        _triggerScreeningFn().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      }
      return mgmtReport;
    }

    // Snapshot + load pool memory
    const positionData = positions.map((p) => {
      recordPositionSnapshot(p.pool, p);
      return { ...p, recall: recallForPool(p.pool) };
    });

    // JS trailing TP check
    const exitMap = new Map();
    for (const p of positionData) {
      if (
        !p.pnl_pct_suspicious &&
        queuePeakConfirmation(p.position, p.pnl_pct, { immediate: !shouldUsePnlRecheck() }) &&
        shouldUsePnlRecheck()
      ) {
        schedulePeakConfirmation(p.position);
      }
      const exit = updatePnlAndCheckExits(p.position, p, config.management);
      if (exit) {
        if (exit.action === "TRAILING_TP" && exit.needs_confirmation && shouldUsePnlRecheck()) {
          if (queueTrailingDropConfirmation(p.position, exit.peak_pnl_pct, exit.current_pnl_pct, config.management.trailingDropPct)) {
            scheduleTrailingDropConfirmation(p.position);
          }
          continue;
        }
        exitMap.set(p.position, exit.reason);
        log("state", `Exit alert for ${p.pair}: ${exit.reason}`);
      }
    }

    // ── Deterministic rule checks (no LLM) ──────────────────────────
    const actionMap = new Map();
    for (const p of positionData) {
      if (exitMap.has(p.position)) {
        actionMap.set(p.position, { action: "CLOSE", rule: "exit", reason: exitMap.get(p.position) });
        continue;
      }
      if (p.instruction) {
        actionMap.set(p.position, { action: "INSTRUCTION" });
        continue;
      }

      const vg = config.management.volumeGuard;
      if (vg?.enabled && (p.age_minutes ?? 0) >= vg.waitMinutes) {
        try {
          const { getPoolDetail } = await import("../../tools/screening.js");
          const detail = await getPoolDetail({ pool_address: p.pool, timeframe: vg.timeframe });
          
          const currentStrikes = _volumeGuardStrikes.get(p.position) ?? 0;
          const vgResult = checkVolumeGuard(p, detail, currentStrikes, vg);
          
          if (vgResult.newStrikes === 0 && currentStrikes > 0 && !vgResult.action) {
            _volumeGuardStrikes.delete(p.position);
          } else if (vgResult.newStrikes > 0) {
            _volumeGuardStrikes.set(p.position, vgResult.newStrikes);
          }

          if (vgResult.logMessage) log("cron", vgResult.logMessage);

          if (vgResult.action) {
            _volumeGuardStrikes.delete(p.position);
            actionMap.set(p.position, vgResult.action);
            continue;
          }
        } catch (e) {
          log("cron", `VolumeGuard fetch failed for ${p.pair}: ${e.message}`);
        }
      }

      const tracked = getTrackedPosition(p.position);
      const hasTrackedAmount = !!(tracked && tracked.amount_sol);
      const suspectCheck = checkSuspectPnl(p, hasTrackedAmount);
      if (suspectCheck.isSuspect && suspectCheck.warning) {
        log("cron_warn", suspectCheck.warning);
      }

      const closeRule = getDeterministicCloseRule(p, config.management, suspectCheck.isSuspect);
      if (closeRule) {
        actionMap.set(p.position, closeRule);
        continue;
      }
      if ((p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) {
        actionMap.set(p.position, { action: "CLAIM" });
        continue;
      }
      actionMap.set(p.position, { action: "STAY" });
    }

    // ── Build JS report ──────────────────────────────────────────────
    const totalValue = positionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
    const totalUnclaimed = positionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);

    const reportLines = positionData.map((p) => {
      const act = actionMap.get(p.position);
      const inRange = p.in_range ? "🟢 IN" : `🔴 OOR ${p.minutes_out_of_range ?? 0}m`;
      const val = config.management.solMode ? `◎${p.total_value_usd ?? "?"}` : `$${p.total_value_usd ?? "?"}`;
      const unclaimed = config.management.solMode ? `◎${p.unclaimed_fees_usd ?? "?"}` : `$${p.unclaimed_fees_usd ?? "?"}`;
      const statusLabel = act.action === "INSTRUCTION" ? "HOLD (instruction)" : act.action;
      let line = `**${p.pair}** | PnL: ${p.pnl_pct ?? "?"}% ${inRange} | ${statusLabel}`;
      if (p.instruction) line += `\\nNote: "${p.instruction}"`;
      if (act.action === "CLOSE" && act.rule === "exit") line += `\\n⚡ Trailing TP: ${act.reason}`;
      if (act.action === "CLOSE" && act.rule && act.rule !== "exit") line += `\\nRule ${act.rule}: ${act.reason}`;
      if (act.action === "CLAIM") line += `\\n→ Claiming fees`;
      return line;
    });

    const needsAction = [...actionMap.values()].filter(a => a.action !== "STAY");
    const actionSummary = needsAction.length > 0
      ? needsAction.map(a => a.action === "INSTRUCTION" ? "EVAL instruction" : `${a.action}${a.reason ? ` (${a.reason})` : ""}`).join(", ")
      : "no action";

    const cur = config.management.solMode ? "◎" : "$";
    mgmtReport = reportLines.join("\n\n") +
      `\n\nLaporan sekarang bos: 💼 ${positions.length} posisi | ${cur}${totalValue.toFixed(4)} | ${actionSummary}` + formatObs();

    // ── Execute Actions ──────────────────────────────
    const actionPositions = positionData.filter(p => {
      const a = actionMap.get(p.position);
      return a.action !== "STAY";
    });

    if (actionPositions.length > 0) {
      const llmActionPositions = actionPositions.filter(p => actionMap.get(p.position).action === "INSTRUCTION");
      const directActionPositions = actionPositions.filter(p => actionMap.get(p.position).action !== "INSTRUCTION");

      if (directActionPositions.length > 0) {
        log("cron", `Management: ${directActionPositions.length} direct action(s) needed — executing via JS`);
        let directReport = [];
        for (const p of directActionPositions) {
          const act = actionMap.get(p.position);
          if (act.action === "CLOSE") {
            log("cron", `Executing direct CLOSE for ${p.pair}: ${act.reason}`);
            _volumeGuardStrikes.delete(p.position);
            try {
              await liveMessage?.toolStart("close_position");
              const result = await closePosition({
                position_address: p.position,
                reason: formatCloseReasonForAlert(act, p),
              });
              let msg = `[CLOSE] ${p.pair}: ${result.success ? "Success" : "Failed - " + result.error}`;
              if (result.success && result.base_mint) {
                try {
                  const bal = await getWalletBalances();
                  const token = bal.tokens?.find(t => t.mint === result.base_mint);
                  if (token && token.usd >= 0.10) {
                    log("state", `[Management] Auto-swapping ${token.symbol || result.base_mint.slice(0, 8)} ($${token.usd.toFixed(2)}) → SOL`);
                    await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: token.balance });
                    msg += ` (Auto-swapped ${token.symbol || "token"} → SOL)`;
                  }
                } catch (swapErr) {
                  log("state", `[Management] Auto-swap failed: ${swapErr.message}`);
                }
              }
              await liveMessage?.toolFinish("close_position", result, result.success);
              directReport.push(msg);
            } catch (e) {
              await liveMessage?.toolFinish("close_position", e.message, false);
              directReport.push(`[CLOSE] ${p.pair}: Failed - ${e.message}`);
            }
          } else if (act.action === "CLAIM") {
            log("cron", `Executing direct CLAIM for ${p.pair}`);
            try {
              await liveMessage?.toolStart("claim_fees");
              const result = await claimFees({ position_address: p.position });
              await liveMessage?.toolFinish("claim_fees", result, result.success);
              directReport.push(`[CLAIM] ${p.pair}: ${result.success ? "Success" : "Failed - " + result.error}`);
            } catch (e) {
              await liveMessage?.toolFinish("claim_fees", e.message, false);
              directReport.push(`[CLAIM] ${p.pair}: Failed - ${e.message}`);
            }
          }
        }
        mgmtReport += `\n\n**Direct Actions Executed:**\n` + directReport.join("\n");
      }

      if (llmActionPositions.length > 0) {
        log("cron", `Management: ${llmActionPositions.length} INSTRUCTION(s) needed — invoking LLM [model: ${config.llm.managementModel}]`);

        const actionBlocks = llmActionPositions.map((p) => {
          const act = actionMap.get(p.position);
          return [
            `POSITION: ${p.pair} (${p.position})`,
            `  pool: ${p.pool}`,
            `  action: ${act.action}`,
            `  pnl_pct: ${p.pnl_pct}% | unclaimed_fees: ${cur}${p.unclaimed_fees_usd} | value: ${cur}${p.total_value_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
            `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
            p.instruction ? `  instruction: "${p.instruction}"` : null,
          ].filter(Boolean).join("\n");
        }).join("\n\n");

        const { content } = await agentLoop(`
MANAGEMENT ACTION REQUIRED — ${llmActionPositions.length} position(s)

${actionBlocks}

RULES:
- INSTRUCTION: evaluate the instruction condition. If met → call close_position. If not → HOLD, do nothing.

Execute the required actions.
After executing, write a brief one-line result per position.
        `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 2048, {
          onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
          onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
        });

        mgmtReport += `\n\n**LLM Actions:**\n${content}`;
      }
    } else {
      log("cron", "Management: all positions STAY — skipping LLM");
      await liveMessage?.note("No tool actions needed.");
    }

    // Trigger screening after management
    const afterPositions = await getMyPositions({ force: true }).catch(() => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
    if (afterCount < config.risk.maxPositions && Date.now() - getScreeningLastTriggered() > screeningCooldownMs) {
      log("cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
      if (_triggerScreeningFn) {
        _triggerScreeningFn().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      }
    }
  } catch (error) {
    log("cron_error", `Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    setManagementBusy(false);
    if (!silent && telegramEnabled()) {
      if (mgmtReport) {
        const mgmtOut = stripThink(mgmtReport);
        if (liveMessage) await liveMessage.finalize(mgmtOut).catch(() => { });
        else sendLongPlainText(`🔄 Management Cycle\n\n${mgmtOut}`).catch(() => { });
      }
      for (const p of positions) {
        if (!p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
          notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => { });
        }
      }
    }
  }
  return mgmtReport;
}
