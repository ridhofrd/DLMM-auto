import { matchInvalidHints, matchQuotaHints, normalizeErrorText } from "./base.js";

export const name = "openrouter";

export function defaultConfig() {
  return {
    api_base: "https://openrouter.ai/api/v1",
    probe_path: "/models",
    auth_header: "Authorization",
    auth_prefix: "Bearer ",
    cooldown_session_hours: 1,
    cooldown_weekly_days: 1,
  };
}

export async function probe(account, config) {
  const base = (config.api_base || defaultConfig().api_base).replace(/\/$/, "");
  const url = `${base}${config.probe_path || "/models"}`;
  const started = Date.now();

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${account.api_key}`,
        "HTTP-Referer": config.http_referer || "https://github.com/llm-pool",
        "X-Title": config.app_title || "llm-pool",
      },
      signal: AbortSignal.timeout(config.probe_timeout_ms ?? 30_000),
    });

    const bodyText = await res.text();
    const latencyMs = Date.now() - started;

    if (res.ok) {
      return { ok: true, statusCode: res.status, latencyMs };
    }

    return {
      ok: false,
      statusCode: res.status,
      latencyMs,
      error: bodyText.slice(0, 400),
      classification: classifyError({ statusCode: res.status, body: bodyText }),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error.message,
      classification: classifyError({ message: error.message }),
    };
  }
}

export function classifyError({ statusCode, body, message }) {
  const text = normalizeErrorText(body) + " " + normalizeErrorText(message);

  if (statusCode === 401 || matchInvalidHints(text)) {
    return { kind: "invalid" };
  }

  if (statusCode === 429 || statusCode === 402 || matchQuotaHints(text)) {
    return { kind: "quota", cooldownHours: 1 };
  }

  if (statusCode >= 500 || /timeout|econnreset|network|fetch failed/.test(text)) {
    return { kind: "transient" };
  }

  return statusCode && statusCode >= 400 ? { kind: "unknown" } : null;
}
