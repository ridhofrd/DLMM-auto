import readline from "readline";
import chalk from "chalk";
import { isManagementBusy, isScreeningBusy } from "../cycles/state.js";
import { isCliBusy, setCliBusy } from "./state.js";
import { createTelegramHandler } from "../interfaces/telegram-handler.js";

const _cliQueue = [];

export function startREPL(opts = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  function refreshPrompt() {
    if (isManagementBusy() || isScreeningBusy() || isCliBusy) {
      rl.setPrompt("⏳ Agent is busy... (input queued)> ");
    } else {
      rl.setPrompt(chalk.magenta.bold("DLMM> "));
    }
    rl.prompt(true);
  }

  const handler = createTelegramHandler({
    ...opts,
    refreshPrompt,
  });

  async function drainCliQueue() {
    while (_cliQueue.length > 0 && !isManagementBusy() && !isScreeningBusy() && !isCliBusy) {
      const queued = _cliQueue.shift();
      // fake a message object
      await handler({ text: queued });
    }
  }

  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) { refreshPrompt(); return; }

    if (isManagementBusy() || isScreeningBusy() || isCliBusy) {
      if (_cliQueue.length < 5) {
        _cliQueue.push(text);
        console.log(`⏳ Queued (${_cliQueue.length} in queue): "${text.slice(0, 60)}"`);
      } else {
        console.log("Queue is full (5 messages). Wait for the agent to finish.");
      }
      refreshPrompt();
      return;
    }

    try {
      setCliBusy(true);
      await handler({ text });
    } catch (e) {
      console.error(`CLI error: ${e.message}`);
    } finally {
      setCliBusy(false);
      refreshPrompt();
      drainCliQueue().catch(() => {});
    }
  });

  return { rl, refreshPrompt, drainCliQueue, handler };
}
