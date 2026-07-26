# DLMM Agent - Technical Architecture & File Directory Guide

This document serves as a comprehensive overview of the DLMM Agent's architecture, state management, and core mechanics. It maps out the purpose of every key file and folder, making it easy for humans and future AI agents to navigate the codebase, understand the workflow, and resume development seamlessly.

---

## 1. High-Level Architecture
The DLMM Agent is an autonomous, agentic system designed to manage Dynamic Liquidity Market Maker (DLMM) positions on Meteora (Solana). 

The system operates on **two primary axes**:
1.  **Autonomous Background Cycles**: Powered by `node-cron`, the agent continuously runs **Screening Cycles** (to find and deploy to new pools via LLM decision-making) and **Management Cycles** (to monitor open positions, claim fees, and execute deterministic risk-management exits).
2.  **Interactive Interfaces**: Users can interact with the agent in real-time via a **CLI (Command Line Interface)** or a **Telegram Bot**.

To prevent the background loops from clashing with user-initiated commands (which could result in duplicate API calls or RPC rate limits), the agent employs a strict **Concurrency Locking** system (e.g., `isCliBusy`, `isManagementBusy`).

---

## 2. Root Directory Files
These files bootstrap the application, manage persistent configurations, and orchestrate top-level services.

*   `index.js`: The main entry point. It registers background cron jobs, initializes the local state poller (`PNL_POLL_INTERVAL_MS`), and launches the Telegram, UI Server, and CLI interfaces.
*   `config.js` & `user-config.json`: Handles configuration overrides. `config.js` establishes defaults, while `user-config.json` stores user-defined thresholds (e.g., risk limits, SL/TP targets).
*   `state.js` & `state.json`: The source of truth for persistent off-chain metadata. Tracks position lifecycles, peak PnL (for Trailing TPs), pending drops, and user instructions. Note: There are also other large JSON files for state tracking such as `lessons.json`, `market-snapshots.json`, `pool-memory.json`, and `decision-log.json` which store historical data natively.
*   `telegram.js`: Initializes the Telegram bot and handles the polling/webhook connection.
*   `logger.js`: Centralized logging utility that categorizes and writes logs to the `logs/` directory.
*   `briefing.js`: Generates daily performance summaries of agent operations to be sent to the user.
*   `ui-server.js`: Bootstraps a lightweight backend server to serve the Next.js web UI.
*   `agent.js` / `prompt.js`: Handles the core ReAct agent loop and orchestrates LLM prompts.
*   `hivemind.js`: Manages heartbeats, agent versions, and caches shared lessons across agent runs (`hivemind-cache.json`).

---

## 3. Core Source Code (`src/`)
This is where the business logic of the agent lives, strictly separated into cycles, domain logic, and interfaces.

