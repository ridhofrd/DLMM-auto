/**
 * Pure domain logic for position evaluation and exit rules.
 * Does not perform I/O or state mutation.
 */

/**
 * Checks if a position's PnL is suspicious (e.g., highly negative but position still has value).
 * @param {Object} position 
 * @param {boolean} hasTrackedAmount 
 * @returns {{ isSuspect: boolean, warning?: string }}
 */
export function checkSuspectPnl(position, hasTrackedAmount) {
  if (position.pnl_pct == null) return { isSuspect: false };
  if (position.pnl_pct > -90) return { isSuspect: false };
  if (hasTrackedAmount && (position.total_value_usd ?? 0) > 0.01) {
    return {
      isSuspect: true,
      warning: `Suspect PnL for ${position.pair}: ${position.pnl_pct}% but position still has value — skipping PnL rules`
    };
  }
  return { isSuspect: false };
}

/**
 * Evaluates deterministic close rules (Stop loss, Take profit, Out of range bins).
 * @param {Object} position 
 * @param {Object} managementConfig 
 * @param {boolean} isSuspectPnl 
 * @returns {{ action: string, rule: number, reason: string } | null}
 */
export function getDeterministicCloseRule(position, managementConfig, isSuspectPnl = false) {
  if (!isSuspectPnl && position.pnl_pct != null && position.pnl_pct <= managementConfig.stopLossPct) {
    return {
      action: "CLOSE",
      rule: 1,
      reason: `Stop loss: PnL ${position.pnl_pct}% <= limit ${managementConfig.stopLossPct}%`,
    };
  }
  if (!isSuspectPnl && position.pnl_pct != null && position.pnl_pct >= managementConfig.takeProfitPct) {
    return {
      action: "CLOSE",
      rule: 2,
      reason: `Take profit: PnL ${position.pnl_pct}% >= target ${managementConfig.takeProfitPct}%`,
    };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin + managementConfig.outOfRangeBinsToClose
  ) {
    return {
      action: "CLOSE",
      rule: 3,
      reason: `Pumped above range: active bin ${position.active_bin} > upper ${position.upper_bin} + ${managementConfig.outOfRangeBinsToClose} bins`,
    };
  }
  if (
    position.active_bin != null &&
    position.lower_bin != null &&
    position.active_bin < position.lower_bin - managementConfig.outOfRangeBinsToClose
  ) {
    return {
      action: "CLOSE",
      rule: 4,
      reason: `Dumped below range: active bin ${position.active_bin} < lower ${position.lower_bin} - ${managementConfig.outOfRangeBinsToClose} bins`,
    };
  }
  return null;
}

/**
 * Checks the volume guard logic purely.
 * @param {Object} position 
 * @param {Object} poolDetail 
 * @param {number} currentStrikes 
 * @param {Object} vgConfig 
 * @returns {{ action: Object|null, newStrikes: number, logMessage?: string, resetLog?: boolean }}
 */
export function checkVolumeGuard(position, poolDetail, currentStrikes, vgConfig) {
  if (!vgConfig?.enabled) return { action: null, newStrikes: currentStrikes };
  if ((position.age_minutes ?? 0) < vgConfig.waitMinutes) return { action: null, newStrikes: currentStrikes };

  const requiredStrikes = vgConfig.consecutiveChecks ?? 2;
  const volChange = poolDetail && poolDetail.volume_change_pct != null ? Number(poolDetail.volume_change_pct) : null;

  if (volChange !== null && volChange < vgConfig.minVolumeChangePct) {
    const newStrikes = currentStrikes + 1;
    if (newStrikes >= requiredStrikes) {
      return {
        action: {
          action: "CLOSE",
          rule: "volumeGuard",
          reason: `Volume collapsed ${newStrikes}x consecutively (current: ${volChange.toFixed(1)}% < min: ${vgConfig.minVolumeChangePct}%)`
        },
        newStrikes: 0
      };
    } else {
      return { 
        action: null, 
        newStrikes, 
        logMessage: `VolumeGuard strike ${newStrikes}/${requiredStrikes} for ${position.pair} (vol change: ${volChange.toFixed(1)}%)`
      };
    }
  } else if (volChange !== null) {
    if (currentStrikes > 0) {
      return { action: null, newStrikes: 0, resetLog: true, logMessage: `VolumeGuard strikes reset for ${position.pair} — volume recovered` };
    }
  }

  return { action: null, newStrikes: currentStrikes };
}

