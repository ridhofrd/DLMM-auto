import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Keep the JSON file in the root directory
const TRACKER_FILE = path.join(__dirname, "..", "pool-tracker.json");

function loadTracker() {
  if (!fs.existsSync(TRACKER_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(TRACKER_FILE, "utf8"));
  } catch (err) {
    log("pool-tracker", `Error loading tracker file: ${err.message}`);
    return {};
  }
}

function saveTracker(data) {
  try {
    fs.writeFileSync(TRACKER_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    log("pool-tracker", `Error saving tracker file: ${err.message}`);
  }
}

/**
 * Adds a pool to the tracking queue.
 * @param {string} pool_address 
 * @param {Object} deploy_args Arguments to pass to deploy_position later
 * @param {number} initial_volume_change_pct The baseline velocity
 * @param {string} llm_reasoning The text from the LLM explaining why it chose this
 */
export function queueForTracking({ pool_address, deploy_args, initial_volume_change_pct, llm_reasoning, pool_name }) {
  if (!pool_address) return { success: false, error: "pool_address required" };
  const db = loadTracker();

  // If already tracking, don't overwrite first_seen_at
  if (!db[pool_address]) {
    db[pool_address] = {
      pool_address,
      pool_name: pool_name || pool_address.slice(0, 8),
      deploy_args,
      first_seen_at: new Date().toISOString(),
      initial_volume_change_pct: initial_volume_change_pct ?? 0,
      llm_reasoning: llm_reasoning || "",
    };
    saveTracker(db);
    log("pool-tracker", `Queued ${pool_name || pool_address.slice(0, 8)} for observation (baseline VCP: ${initial_volume_change_pct}%)`);
    return { success: true, message: `Successfully queued ${pool_address} for observation.` };
  } else {
    return { success: false, error: "Pool is already being tracked." };
  }
}

/**
 * Gets all pools currently in the tracking queue.
 * @returns {Array} List of tracked pools
 */
export function getTrackedPools() {
  const db = loadTracker();
  return Object.values(db);
}

/**
 * Removes a pool from the tracking queue.
 */
export function discardTrackedPool(pool_address) {
  const db = loadTracker();
  if (db[pool_address]) {
    delete db[pool_address];
    saveTracker(db);
    log("pool-tracker", `Discarded ${pool_address} from tracking queue.`);
  }
}
