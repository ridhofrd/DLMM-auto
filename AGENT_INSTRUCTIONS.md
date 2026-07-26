# Agent Instructions

**To the AI Agent reading this file:** 
You are working on the DLMM Agent, an autonomous Solana trading bot managing Dynamic Liquidity Market Maker positions on Meteora. This is a complex, high-risk financial application with strict concurrency rules, multi-agent LLM prompts, and production-grade state management.

Before you write any code, **you MUST adhere to the following rules:**

## 1. Concurrency & Event Loop Rules (CRITICAL)
This bot runs autonomous background cycles (`management` and `screening`) alongside interactive interfaces (CLI and Telegram). Race conditions can and will cause duplicate RPC calls or API rate limit bans.
*   **Never bypass locks:** Any user-initiated command in the CLI or Telegram MUST respect `isCliBusy`, `isManagementBusy`, and `isScreeningBusy`. 
*   If a background cron job is running, user commands must be queued.
*   Do not evaluate boolean state locks as functions (e.g., do not write `isCliBusy()`, use the variable or getter explicitly mapped in `state.js` for the CLI).

## 2. Separation of Concerns
*   **`src/domain/` is PURE:** Files in `src/domain/` (like `position.js`) contain the mathematical and boolean rules for closing positions. **DO NOT** add API calls, database writes, or side effects here. These files must remain 100% unit-testable.
*   **`src/cycles/` handles side-effects:** The actual execution of trades or fee claims belongs in the cycle loops (e.g., `management.js`), which import the pure rules from the domain folder.

## 3. Testing is Mandatory
*   If you modify core domain logic, you must update or add corresponding unit tests in `src/domain/*.test.js`.
*   If you modify the event loop, concurrency locks, or agent prompt structures, you must verify against the integration tests in `test/integration/`.
*   **Verification Command:** Run `npm test` to execute all tests. Do not declare a task complete unless this command passes.

## 4. LLM Prompting Another LLM
*   This codebase invokes other LLMs programmatically (in `screening.js` and `management.js`) to make deployment decisions.
*   If you are modifying strings that contain prompts, be highly aware that you are shaping the instructions for an embedded AI. Keep prompts concise, strictly formatted, and deterministic where possible.

## 5. State Persistence
*   Trade lifecycle data (Peak PnL, Trailing TP drops, OOR timestamps) is stored in `state.json` via `./state.js`.
*   Do not change the schema of `state.json` without writing a migration or ensuring backwards compatibility, as destroying this state will cause the bot to lose track of peak PnLs and panic-sell positions.

## 6. Where to Start
If you are starting a new session:
1.  Read `TECHNICAL_ARCHITECTURE.md` to map out the codebase.
2.  Run `npm test` to ensure the environment is healthy.
3.  Check `TODO.md` or ask the User for the current objective.
