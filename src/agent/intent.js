import { tools } from "../../tools/definitions.js";
import { config } from "../../config.js";

export const MANAGER_TOOLS = new Set(["close_position", "claim_fees", "swap_token", "get_position_pnl", "get_my_positions", "get_wallet_balance"]);
export const SCREENER_TOOLS = new Set(["deploy_position", "queue_for_tracking", "discard_tracked_pool", "get_active_bin", "get_top_candidates", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_pool_memory", "get_wallet_balance", "get_my_positions", "get_gmgn_token_analysis"]);
export const GENERAL_INTENT_ONLY_TOOLS = new Set([
  "self_update",
  "update_config",
  "add_to_blacklist",
  "remove_from_blacklist",
  "block_deployer",
  "unblock_deployer",
  "add_pool_note",
  "set_position_note",
  "add_smart_wallet",
  "remove_smart_wallet",
  "add_lesson",
  "pin_lesson",
  "unpin_lesson",
  "clear_lessons",
  "add_strategy",
  "remove_strategy",
  "set_active_strategy",
]);

// Intent → tool subsets for GENERAL role
const INTENT_TOOLS = {
  decisions: new Set(["get_recent_decisions"]),
  deploy: new Set(["deploy_position", "queue_for_tracking", "get_top_candidates", "get_active_bin", "get_pool_memory", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_wallet_balance", "get_my_positions", "add_pool_note"]),
  close: new Set(["close_position", "get_my_positions", "get_position_pnl", "get_wallet_balance", "swap_token"]),
  claim: new Set(["claim_fees", "get_my_positions", "get_position_pnl", "get_wallet_balance"]),
  swap: new Set(["swap_token", "get_wallet_balance"]),
  config: new Set(["update_config"]),
  blocklist: new Set(["add_to_blacklist", "remove_from_blacklist", "list_blacklist", "block_deployer", "unblock_deployer", "list_blocked_deployers"]),
  selfupdate: new Set(["self_update"]),
  balance: new Set(["get_wallet_balance", "get_my_positions", "get_wallet_positions"]),
  positions: new Set(["get_my_positions", "get_position_pnl", "get_wallet_balance", "set_position_note", "get_wallet_positions"]),
  strategy: new Set(["list_strategies", "get_strategy", "add_strategy", "update_strategy", "delete_strategy", "remove_strategy", "set_active_strategy"]),
  screen: new Set(["get_top_candidates", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "check_smart_wallets_on_pool", "get_pool_detail", "get_my_positions", "discover_pools", "get_gmgn_token_analysis"]),
  memory: new Set(["get_pool_memory", "add_pool_note", "list_blacklist", "add_to_blacklist", "remove_from_blacklist"]),
  smartwallet: new Set(["add_smart_wallet", "remove_smart_wallet", "list_smart_wallets", "check_smart_wallets_on_pool"]),
  study: new Set(["study_top_lpers", "get_top_lpers", "get_pool_detail", "search_pools", "get_token_info", "discover_pools", "add_smart_wallet", "list_smart_wallets", "get_gmgn_token_analysis"]),
  performance: new Set(["get_performance_history", "get_my_positions", "get_position_pnl"]),
  lessons: new Set(["add_lesson", "pin_lesson", "unpin_lesson", "list_lessons", "clear_lessons"]),
};

const INTENT_PATTERNS = [
  { intent: "decisions", re: /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i },
  { intent: "deploy", re: /\b(deploy|open|add liquidity|lp into|invest in)\b/i },
  { intent: "close", re: /\b(close|exit|withdraw|remove liquidity|shut down)\b/i },
  { intent: "claim", re: /\b(claim|harvest|collect)\b.*\bfee/i },
  { intent: "swap", re: /\b(swap|convert|sell|exchange)\b/i },
  { intent: "selfupdate", re: /\b(self.?update|git pull|pull latest|update (the )?bot|update (the )?agent|update yourself)\b/i },
  { intent: "blocklist", re: /\b(blacklist|block|unblock|blocklist|blocked deployer|rugger|block dev|block deployer)\b/i },
  { intent: "config", re: /\b(config|setting|threshold|update|set |change)\b/i },
  { intent: "balance", re: /\b(balance|wallet|sol|how much)\b/i },
  { intent: "positions", re: /\b(position|portfolio|open|pnl|yield|range)\b/i },
  { intent: "strategy", re: /\b(strategy|strategies)\b/i },
  { intent: "screen", re: /\b(screen|candidate|find pool|search|research|token)\b/i },
  { intent: "memory", re: /\b(memory|pool history|note|remember)\b/i },
  { intent: "smartwallet", re: /\b(smart wallet|kol|whale|watch.?list|add wallet|remove wallet|list wallet|tracked wallet|check pool|who.?s in|wallets in|add to (smart|watch|kol))\b/i },
  { intent: "study", re: /\b(study top|top lpers?|best lpers?|who.?s lping|lp behavior|lpers?)\b/i },
  { intent: "performance", re: /\b(performance|history|how.?s the bot|how.?s it doing|stats|report)\b/i },
  { intent: "lessons", re: /\b(lesson|learned|teach|pin|unpin|clear lesson|what did you learn)\b/i },
];

/**
 * Filter tools based on the agent type and goal string intent.
 */
export function getToolsForRole(agentType, goal = "") {
  if (agentType === "MANAGER") return tools.filter(t => MANAGER_TOOLS.has(t.function.name));
  if (agentType === "SCREENER") {
    return tools.filter(t => {
      if (!config.screening?.enablePoolObservation && (t.function.name === "queue_for_tracking" || t.function.name === "discard_tracked_pool")) {
        return false;
      }
      return SCREENER_TOOLS.has(t.function.name);
    });
  }

  // GENERAL: match intent from goal, combine matched tool sets
  const matched = new Set();
  for (const { intent, re } of INTENT_PATTERNS) {
    if (re.test(goal)) {
      for (const t of INTENT_TOOLS[intent]) matched.add(t);
    }
  }

  // Fall back to all tools if no intent matched
  if (matched.size === 0) return tools.filter(t => !GENERAL_INTENT_ONLY_TOOLS.has(t.function.name));
  return tools.filter(t => matched.has(t.function.name));
}

const MUTATING_TOOL_INTENTS = /\b(deploy|open position|add liquidity|lp into|invest in|close|exit|withdraw|remove liquidity|claim|harvest|collect|swap|convert|sell|exchange|block|unblock|blacklist|add smart wallet|remove smart wallet|add wallet|remove wallet|pin|unpin|clear lesson|add lesson|set active strategy|remove strategy|add strategy|set |change |update |self.?update|pull latest|git pull|update yourself)\b/i;
const LIVE_DATA_TOOL_INTENTS = /\b(balance|wallet|position|portfolio|pnl|yield|range|show positions|open positions|screen|candidate|find pool|search|research|analyze|check pool|token holders|narrative|study top|top lpers?|lp behavior|who.?s lping|performance|history|stats|report|list smart wallets|list blacklist|list blocked deployers|list lessons)\b/i;
const CONFIG_READ_ONLY_INTENTS = /\b(check|show|what(?:'s| is)?|review|inspect|see)\b.*\b(config|settings?|thresholds?)\b/i;
const DECISION_EXPLANATION_INTENTS = /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i;

/**
 * Checks whether the goal requires a real tool use, preventing the LLM from relying on memory.
 */
export function shouldRequireRealToolUse(goal, agentType, interactive = false) {
  if (agentType === "MANAGER") return false;
  if (DECISION_EXPLANATION_INTENTS.test(goal)) return false;
  if (CONFIG_READ_ONLY_INTENTS.test(goal)) return false;
  if (MUTATING_TOOL_INTENTS.test(goal)) return true;
  return interactive && LIVE_DATA_TOOL_INTENTS.test(goal);
}
