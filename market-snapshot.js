/**
 * Market Snapshot — periodic capture of macro + Meteora ecosystem state.
 *
 * Captures:
 *   1. SOL/BTC/ETH prices + 24h changes  (Jupiter Price API)
 *   2. Meteora DLMM ecosystem stats       (Pool Discovery API aggregate)
 *   3. Trending pool conditions            (top pools snapshot)
 *   4. Timestamps for chronological analysis
 *
 * Data stored in market-snapshots.json, one entry per snapshot.
 * Run on a timer or hook into the screening cycle.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_FILE = path.join(__dirname, "market-snapshots.json");
const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const MAX_SNAPSHOTS = 5000; // cap file size

// ─── Token Mints ──────────────────────────────────────────────
const SOL_MINT  = "So11111111111111111111111111111111111111112";
const BTC_MINT  = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh"; // Wrapped BTC (Wormhole)
const ETH_MINT  = "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs"; // Wrapped ETH (Wormhole)
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// ─── Load / Save ──────────────────────────────────────────────
function loadSnapshots() {
  if (!fs.existsSync(SNAPSHOT_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveSnapshots(snapshots) {
  // Trim oldest if over cap
  if (snapshots.length > MAX_SNAPSHOTS) {
    snapshots = snapshots.slice(snapshots.length - MAX_SNAPSHOTS);
  }
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshots, null, 2));
}

// ─── 1. Macro Prices ─────────────────────────────────────────
async function fetchMacroPrices() {
  try {
    const mints = [SOL_MINT, BTC_MINT, ETH_MINT].join(",");
    const res = await fetch(`${JUPITER_PRICE_API}?ids=${mints}&vsToken=${USDC_MINT}`);
    if (!res.ok) throw new Error(`Jupiter price API ${res.status}`);
    const data = await res.json();

    const extract = (mint, symbol) => {
      const entry = data?.data?.[mint];
      return {
        symbol,
        price: entry?.price ? Number(Number(entry.price).toFixed(4)) : null,
      };
    };

    return {
      sol: extract(SOL_MINT, "SOL"),
      btc: extract(BTC_MINT, "BTC"),
      eth: extract(ETH_MINT, "ETH"),
    };
  } catch (error) {
    log("snapshot_warn", `Macro price fetch failed: ${error.message}`);
    return {
      sol: { symbol: "SOL", price: null },
      btc: { symbol: "BTC", price: null },
      eth: { symbol: "ETH", price: null },
    };
  }
}

// ─── 2. Meteora DLMM Ecosystem Stats ─────────────────────────
async function fetchMeteoraEcosystemStats() {
  try {
    // Fetch a broad set of pools to compute ecosystem-level stats
    const url = `${POOL_DISCOVERY_BASE}/pools?page_size=100&filter_by=${encodeURIComponent(
      "pool_type=dlmm&&tvl>=5000"
    )}&timeframe=30m&category=trending`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Pool discovery API ${res.status}`);
    const data = await res.json();
    const pools = Array.isArray(data?.data) ? data.data : [];

    if (pools.length === 0) {
      return { total_pools: 0, error: "no pools returned" };
    }

    // Aggregate ecosystem metrics
    const totalTvl = pools.reduce((s, p) => s + (Number(p.active_tvl) || 0), 0);
    const totalVolume = pools.reduce((s, p) => s + (Number(p.volume) || 0), 0);
    const totalFees = pools.reduce((s, p) => s + (Number(p.fee) || 0), 0);
    const totalSwaps = pools.reduce((s, p) => s + (Number(p.swap_count) || 0), 0);
    const totalTraders = pools.reduce((s, p) => s + (Number(p.unique_traders) || 0), 0);
    const totalPositions = pools.reduce((s, p) => s + (Number(p.open_positions) || 0), 0);
    const totalActivePositions = pools.reduce((s, p) => s + (Number(p.active_positions) || 0), 0);

    // Averages
    const avgVolatility = pools.reduce((s, p) => s + (Number(p.volatility) || 0), 0) / pools.length;
    const avgFeeTvlRatio = pools.reduce((s, p) => s + (Number(p.fee_active_tvl_ratio) || 0), 0) / pools.length;
    const avgOrganic = pools.reduce((s, p) => s + (Number(p.token_x?.organic_score) || 0), 0) / pools.length;

    // Volume/TVL ratios
    const ecosystemVolTvlRatio = totalTvl > 0 ? totalVolume / totalTvl : 0;
    const ecosystemFeeTvlRatio = totalTvl > 0 ? totalFees / totalTvl : 0;

    // Price trend distribution
    const trendCounts = { up: 0, down: 0, sideways: 0, unknown: 0 };
    for (const p of pools) {
      const change = Number(p.pool_price_change_pct || 0);
      if (change > 2) trendCounts.up++;
      else if (change < -2) trendCounts.down++;
      else trendCounts.sideways++;
    }

    // Bin step distribution
    const binStepDist = {};
    for (const p of pools) {
      const bs = p.dlmm_params?.bin_step;
      if (bs) binStepDist[bs] = (binStepDist[bs] || 0) + 1;
    }

    return {
      total_pools: data.total || pools.length,
      sampled_pools: pools.length,
      total_tvl_usd: Math.round(totalTvl),
      total_volume_usd: Math.round(totalVolume),
      total_fees_usd: Math.round(totalFees),
      total_swaps: totalSwaps,
      total_unique_traders: totalTraders,
      total_open_positions: totalPositions,
      total_active_positions: totalActivePositions,
      avg_volatility: Number(avgVolatility.toFixed(2)),
      avg_fee_tvl_ratio: Number(avgFeeTvlRatio.toFixed(4)),
      avg_organic_score: Math.round(avgOrganic),
      ecosystem_vol_tvl_ratio: Number(ecosystemVolTvlRatio.toFixed(4)),
      ecosystem_fee_tvl_ratio: Number(ecosystemFeeTvlRatio.toFixed(4)),
      trend_distribution: trendCounts,
      bin_step_distribution: binStepDist,
    };
  } catch (error) {
    log("snapshot_warn", `Meteora ecosystem stats failed: ${error.message}`);
    return { total_pools: 0, error: error.message };
  }
}

// ─── 3. Trending Pool Snapshot ────────────────────────────────
async function fetchTrendingPoolSnapshot() {
  try {
    const url = `${POOL_DISCOVERY_BASE}/pools?page_size=20&filter_by=${encodeURIComponent(
      "pool_type=dlmm&&tvl>=10000"
    )}&timeframe=30m&category=trending`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Trending pools API ${res.status}`);
    const data = await res.json();
    const pools = Array.isArray(data?.data) ? data.data : [];

    return pools.slice(0, 15).map((p) => ({
      pool: p.pool_address,
      name: p.name,
      base_symbol: p.token_x?.symbol,
      base_mint: p.token_x?.address,
      bin_step: p.dlmm_params?.bin_step || null,
      active_tvl: Math.round(Number(p.active_tvl) || 0),
      volume: Math.round(Number(p.volume) || 0),
      fees: Math.round(Number(p.fee) || 0),
      fee_tvl_ratio: Number((Number(p.fee_active_tvl_ratio) || 0).toFixed(4)),
      volatility: Number((Number(p.volatility) || 0).toFixed(2)),
      organic_score: Math.round(Number(p.token_x?.organic_score) || 0),
      holders: Number(p.base_token_holders) || 0,
      mcap: Math.round(Number(p.token_x?.market_cap) || 0),
      swap_count: Number(p.swap_count) || 0,
      unique_traders: Number(p.unique_traders) || 0,
      active_positions: Number(p.active_positions) || 0,
      open_positions: Number(p.open_positions) || 0,
      price: Number(p.pool_price) || null,
      price_change_pct: Number((Number(p.pool_price_change_pct) || 0).toFixed(2)),
      price_trend: p.price_trend || null,
      volume_change_pct: Number((Number(p.volume_change_pct) || 0).toFixed(2)),
      fee_change_pct: Number((Number(p.fee_change_pct) || 0).toFixed(2)),
    }));
  } catch (error) {
    log("snapshot_warn", `Trending pool snapshot failed: ${error.message}`);
    return [];
  }
}

// ─── Market Session Helper ────────────────────────────────────
function getMarketSession(date = new Date()) {
  const utcHour = date.getUTCHours();
  // Rough sessions based on major market open hours
  if (utcHour >= 0 && utcHour < 8)   return "asia";       // 00:00–08:00 UTC
  if (utcHour >= 8 && utcHour < 14)  return "europe";     // 08:00–14:00 UTC
  if (utcHour >= 14 && utcHour < 21) return "us";         // 14:00–21:00 UTC
  return "late_us";                                         // 21:00–00:00 UTC
}

// ─── Main: Take Snapshot ──────────────────────────────────────

/**
 * Capture a full market snapshot.
 * Call this periodically (e.g., every screening cycle) or on-demand.
 *
 * @param {Object}  opts
 * @param {string}  [opts.trigger]  - What triggered this snapshot ("screening_cycle", "manual", "deploy", "close")
 * @param {Object}  [opts.extra]    - Any extra context to attach (e.g., position info on deploy/close)
 * @returns {Object} The snapshot object
 */
