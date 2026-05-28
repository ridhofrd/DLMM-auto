import { matchInvalidHints, matchQuotaHints, normalizeErrorText } from "./base.js";

export const name = "ollama";

export function defaultConfig() {
  return {
    api_base: "https://ollama.com/api",
    probe_path: "/chat",
    probe_model: "gpt-oss:120b",
    auth_header: "Authorization",
    auth_prefix: "Bearer ",
    cooldown_session_hours: 5,
    cooldown_weekly_days: 7,
  };
}

export async function probe(account, config) {
  const base = (config.api_base || defaultConfig().api_base).replace(/\/$/, "");
  const url = `${base}${config.probe_path || "/chat"}`;
  const model = config.probe_model || defaultConfig().probe_model;
  const started = Date.now();

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${account.api_key}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        stream: false,
        options: { num_predict: 1 },
      }),
      signal: AbortSignal.timeout(config.probe_timeout_ms ?? 60_000),
    });

    const bodyText = await res.text();
    const latencyMs = Date.now() - started;

    if (res.ok) {
      return { ok: true, statusCode: res.status, latencyMs, body: bodyText.slice(0, 200) };
    }

    const classification = classifyError({ statusCode: res.status, body: bodyText });
    return {
      ok: false,
      statusCode: res.status,
      latencyMs,
      error: bodyText.slice(0, 400),
      classification,
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

  if (statusCode === 429 || statusCode === 402 || statusCode === 403 || matchQuotaHints(text)) {
    const weekly = /weekly|7.?day|week/.test(text);
    return {
      kind: "quota",
      cooldownHours: weekly ? 24 * 7 : 5,
    };
  }

  if (statusCode >= 500 || /timeout|econnreset|network|fetch failed/.test(text)) {
    return { kind: "transient" };
  }

  return statusCode && statusCode >= 400 ? { kind: "unknown" } : null;
}
