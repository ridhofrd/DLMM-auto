import { config } from "../../config.js";

/** Strip <think>...</think> reasoning blocks that some models leak into output */
export function stripThink(text) {
  if (!text) return text;
  return String(text)
    .replace(/<redacted_thinking>[\s\S]*?<\/redacted_thinking>/gi, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
}

export function sanitizeUntrustedPromptText(text, maxLen = 500) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned ? JSON.stringify(cleaned) : null;
}

export function shouldUsePnlRecheck() {
  return !config.api.lpAgentRelayEnabled;
}

export function formatCloseReasonForAlert(act, position) {
  const base =
    act.rule === "exit"
      ? act.reason
      : act.rule != null
        ? `Rule ${act.rule}: ${act.reason}`
        : act.reason || "close";
  if (position?.pnl_pct == null) return base;
  return `${base} | PnL at signal: ${position.pnl_pct}%`;
}
