#!/usr/bin/env node
/**
 * llm-pool CLI — rotate API keys in .env when quota runs out.
 *
 * Usage:
 *   node scripts/llm-pool/cli.js status
 *   node scripts/llm-pool/cli.js probe [accountId]
 *   node scripts/llm-pool/cli.js activate <accountId>
 *   node scripts/llm-pool/cli.js rotate [--force] [--reason "text"]
 *   node scripts/llm-pool/cli.js recover
 *   node scripts/llm-pool/cli.js providers
 */

import fs from "fs";
import path from "path";
import { loadConfig, loadAccounts } from "./lib/config.js";
import { loadState } from "./lib/state.js";
import { POOL_DIR } from "./lib/paths.js";
import {
  rotate,
  probeAccount,
  probeActive,
  recoverCooldowns,
  formatStatus,
  activateAccount,
} from "./lib/rotate.js";
import { listProviders } from "./providers/index.js";

const [command, ...rest] = process.argv.slice(2);

function flag(name) {
  return rest.includes(`--${name}`);
}

function opt(name) {
  const idx = rest.indexOf(`--${name}`);
  if (idx === -1) return null;
  return rest[idx + 1] ?? null;
}

async function main() {
  if (!command || command === "help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  if (command === "providers") {
    console.log(listProviders().join("\n"));
    return;
  }

  if (command === "init") {
    initFiles();
    return;
  }

  const config = loadConfig();
  const accounts = loadAccounts(config);
  const state = loadState(config);

  switch (command) {
    case "status": {
      console.log(formatStatus(config, accounts, state));
      return;
    }
    case "probe": {
      const id = rest.find((a) => !a.startsWith("--"));
      const result = id ? await probeAccount(id, { config }) : await probeActive({ config });
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    }
    case "activate": {
      const id = rest.find((a) => !a.startsWith("--"));
      if (!id) throw new Error("Usage: activate <accountId>");
      const result = await activateAccount(id, { config });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "rotate": {
      const result = await rotate({
        reason: opt("reason") || (flag("force") ? "manual (force)" : "manual"),
        force: flag("force"),
        config,
      });
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.depleted ? 2 : 0);
    }
    case "recover": {
      const result = await recoverCooldowns({ config });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function printHelp() {
  console.log(`llm-pool — generic LLM API key rotation

Commands:
  init                Copy example config + accounts files if missing
  status              Show pool + active account
  probe [accountId]   Health check (active if id omitted)
  activate <id>       Set account active + patch .env
  rotate [--force]    Rotate to next healthy key
  recover             Clear expired cooldowns
  providers           List provider adapters

Setup:
  cp scripts/llm-pool/llm-pool.config.example.json scripts/llm-pool/llm-pool.config.json
  cp scripts/llm-pool/accounts.pool.example.json scripts/llm-pool/accounts.pool.json
  Edit accounts.pool.json with your API keys (never commit).
`);
}

function initFiles() {
  const pairs = [
    ["llm-pool.config.example.json", "llm-pool.config.json"],
    ["accounts.pool.example.json", "accounts.pool.json"],
  ];
  for (const [src, dest] of pairs) {
    const from = path.join(POOL_DIR, src);
    const to = path.join(POOL_DIR, dest);
    if (fs.existsSync(to)) {
      console.log(`skip ${dest} (exists)`);
      continue;
    }
    fs.copyFileSync(from, to);
    console.log(`created ${dest}`);
  }
  console.log("\nEdit accounts.pool.json with your API keys, then: node cli.js activate acc-01");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
