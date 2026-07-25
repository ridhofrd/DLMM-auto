import { getMyPositions } from "../../tools/dlmm.js";
import { resolvePendingPeak, resolvePendingTrailingDrop } from "../../state.js";
import { log } from "../../logger.js";
import { config } from "../../config.js";

const _peakConfirmTimers = new Map();
const _trailingDropConfirmTimers = new Map();
const TRAILING_PEAK_CONFIRM_DELAY_MS = 5_000;
const TRAILING_PEAK_CONFIRM_TOLERANCE = 0.85;
const TRAILING_DROP_CONFIRM_DELAY_MS = 3_000;
const TRAILING_DROP_CONFIRM_TOLERANCE_PCT = 1.0;

// Need a way to trigger management cycle from here when a trailing drop confirms
let _triggerManagementFn = null;
export function setManagementTrigger(fn) {
  _triggerManagementFn = fn;
}

export function schedulePeakConfirmation(positionAddress) {
  if (!positionAddress || _peakConfirmTimers.has(positionAddress)) return;

  const timer = setTimeout(async () => {
    _peakConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p) => p.position === positionAddress);
      resolvePendingPeak(positionAddress, position?.pnl_pct ?? null, TRAILING_PEAK_CONFIRM_TOLERANCE);
    } catch (error) {
      log("state_warn", `Peak confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, TRAILING_PEAK_CONFIRM_DELAY_MS);

  _peakConfirmTimers.set(positionAddress, timer);
}

export function scheduleTrailingDropConfirmation(positionAddress) {
  if (!positionAddress || _trailingDropConfirmTimers.has(positionAddress)) return;

  const timer = setTimeout(async () => {
    _trailingDropConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p) => p.position === positionAddress);
      const resolved = resolvePendingTrailingDrop(
        positionAddress,
        position?.pnl_pct ?? null,
        config.management.trailingDropPct,
        TRAILING_DROP_CONFIRM_TOLERANCE_PCT,
      );
      if (resolved?.confirmed) {
        log("state", `[Trailing recheck] Confirmed trailing exit for ${positionAddress} — triggering management`);
        if (_triggerManagementFn) {
          _triggerManagementFn({ silent: true }).catch((e) => log("cron_error", `Trailing recheck management failed: ${e.message}`));
        }
      }
    } catch (error) {
      log("state_warn", `Trailing drop confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, TRAILING_DROP_CONFIRM_DELAY_MS);

  _trailingDropConfirmTimers.set(positionAddress, timer);
}
