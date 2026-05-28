/**
 * Provider adapter contract:
 *
 * - probe(account, config) -> { ok, statusCode?, error?, latencyMs? }
 * - classifyError({ statusCode, body, message }) -> null | { kind, cooldownHours? }
 *   kind: "quota" | "invalid" | "transient" | "unknown"
 */

export function normalizeErrorText(input) {
  if (!input) return "";
  if (typeof input === "string") return input.toLowerCase();
  try {
    return JSON.stringify(input).toLowerCase();
  } catch {
    return String(input).toLowerCase();
  }
}

export function matchQuotaHints(text) {
  return /quota|rate.?limit|usage.?limit|too many requests|insufficient.?credits|billing|exceeded|limit reached/.test(text);
}

export function matchInvalidHints(text) {
  return /unauthorized|invalid.?api.?key|authentication|forbidden|revoked|expired.?key/.test(text);
}
