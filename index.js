import "dotenv/config";
import cron from "node-cron";
import { log } from "./logger.js";
import { config } from "./config.js";
import { registerCronRestarter } from "./tools/executor.js";
import { startPolling, stopPolling, isEnabled as telegramEnabled, sendHTML } from "./telegram.js";
import { generateBriefing } from "./briefing.js";
import { getLastBriefingDate, setLastBriefingDate, updatePnlAndCheckExits } from "./data/state.js";
import { startUIServer } from "./ui-server.js";
import { bootstrapHiveMind, ensureAgentId, startHiveMindBackgroundSync } from "./hivemind.js";
import { runManagementCycle, runScreeningCycle, isManagementBusy, isScreeningBusy, timers } from "./src/cycles/index.js";
import { createTelegramHandler } from "./src/interfaces/telegram-handler.js";
import { startREPL } from "./src/cli/repl.js";
import { checkSuspectPnl, checkVolumeGuard } from "./src/domain/position.js";
import { getMyPositions } from "./tools/dlmm.js";
import { getPollTriggeredAt, setPollTriggeredAt } from "./src/cycles/concurrency.js";
import chalk from "chalk";

process.on("uncaughtException", (err) => {
  log("error", `UNCAUGHT EXCEPTION: ${err.message}`);
  console.error(err);
});

process.on("unhandledRejection", (reason, promise) => {
  log("error", `UNHANDLED REJECTION: ${reason instanceof Error ? reason.message : JSON.stringify(reason)}`);
  console.error(reason);
});

startUIServer();

log("startup", "DLMM LP Agent starting...");
log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
log("startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);
ensureAgentId();
bootstrapHiveMind().catch((error) => log("hivemind_warn", `Bootstrap failed: ${error.message}`));
startHiveMindBackgroundSync();

const DEPLOY = config.management.deployAmountSol;
let _cronTasks = [];
let _isCronStarted = false;
let _cronRestarterRegistered = false;

async function runBriefing() {
  log("cron", "Starting morning briefing");
  try {
    const briefing = await generateBriefing();
    if (telegramEnabled()) {
      await sendHTML(briefing);
    }
    setLastBriefingDate();
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  }
}

async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();
  if (lastSent === todayUtc) return; // already sent today
  const nowUtc = new Date();
  const briefingHourUtc = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return; // too early, cron will handle it
  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

function stopCronJobs() {
  for (const task of _cronTasks) task.stop();
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
  if (_cronTasks._emergencyPollInterval) clearInterval(_cronTasks._emergencyPollInterval);
  _cronTasks = [];
  _isCronStarted = false;
}

function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting
  _isCronStarted = true;

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (isManagementBusy()) return;
    timers.managementLastRun = Date.now();
    await runManagementCycle();
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, async () => {
    if (isScreeningBusy()) return;
    timers.screeningLastRun = Date.now();
    await runScreeningCycle();
  });

  const briefingTask = cron.schedule("0 1 * * *", async () => {
    await runBriefing();
  });

  _cronTasks.push(mgmtTask, screenTask, briefingTask);

  if (!config.api.lpAgentRelayEnabled) {
    const PNL_POLL_INTERVAL_MS = 60_000;
    _cronTasks._pnlPollInterval = setInterval(async () => {
      if (isManagementBusy() || isScreeningBusy()) return;
      try {
        const { positions } = await getMyPositions({ force: true, silent: true });
        if (!positions || positions.length === 0) return;
        let shouldTriggerManagement = false;

        for (const pos of positions) {
          const exit = updatePnlAndCheckExits(pos.position, pos, config.management);
          if (exit) {
            if (exit.needs_confirmation) {
              // Rechecks are queued, handled internally by state/trailing-confirm
            } else {
              log("cron", `Poller detected exit condition for ${pos.pair || pos.position} — triggering management`);
              shouldTriggerManagement = true;
            }
          }
        }

        let needsManagementCheck = shouldTriggerManagement;

        if (!needsManagementCheck) {
          for (const pos of positions) {
            if (checkSuspectPnl(pos)) {
              needsManagementCheck = true;
              break;
            }
          }
        }

        if (needsManagementCheck) {
          const now = Date.now();
          if (now - getPollTriggeredAt() > 120_000) {
            setPollTriggeredAt(now);
            runManagementCycle({ silent: true }).catch(e => log("cron_error", `Poll-triggered mgmt failed: ${e.message}`));
          }
        }

        for (const p of positions) {
          if (!p.in_range) continue;
          if (checkVolumeGuard(p)) {
            // Handled within runManagementCycle via _volumeGuardStrikes logic.
            // This poll just speeds up detection if we want it to trigger cycle
          }
        }

      } catch (err) {
        // silent
      }
    }, PNL_POLL_INTERVAL_MS);
  } else {
    // Relying on webhooks from API
  }
}

