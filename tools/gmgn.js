import { execSync } from "child_process";
import { log } from "../logger.js";

/**
 * Execute a gmgn-cli command and return parsed JSON.
 */
async function runGmgnCli(command) {
  try {
    // Add --raw to ensure we get single-line JSON, and bypass shell execution policy
    const fullCommand = `npx gmgn-cli ${command} --raw`;
    
    // Use execSync for simplicity in this utility, or could be wrapped in a promise
    const output = execSync(fullCommand, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: "0" }
    });

    return JSON.parse(output.trim());
  } catch (error) {
    const message = error.stdout || error.message;
    throw new Error(`GMGN CLI error: ${message}`);
  }
}

/**
 * Token security / Rug check.
 */
export async function getGMGNTokenSecurity(mint) {
  try {
    const data = await runGmgnCli(`token security --chain sol --address ${mint}`);
    return {
      is_honeypot: data.is_honeypot === "yes" || data.honeypot === 1,
      is_rug: data.rug_ratio > 0.5,
      ownership_renounced: data.owner_renounced === "yes" || data.renounced_mint === true,
      liquidity_locked: data.burn_status === "burn" || parseFloat(data.burn_ratio) > 0.5,
      buy_tax: data.buy_tax,
      sell_tax: data.sell_tax,
      risk_level: (data.rug_ratio > 0.3 || data.honeypot === 1) ? "high" : "low",
      source: "gmgn-cli",
    };
  } catch (error) {
    log("error", `GMGN security CLI failed for ${mint}: ${error.message}`);
    return null;
  }
}

/**
 * Token stats / Smart money activity.
 */
export async function getGMGNTokenStats(mint) {
  try {
    const data = await runGmgnCli(`token info --chain sol --address ${mint}`);
    return {
      smart_money_count: data.wallet_tags_stat?.smart_wallets || 0,
      insider_count: data.stat?.rat_trader_wallets || 0,
      whale_count: data.wallet_tags_stat?.whale_wallets || 0,
      sniper_count: data.wallet_tags_stat?.sniper_wallets || 0,
      dev_holding_pct: data.stat?.creator_hold_rate,
      source: "gmgn-cli",
    };
  } catch (error) {
    log("error", `GMGN stats CLI failed for ${mint}: ${error.message}`);
    return null;
  }
}

/**
 * Historical OHLCV (candlestick) data.
 */
export async function getGMGNKlines(mint, resolution = "1h", limit = 50) {
  try {
    // CLI for klines uses --from/--to instead of --limit. 
    // We'll fetch the last ~24h by default if resolution is 1h and limit is 24.
    const to = Math.floor(Date.now() / 1000);
    const from = to - (limit * 3600); // Approximate based on resolution (assumes 1h here)
    
    // Attempt with resolution only first, as CLI might return a good default set
    const data = await runGmgnCli(`market kline --chain sol --address ${mint} --resolution ${resolution}`);
    return data || [];
  } catch (error) {
    log("error", `GMGN klines CLI failed for ${mint}: ${error.message}`);
    return [];
  }
}

/**
 * Combined token analysis for screening.
 */
export async function getGMGNTokenAnalysis(mint) {
  const [security, stats, klines] = await Promise.all([
    getGMGNTokenSecurity(mint),
    getGMGNTokenStats(mint),
    getGMGNKlines(mint, "1h", 24),
  ]);

  return {
    security,
    stats,
    klines,
  };
}