export async function takeMarketSnapshot({ trigger = "manual", extra = null } = {}) {
  const now = new Date();
  const ts = now.toISOString();

  log("snapshot", `Taking market snapshot (trigger: ${trigger})...`);

  // Run all fetches in parallel
  const [macro, ecosystem, trending] = await Promise.all([
    fetchMacroPrices(),
    fetchMeteoraEcosystemStats(),
    fetchTrendingPoolSnapshot(),
  ]);

  const snapshot = {
    timestamp: ts,
    timestamp_unix: now.getTime(),
    market_session: getMarketSession(now),
    day_of_week: now.toLocaleDateString("en-US", { weekday: "long" }),
    trigger,

    // 1. Macro prices
    macro: {
      sol_price: macro.sol.price,
      btc_price: macro.btc.price,
      eth_price: macro.eth.price,
    },

    // 2. Meteora ecosystem aggregate
    ecosystem,

    // 3. Top trending pools at this moment
    trending_pools: trending,

    // 4. Extra context (position info, config state, etc.)
    ...(extra ? { context: extra } : {}),
  };

  // Persist
  const snapshots = loadSnapshots();
  snapshots.push(snapshot);
  saveSnapshots(snapshots);

  log("snapshot", `Snapshot saved (SOL=$${macro.sol.price}, ${ecosystem.sampled_pools || 0} pools sampled, ${trending.length} trending)`);

  return snapshot;
}

