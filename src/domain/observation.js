export function evaluateTrackedPool(trackedPool, currentDetail, configScreening, nowMs = Date.now()) {
  const ageMs = nowMs - new Date(trackedPool.first_seen_at).getTime();
  const ageMin = ageMs / (1000 * 60);

  if (ageMin < configScreening.observationWindowMin) {
    return { action: "WAIT", reason: "Still in observation window" };
  }

  if (!currentDetail) {
    return { action: "DISCARD", reason: "Failed to fetch pool data (likely dead/no TVL)" };
  }

  const newVcp = currentDetail.volume_change_pct ?? 0;
  const delta = newVcp - trackedPool.initial_volume_change_pct;

  if (delta >= configScreening.accelerationThresholdPct) {
    return {
      action: "PROMOTE",
      delta,
      newVcp,
      thresholdRequired: configScreening.accelerationThresholdPct
    };
  }

  return {
    action: "DISCARD",
    reason: `Volume did not accelerate enough (${delta.toFixed(2)}% < ${configScreening.accelerationThresholdPct}% req)`,
    delta
  };
}
