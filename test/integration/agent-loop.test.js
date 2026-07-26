import { jest } from "@jest/globals";
import { setScreeningBusy, isScreeningBusy } from "../../src/cycles/concurrency.js";

// Mock the LLM client to return a predictable response
const mockChatCompletion = jest.fn();
jest.unstable_mockModule("../../src/agent/llm-client.js", () => ({
  chatCompletionWithRetry: mockChatCompletion,
  buildMessages: jest.fn().mockReturnValue([])
}));

const mockExecuteTool = jest.fn();
jest.unstable_mockModule("../../tools/executor.js", () => ({
  executeTool: mockExecuteTool
}));

// Mock pool tracker since screening interacts with it
jest.unstable_mockModule("../../tools/pool-tracker.js", () => ({
  getTrackedPools: jest.fn().mockReturnValue([]),
  discardTrackedPool: jest.fn()
}));

// Mock config so screening has predictable thresholds
jest.unstable_mockModule("../../config.js", () => ({
  config: {
    screening: {
      enablePoolObservation: false,
      minVolume24h: 1000,
      minLiquidity: 1000,
      enableGmgn: false,
    },
    llm: {
      maxSteps: 5,
      screeningModel: "test-model"
    },
    risk: { maxPositions: 3 },
    management: { minSolToOpen: 1 }
  },
  computeDeployAmount: jest.fn().mockReturnValue(1),
  reloadScreeningThresholds: jest.fn()
}));

// Mock wallet/dlmm to return dummy portfolio
jest.unstable_mockModule("../../tools/wallet.js", () => ({
  getWalletBalances: jest.fn().mockResolvedValue({ sol: 5, tokens: [] })
}));
jest.unstable_mockModule("../../tools/dlmm.js", () => ({
  getMyPositions: jest.fn().mockResolvedValue({ total_positions: 0, positions: [] }),
  getActiveBin: jest.fn().mockResolvedValue(100)
}));

jest.unstable_mockModule("../../tools/pool-scanner.js", () => ({
  getTopCandidates: jest.fn().mockResolvedValue({
    candidates: [{
      pool_name: "ABC",
      pool_address: "ABC",
      volume_24h: 2000,
      liquidity: 2000,
      base_address: "B",
      quote_address: "Q"
    }]
  })
}));

jest.unstable_mockModule("../../tools/token.js", () => ({
  getTokenNarrative: jest.fn().mockResolvedValue("Good"),
  getTokenInfo: jest.fn().mockResolvedValue({})
}));

jest.unstable_mockModule("../../tools/gmgn.js", () => ({
  getGMGNTokenAnalysis: jest.fn().mockResolvedValue(null)
}));

jest.unstable_mockModule("../../smart-wallets.js", () => ({
  checkSmartWalletsOnPool: jest.fn().mockResolvedValue([])
}));

describe("Agent Loop & Screening Cycle Integration", () => {
  let runScreeningCycle;

  beforeEach(async () => {
    setScreeningBusy(false);
    mockChatCompletion.mockClear();
    mockExecuteTool.mockClear();
    
    const screeningMod = await import("../../src/cycles/screening.js");
    runScreeningCycle = screeningMod.runScreeningCycle;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should toggle isScreeningBusy during execution and process LLM tool calls", async () => {
    // LLM step 1: LLM returns a tool call to deploy_position
    mockChatCompletion.mockResolvedValueOnce({
      msg: {
        content: "I am deploying a position.",
        tool_calls: [{
          id: "call_123",
          type: "function",
          function: {
            name: "deploy_position",
            arguments: "{ \"pool_address\": \"ABC\", \"amount_y\": 1 }"
          }
        }]
      },
      updatedMessages: [],
      invalidToolArgErrors: new Map()
    });

    // LLM step 2: LLM returns a final string message
    mockChatCompletion.mockResolvedValueOnce({
      msg: {
        content: "🚀 DEPLOYED\n\nI have successfully deployed."
      },
      updatedMessages: [],
      invalidToolArgErrors: new Map()
    });

    mockExecuteTool.mockResolvedValueOnce({
      success: true,
      message: "Successfully deployed mock position."
    });

    expect(isScreeningBusy()).toBe(false);

    // We don't await immediately so we can check the busy flag
    const cyclePromise = runScreeningCycle(true); // silent = true
    
    // Give it a tiny tick to set the flag synchronously at the start of the function
    await new Promise(r => process.nextTick(r));
    
    expect(isScreeningBusy()).toBe(true);
    
    const result = await cyclePromise;
    
    expect(isScreeningBusy()).toBe(false);
    expect(result).toMatch(/🚀 DEPLOYED/);
    expect(mockExecuteTool).toHaveBeenCalledWith("deploy_position", { pool_address: "ABC", amount_y: 1 });
  });

  it("should clear the busy lock even if the LLM crashes", async () => {
    mockChatCompletion.mockRejectedValueOnce(new Error("LLM Rate Limit"));

    expect(isScreeningBusy()).toBe(false);

    const cyclePromise = runScreeningCycle(true);
    
    await new Promise(r => process.nextTick(r));
    expect(isScreeningBusy()).toBe(true);
    
    const result = await cyclePromise;
    
    expect(isScreeningBusy()).toBe(false);
    expect(result).toMatch(/Screening cycle failed: LLM Rate Limit/);
  });
});
