import {
  checkSuspectPnl,
  getDeterministicCloseRule,
  checkVolumeGuard,
  checkExitConditions
} from './position.js';

describe('Domain: Position Logic', () => {

  describe('checkSuspectPnl', () => {
    it('should not be suspect if pnl_pct is null', () => {
      const result = checkSuspectPnl({ pnl_pct: null }, true);
      expect(result.isSuspect).toBe(false);
    });

    it('should not be suspect if pnl_pct > -90', () => {
      const result = checkSuspectPnl({ pnl_pct: -50 }, true);
      expect(result.isSuspect).toBe(false);
    });

    it('should be suspect if pnl_pct is < -90, has tracked amount, and total_value_usd > 0.01', () => {
      const result = checkSuspectPnl({ pnl_pct: -95, total_value_usd: 0.5, pair: 'SOL/USDC' }, true);
      expect(result.isSuspect).toBe(true);
      expect(result.warning).toContain('Suspect PnL for SOL/USDC: -95%');
    });
  });

  describe('getDeterministicCloseRule', () => {
    const config = { stopLossPct: -15, takeProfitPct: 50, outOfRangeBinsToClose: 10 };

    it('should trigger stop loss', () => {
      const result = getDeterministicCloseRule({ pnl_pct: -20 }, config, false);
      expect(result).toEqual({
        action: 'CLOSE',
        rule: 1,
        reason: 'Stop loss: PnL -20% <= limit -15%'
      });
    });

    it('should trigger take profit', () => {
      const result = getDeterministicCloseRule({ pnl_pct: 60 }, config, false);
      expect(result).toEqual({
        action: 'CLOSE',
        rule: 2,
        reason: 'Take profit: PnL 60% >= target 50%'
      });
    });

    it('should trigger pumped above range', () => {
      const result = getDeterministicCloseRule({ active_bin: 120, upper_bin: 100 }, config, false);
      expect(result).toEqual({
        action: 'CLOSE',
        rule: 3,
        reason: 'Pumped above range: active bin 120 > upper 100 + 10 bins'
      });
    });

    it('should not trigger pumped above range if within tolerance', () => {
      const result = getDeterministicCloseRule({ active_bin: 105, upper_bin: 100 }, config, false);
      expect(result).toBeNull();
    });

    it('should trigger dumped below range', () => {
      const result = getDeterministicCloseRule({ active_bin: 80, lower_bin: 100 }, config, false);
      expect(result).toEqual({
        action: 'CLOSE',
        rule: 4,
        reason: 'Dumped below range: active bin 80 < lower 100 - 10 bins'
      });
    });
  });

  describe('checkVolumeGuard', () => {
    const vgConfig = { enabled: true, waitMinutes: 10, minVolumeChangePct: -50, consecutiveChecks: 2 };

    it('should return no action if not enabled', () => {
      const result = checkVolumeGuard({ age_minutes: 20 }, {}, 1, { enabled: false });
      expect(result.action).toBeNull();
      expect(result.newStrikes).toBe(1);
    });

    it('should return no action if position is too young', () => {
      const result = checkVolumeGuard({ age_minutes: 5 }, {}, 1, vgConfig);
      expect(result.action).toBeNull();
    });

    it('should increment strike if volume drops', () => {
      const result = checkVolumeGuard({ age_minutes: 20, pair: 'SOL/USDC' }, { volume_change_pct: -60 }, 0, vgConfig);
      expect(result.action).toBeNull();
      expect(result.newStrikes).toBe(1);
      expect(result.logMessage).toContain('VolumeGuard strike 1/2');
    });

    it('should trigger CLOSE if required strikes reached', () => {
      const result = checkVolumeGuard({ age_minutes: 20, pair: 'SOL/USDC' }, { volume_change_pct: -60 }, 1, vgConfig);
      expect(result.action).toEqual({
        action: 'CLOSE',
        rule: 'volumeGuard',
        reason: 'Volume collapsed 2x consecutively (current: -60.0% < min: -50%)'
      });
      expect(result.newStrikes).toBe(0);
    });

    it('should reset strikes if volume recovers', () => {
      const result = checkVolumeGuard({ age_minutes: 20, pair: 'SOL/USDC' }, { volume_change_pct: -10 }, 1, vgConfig);
      expect(result.action).toBeNull();
      expect(result.newStrikes).toBe(0);
      expect(result.resetLog).toBe(true);
    });
  });

  describe('checkExitConditions', () => {
    const config = { stopLossPct: -10, trailingDropPct: 5, outOfRangeWaitMinutes: 30, minFeePerTvl24h: 1.0 };
    const now = new Date('2024-01-01T12:30:00Z').getTime();

    it('should trigger STOP_LOSS', () => {
      const result = checkExitConditions({ pnl_pct: -15 }, {}, config, now);
      expect(result.action).toBe('STOP_LOSS');
    });

    it('should trigger TRAILING_TP if dropped from peak', () => {
      const result = checkExitConditions({ pnl_pct: 10 }, { trailing_active: true, peak_pnl_pct: 20 }, config, now);
      expect(result.action).toBe('TRAILING_TP');
      expect(result.needs_confirmation).toBe(true);
      expect(result.drop_from_peak_pct).toBe(10);
    });

    it('should trigger OUT_OF_RANGE if time exceeded', () => {
      const outSince = new Date('2024-01-01T11:50:00Z').toISOString(); // 40 minutes ago
      const result = checkExitConditions({}, { out_of_range_since: outSince }, config, now);
      expect(result.action).toBe('OUT_OF_RANGE');
    });

    it('should trigger LOW_YIELD if yield is low and age is sufficient', () => {
      const result = checkExitConditions({ fee_per_tvl_24h: 0.5, age_minutes: 70 }, {}, config, now);
      expect(result.action).toBe('LOW_YIELD');
    });
  });
});