/**
 * Checks exit conditions that are based on state (Trailing TP, Out of Range timeout, Low Yield).
 * @param {Object} positionData 
 * @param {Object} statePos 
 * @param {Object} mgmtConfig 
 * @param {number} nowMs - Current time in ms
 * @returns {Object|null}
 */
export function checkExitConditions(positionData, statePos, mgmtConfig, nowMs = Date.now()) {
  const { pnl_pct: currentPnlPct, pnl_pct_suspicious, fee_per_tvl_24h, age_minutes } = positionData;

  // Stop loss check (backup inside state logic)
  if (!pnl_pct_suspicious && currentPnlPct != null && mgmtConfig.stopLossPct != null && currentPnlPct <= mgmtConfig.stopLossPct) {
    return {
      action: "STOP_LOSS",
      reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}%`,
    };
  }

  // Trailing TP
  if (!pnl_pct_suspicious && statePos.trailing_active) {
    const dropFromPeak = statePos.peak_pnl_pct - currentPnlPct;
    if (dropFromPeak >= mgmtConfig.trailingDropPct) {
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${statePos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${mgmtConfig.trailingDropPct}%)`,
        needs_confirmation: true,
        peak_pnl_pct: statePos.peak_pnl_pct,
        current_pnl_pct: currentPnlPct,
        drop_from_peak_pct: dropFromPeak,
      };
    }
  }

  // Out of range too long
  if (statePos.out_of_range_upper_since) {
    const minutesOOR = Math.floor((nowMs - new Date(statePos.out_of_range_upper_since).getTime()) / 60000);
    if (minutesOOR >= mgmtConfig.outOfRangeWaitMinutesUpper) {
      return {
        action: "OUT_OF_RANGE_UPPER",
        reason: `Upper OOR for ${minutesOOR}m (limit: ${mgmtConfig.outOfRangeWaitMinutesUpper}m)`,
      };
    }
  }

  if (statePos.out_of_range_lower_since) {
    const minutesOOR = Math.floor((nowMs - new Date(statePos.out_of_range_lower_since).getTime()) / 60000);
    if (minutesOOR >= mgmtConfig.outOfRangeWaitMinutesLower) {
      return {
        action: "OUT_OF_RANGE_LOWER",
        reason: `Lower OOR for ${minutesOOR}m (limit: ${mgmtConfig.outOfRangeWaitMinutesLower}m)`,
      };
    }
  }

  // Legacy support for older tracked states
  if (statePos.out_of_range_since) {
    const minutesOOR = Math.floor((nowMs - new Date(statePos.out_of_range_since).getTime()) / 60000);
    const legacyWait = mgmtConfig.outOfRangeWaitMinutesUpper ?? 10;
    if (minutesOOR >= legacyWait) {
      return {
        action: "OUT_OF_RANGE",
        reason: `Out of range for ${minutesOOR}m (limit: ${legacyWait}m)`,
      };
    }
  }

  // Low yield
  const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  if (
    fee_per_tvl_24h != null &&
    mgmtConfig.minFeePerTvl24h != null &&
    fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h &&
    (age_minutes == null || age_minutes >= minAgeForYieldCheck)
  ) {
    return {
      action: "LOW_YIELD",
      reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% (age: ${age_minutes ?? "?"}m)`,
    };
  }

  return null;
}