/**
 * Get recent snapshots for analysis.
 *
 * @param {Object} opts
 * @param {number} [opts.hours=24]    - Look back N hours
 * @param {number} [opts.limit=100]   - Max snapshots to return
 * @param {string} [opts.trigger]     - Filter by trigger type
 */
export function getMarketSnapshots({ hours = 24, limit = 100, trigger = null } = {}) {
  const snapshots = loadSnapshots();
  const cutoff = Date.now() - hours * 60 * 60 * 1000;

  let filtered = snapshots.filter((s) => s.timestamp_unix >= cutoff);
  if (trigger) filtered = filtered.filter((s) => s.trigger === trigger);

  return filtered.slice(-limit);
}

/**
 * Get a compact summary of the latest snapshot for LLM prompt injection.
 */
export function getLatestSnapshotSummary() {
  const snapshots = loadSnapshots();
  if (snapshots.length === 0) return null;

  const s = snapshots[snapshots.length - 1];
  const age = Math.round((Date.now() - s.timestamp_unix) / 60000);

  return [
    `Market snapshot (${age}m ago, ${s.market_session} session):`,
    `  SOL=$${s.macro.sol_price} | BTC=$${s.macro.btc_price} | ETH=$${s.macro.eth_price}`,
    `  Meteora DLMM: ${s.ecosystem.total_pools} pools, TVL $${(s.ecosystem.total_tvl_usd / 1e6).toFixed(1)}M, Vol $${(s.ecosystem.total_volume_usd / 1e6).toFixed(1)}M`,
    `  Avg volatility: ${s.ecosystem.avg_volatility}, Avg fee/TVL: ${s.ecosystem.avg_fee_tvl_ratio}`,
    `  Trend: ↑${s.ecosystem.trend_distribution?.up || 0} ↓${s.ecosystem.trend_distribution?.down || 0} →${s.ecosystem.trend_distribution?.sideways || 0}`,
    `  Traders: ${s.ecosystem.total_unique_traders}, Swaps: ${s.ecosystem.total_swaps}`,
  ].join("\n");
}
