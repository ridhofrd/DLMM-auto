import { evaluateTrackedPool } from "./observation.js";

describe("Domain: Observation Logic", () => {
  const config = {
    observationWindowMin: 15,
    accelerationThresholdPct: 5,
  };

  const pool = {
    first_seen_at: new Date("2026-07-25T01:00:00Z").toISOString(),
    initial_volume_change_pct: 10,
  };

  it("should return WAIT if age < observationWindowMin", () => {
    // 10 mins later
    const now = new Date("2026-07-25T01:10:00Z").getTime();
    const result = evaluateTrackedPool(pool, {}, config, now);
    expect(result.action).toBe("WAIT");
  });

  it("should return DISCARD if currentDetail is null (fetch failed)", () => {
    // 20 mins later
    const now = new Date("2026-07-25T01:20:00Z").getTime();
    const result = evaluateTrackedPool(pool, null, config, now);
    expect(result.action).toBe("DISCARD");
    expect(result.reason).toContain("Failed to fetch");
  });

  it("should return DISCARD if volume did not accelerate enough", () => {
    const now = new Date("2026-07-25T01:20:00Z").getTime();
    // VCP went from 10 -> 14 (delta 4). Threshold is 5.
    const result = evaluateTrackedPool(pool, { volume_change_pct: 14 }, config, now);
    expect(result.action).toBe("DISCARD");
    expect(result.delta).toBe(4);
    expect(result.reason).toContain("did not accelerate enough");
  });

  it("should return PROMOTE if volume accelerated past threshold", () => {
    const now = new Date("2026-07-25T01:20:00Z").getTime();
    // VCP went from 10 -> 16 (delta 6). Threshold is 5.
    const result = evaluateTrackedPool(pool, { volume_change_pct: 16 }, config, now);
    expect(result.action).toBe("PROMOTE");
    expect(result.delta).toBe(6);
  });
});