if (!_cronRestarterRegistered) {
  registerCronRestarter({
    stop: stopCronJobs,
    start: startCronJobs,
  });
  _cronRestarterRegistered = true;
}

let isShuttingDown = false;
async function shutdown(reason) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\nShutting down (${reason})...`);
  stopCronJobs();
  stopPolling();
  setTimeout(() => process.exit(0), 1500).unref(); // give log/API a moment to flush
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const isTTY = process.stdout.isTTY && process.stdin.isTTY;

let repl = null;
const telegramHandler = createTelegramHandler({
  startCronJobs,
  stopCronJobs,
  isCronStarted: () => _isCronStarted,
  setCronStarted: (val) => { _isCronStarted = val; },
  shutdown,
  refreshPrompt: () => {
    if (repl) repl.refreshPrompt();
  }
});

if (isTTY) {
  repl = startREPL({
    startCronJobs,
    stopCronJobs,
    isCronStarted: () => _isCronStarted,
    setCronStarted: (val) => { _isCronStarted = val; },
    shutdown
  });

  const { rl } = repl;

  function launchCron() {
    log("startup", "Starting cron cycles...");
    startCronJobs();
    maybeRunMissedBriefing().catch(() => { });
    startPolling(telegramHandler);
  }

  launchCron();

  console.log(chalk.cyan(`
Interactive mode ready.
Deploy setting: ${config.management.deployAmountSol} SOL per position
Max positions:  ${config.risk.maxPositions}

Commands:
  /deploy <n> Deploy candidate <n> (e.g. /deploy 1)
  /screen    Let the agent screen candidates
  /status    Refresh wallet + positions
  /candidates Refresh top pool list
  /briefing  Show morning briefing (last 24h)
  /learn     Study top LPers
  /gmgn      Show GMGN security report
  /thresholds Show current screening thresholds
  /evolve    Manually trigger threshold evolution
  /stop      Shut down
  /pause     Pause autonomous cron cycles
  /resume    Resume autonomous cron cycles
  /resume    Start cron (equivalent to 'go')

`));

  rl.prompt();

  // Expose to ui-server
  import("./ui-server.js").then(({ commandListeners }) => {
    commandListeners.push((cmd) => {
      rl.emit("line", cmd);
    });
  });

} else {
  // Non-TTY mode
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => { });
  startPolling(telegramHandler);
  (async () => {
    try {
      const { agentLoop } = await import("./agent.js");
      const startupStep3 = process.env.DRY_RUN === "true"
        ? `3. Ignore wallet SOL threshold in dry run: get_top_candidates then simulate deploy ${DEPLOY} SOL.`
        : `3. If SOL >= ${config.management.minSolToOpen}: get_top_candidates then deploy ${DEPLOY} SOL.`;
      await agentLoop(`STARTUP CHECK\n1. get_wallet_balance. 2. get_my_positions. ${startupStep3} 4. Report.`, config.llm.maxSteps, [], "SCREENER");
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
}
