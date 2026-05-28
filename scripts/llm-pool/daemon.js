#!/usr/bin/env node
/**
 * Background probe loop — rotates when active key fails quota/invalid checks.
 *
 *   node scripts/llm-pool/daemon.js
 */

import { loadConfig } from "./lib/config.js";
import { createLogger } from "./lib/logger.js";
import { probeActive, rotate, recoverCooldowns } from "./lib/rotate.js";

const config = loadConfig();
const log = createLogger(config.log_file);
const intervalMs = (config.probe_interval_min ?? 15) * 60 * 1000;

log("info", `llm-pool daemon started (provider=${config.provider}, every ${config.probe_interval_min}m)`);

async function tick() {
  try {
    await recoverCooldowns({ config });

    const probe = await probeActive({ config });
    if (probe.ok) {
      log("debug", `Active account healthy (${probe.latencyMs}ms)`);
      return;
    }

    const kind = probe.classification?.kind || "unknown";
    log("warn", `Active account unhealthy: ${kind} — ${probe.error || probe.statusCode || "failed"}`);

    if (kind === "transient") {
      log("warn", "Transient error — skipping rotation this cycle");
      return;
    }

    const result = await rotate({
      reason: `daemon probe: ${kind}`,
      force: kind === "quota" || kind === "invalid",
      config,
    });

    if (result.depleted) {
      log("error", "Pool depleted after rotation attempt");
    } else if (result.rotated) {
      log("info", `Rotated to ${result.active}`);
    }
  } catch (error) {
    log("error", `Daemon tick failed: ${error.message}`);
  }
}

await tick();
setInterval(tick, intervalMs);

process.on("SIGINT", () => {
  log("info", "Daemon stopped");
  process.exit(0);
});
