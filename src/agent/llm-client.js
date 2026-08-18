import OpenAI from "openai";
import fs from "fs";
import dotenv from "dotenv";
import { jsonrepair } from "jsonrepair";
import { log } from "../../logger.js";
import path from "path";

let _client = null;
let _lastEnvMtime = 0;

export function getActiveClient() {
  try {
    const stat = fs.statSync(".env");
    if (stat.mtimeMs > _lastEnvMtime) {
      const parsed = dotenv.parse(fs.readFileSync(".env", "utf8"));
      for (const k in parsed) {
        process.env[k] = parsed[k];
      }
      _lastEnvMtime = stat.mtimeMs;
      _client = null; // force recreate
    }
  } catch (e) {
    // ignore if no .env
  }

  if (!_client) {
    _client = new OpenAI({
      baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
      apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
      timeout: 5 * 60 * 1000,
    });
  }
  return _client;
}

export const DEFAULT_MODEL = process.env.LLM_MODEL || "openrouter/healer-alpha";
const FALLBACK_MODEL = "stepfun/step-3.5-flash:free";

export function buildMessages(systemPrompt, sessionHistory, goal, providerMode = "system") {
  if (providerMode === "user_embedded") {
    return [
      ...sessionHistory,
      {
        role: "user",
        content: `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER REQUEST]\n${goal}`,
      },
    ];
  }

  return [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
    { role: "user", content: goal },
  ];
}

function isSystemRoleError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /invalid message role:\s*system/i.test(message);
}

function isToolChoiceRequiredError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /tool_choice/i.test(message) && /required/i.test(message);
}

/**
 * Attempt dynamic pool rotation via scripts/llm-pool when encountering 429/quota errors.
 */
async function tryRotatePool(reason) {
  try {
    const { rotate } = await import("../../scripts/llm-pool/lib/rotate.js");
    const result = await rotate({ reason, force: true });
    if (result?.rotated) {
      _client = null; // force reload client on next getActiveClient()
      _lastEnvMtime = 0;
      return result;
    }
    return result;
  } catch (err) {
    log("warn", `llm-pool rotation skipped/unavailable: ${err.message}`);
    return null;
  }
}

function trackTokenUsage(model, usage) {
  if (!usage || Object.keys(usage).length === 0) return;
  try {
    const statsDir = path.resolve("ServerArtefact");
    if (!fs.existsSync(statsDir)) fs.mkdirSync(statsDir, { recursive: true });
    
    const statsFile = path.join(statsDir, 'llm_usage_stats.json');
    let stats = {};
    if (fs.existsSync(statsFile)) {
      stats = JSON.parse(fs.readFileSync(statsFile, "utf-8"));
    }
    
    const date = new Date();
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    
    if (!stats[monthKey]) stats[monthKey] = {};
    if (!stats[monthKey][model]) {
      stats[monthKey][model] = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, requests: 0 };
    }
    
    stats[monthKey][model].prompt_tokens += (usage.prompt_tokens || 0);
    stats[monthKey][model].completion_tokens += (usage.completion_tokens || 0);
    stats[monthKey][model].total_tokens += (usage.total_tokens || 0);
    stats[monthKey][model].requests += 1;
    
    fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2));
  } catch (e) {
    log("error", `Failed to track token usage: ${e.message}`);
  }
}

/**
 * Handles LLM API call with robust retry, fallback models, and tool JSON repairing.
 */
export async function chatCompletionWithRetry({
  messages,
  tools,
  toolChoice,
  model,
  maxTokens,
  temperature,
  systemPrompt,
  sessionHistory,
  goal
}) {
  let activeModel = model || DEFAULT_MODEL;
  let providerMode = "system";
  let usedToolChoice = toolChoice;
  let activeMessages = messages;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await getActiveClient().chat.completions.create({
        model: activeModel,
        messages: activeMessages,
        tools: tools,
        tool_choice: usedToolChoice,
        temperature: temperature,
        max_tokens: maxTokens,
      });

      if (!response.choices?.length) {
        log("error", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
        throw new Error(`API returned no choices: ${response.error?.message || JSON.stringify(response)}`);
      }

      const msg = response.choices[0].message;
      const invalidToolArgErrors = new Map();

      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.arguments) {
            try {
              JSON.parse(tc.function.arguments);
            } catch {
              try {
                tc.function.arguments = JSON.stringify(JSON.parse(jsonrepair(tc.function.arguments)));
                log("warn", `Repaired malformed JSON args for ${tc.function.name}`);
              } catch {
                tc.function.arguments = "{}";
                const error = `Invalid tool arguments for ${tc.function.name}`;
                invalidToolArgErrors.set(tc.id, error);
                log("error", `${error}: could not repair JSON`);
              }
            }
          }
        }
      }

      const usage = response.usage || {};
      log("llm_usage", `Model: ${activeModel} | Prompt: ${usage.prompt_tokens || 0} | Completion: ${usage.completion_tokens || 0} | Total: ${usage.total_tokens || 0}`);
      
      trackTokenUsage(activeModel, usage);

      return { msg, updatedMessages: activeMessages, invalidToolArgErrors, providerMode };

    } catch (error) {
      if (providerMode === "system" && isSystemRoleError(error)) {
        providerMode = "user_embedded";
        activeMessages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);
        log("agent", "Provider rejected system role — retrying with embedded system instructions");
        attempt -= 1;
        continue;
      }
      if (usedToolChoice === "required" && isToolChoiceRequiredError(error)) {
        usedToolChoice = "auto";
        log("agent", "Provider rejected tool_choice=required — retrying with tool_choice=auto");
        attempt -= 1;
        continue;
      }

      const errCode = error?.status || error?.error?.code || error?.code;
      const errMsg = String(error?.message || error?.error?.message || error || "");
      const isQuotaOrRateLimit =
        errCode === 429 ||
        errCode === 402 ||
        /quota|rate.?limit|usage.?limit|reached.*limit|weekly/i.test(errMsg);

      // ─── Reactive Failover on 429 / Quota ───
      if (isQuotaOrRateLimit) {
        log("warn", `Active LLM key hit quota/rate limit: ${errMsg.slice(0, 120)}. Attempting instant pool rotation...`);
        const rotation = await tryRotatePool(`runtime quota error (${errCode || 'quota'})`);
        if (rotation?.rotated) {
          log("agent", `Switched LLM key to [${rotation.active}]. Retrying request immediately...`);
          attempt -= 1;
          continue;
        } else if (rotation?.depleted) {
          log("error", "LLM key pool is completely depleted across all accounts.");
          if (activeModel !== FALLBACK_MODEL) {
            activeModel = FALLBACK_MODEL;
            log("agent", `Switching to fallback model ${FALLBACK_MODEL}`);
            continue;
          }
        }
        throw error;
      }

      if (errCode === 502 || errCode === 503 || errCode === 529 || String(error).includes("fetch failed")) {
        const wait = (attempt + 1) * 5000;
        if (attempt === 1 && activeModel !== FALLBACK_MODEL) {
          activeModel = FALLBACK_MODEL;
          log("agent", `Switching to fallback model ${FALLBACK_MODEL}`);
        } else {
          log("agent", `Provider error ${errCode || 'network'}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
          await new Promise((r) => setTimeout(r, wait));
        }
      } else {
        throw error;
      }
    }
  }

  throw new Error("API retries exhausted.");
}