### `src/cycles/` (The Autonomous Event Loops)
These files govern what the agent does in the background without human intervention.
*   `management.js`: Iterates over active on-chain positions. Evaluates deterministic exit rules (Volume Guard, Stop Loss) and trailing TP conditions. If an action is required (e.g., `CLOSE` or `CLAIM`), it executes the action.
*   `screening.js`: Scans the market for new pools, evaluates them against volume/liquidity thresholds, and builds prompts for the LLM to decide on capital deployment.
*   `state.js`: Manages the background concurrency locks (`isManagementBusy`, `isScreeningBusy`) to prevent overlapping jobs.
*   `trailing-confirm.js`: Handles the 15-second pending states for Trailing TP verification (ensuring PnL drops aren't RPC glitches before selling).

### `src/agent/` (LLM Orchestration)
Contains logic that interfaces directly with the LLM API.
*   `llm-client.js`: Low-level wrapper for LLM provider API requests.
*   `intent.js`: Analyzes intent to select appropriate tools for the agent.

### `src/domain/` (Pure Business Logic)
Isolated logic functions containing zero I/O or side effects, making them highly unit-testable.
*   `position.js`: The mathematical heart of position management. Contains rules for closing positions (`checkExitConditions`, `getDeterministicCloseRule`, `checkVolumeGuard`, `checkSuspectPnl`).
*   `observation.js`: Formats logs and market observations into readable context for the LLM.

### `src/cli/` (Command Line Interface)
*   `repl.js`: Sets up the interactive Read-Eval-Print Loop (the console interface).
*   `actions.js`: Maps slash commands (e.g., `/deploy`, `/status`) to the underlying tool functions.
*   `state.js`: Manages CLI concurrency locks (`isCliBusy`). Ensures that user commands wait in a queue if the agent is actively executing a background cron job.
*   `formatters.js`: UI text formatting for terminal output.

### `src/interfaces/`
*   `telegram-handler.js`: Maps incoming Telegram chat messages to the same underlying actions used by the CLI, applying the same concurrency locking.

---

## 4. Tools Directory (`tools/`)
The `tools/` directory acts as the **I/O Layer**. It handles all external API requests, blockchain interactions, and tool-calling schemas available to the LLM.

*   `dlmm.js`: Interacts directly with Meteora's DLMM SDK on Solana. Handles deploying capital, closing positions, and claiming fees.
*   `wallet.js`: Fetches Solana wallet balances and handles basic Jupiter swaps.
*   `screening.js`: Fetches real-time pool data, liquidity metrics, and recent volume for the screening cycle.
*   `gmgn.js`: Interacts with the GMGN API to fetch safety and security scores (e.g., checking for honeypots or malicious token contracts).
*   `pool-tracker.js`: Maintains an internal memory of pools observed over time to calculate velocity and acceleration of liquidity.
*   `definitions.js`: JSON Schema definitions that map these JavaScript functions into strictly typed tools that the LLM can invoke.
*   `executor.js`: A wrapper that safely executes the requested LLM tool calls.
*   `agent-meridian.js`, `chart-indicators.js`, `okx.js`, `study.js`, `token.js`: Additional specialized tools for technical analysis, specific exchanges (like OKX), and token research.

---

## 5. Other Notable Directories
*   `test/integration/`: Contains integration tests like `agent-loop.test.js` and `cli-locking.test.js`. These mock the LLM and Solana APIs to validate complex multi-step concurrency behaviors without spending real capital.
*   `scripts/`: Utility scripts, such as `llm-pool/` which manages rotating API keys for various LLM providers to avoid rate limits.
*   `ui/`: A standard Next.js frontend application intended to act as a web-based dashboard for the agent.

---

## 6. Key Risk Management Mechanics

1.  **Trailing Take Profit (Trailing TP)**
    *   **Activation:** Triggers once a position reaches `trailingTriggerPct` profit.
    *   **Peak Tracking:** The agent constantly updates the `peak_pnl_pct` in `state.js`.
    *   **Confirmation (`trailing-confirm.js`):** If current PnL drops from the peak by `trailingDropPct`, the agent queues a *Candidate Exit*. It waits 15 seconds and re-polls. If confirmed, it closes the position.
2.  **Volume Guard (`src/domain/position.js`)**
    *   Prevents capital from being locked in fading pools. If a pool's volume change drops below `minVolumeChangePct`, it issues a "strike". 
    *   If strikes accumulate beyond `consecutiveChecks`, the position is automatically closed. Strikes reset if volume recovers.
3.  **Suspect PnL Guard**
    *   Solana RPCs occasionally report erroneous values (e.g., a `-100% PnL` glitch).
    *   If the calculated PnL is `< -90%`, but the wallet holds > `$0.01` USD in value, the agent flags it as a `Suspect PnL` and temporarily skips PnL-based closure rules to prevent false-positive panic selling.
4.  **Liquidity Distribution Screening (`src/cycles/screening.js`)**
    *   Actively screens out pools where liquidity is heavily concentrated (e.g. `> 85%`) in a narrow band of bins near the active price or when it's highly asymmetric (e.g. `> 0.80`), mitigating risks of sudden price gapping.

---
*Generated at: 2026-07-26*
