import { jest } from "@jest/globals";

// Mock dependencies
jest.unstable_mockModule("../../tools/pool-scanner.js", () => ({
  getTopCandidates: jest.fn(),
}));

jest.unstable_mockModule("../../tools/wallet.js", () => ({
  getWalletBalances: jest.fn(),
}));

jest.unstable_mockModule("../../tools/executor.js", () => ({
  executeTool: jest.fn(),
}));

jest.unstable_mockModule("../../config.js", () => ({
  config: {
    strategy: { strategy: "test_strat", binsBelow: 40 },
  },
  computeDeployAmount: jest.fn(),
}));

jest.unstable_mockModule("./concurrency.js", () => {
  let _candidates = [];
  return {
    setLatestCandidates: jest.fn((c) => { _candidates = c; }),
    getLatestCandidatesMeta: jest.fn(() => ({ candidates: _candidates })),
  };
});

describe("CLI Actions", () => {
  let runDeterministicScreen;
  let deployLatestCandidate;
  let getTopCandidates;
  let getWalletBalances;
  let executeTool;
  let computeDeployAmount;
  let setLatestCandidates;
  let getLatestCandidatesMeta;

  beforeAll(async () => {
    // Dynamic import to resolve mocks
    const actions = await import("./actions.js");
    runDeterministicScreen = actions.runDeterministicScreen;
    deployLatestCandidate = actions.deployLatestCandidate;

    const screening = await import("../../tools/pool-scanner.js");
    getTopCandidates = screening.getTopCandidates;

    const wallet = await import("../../tools/wallet.js");
    getWalletBalances = wallet.getWalletBalances;

    const executor = await import("../../tools/executor.js");
    executeTool = executor.executeTool;

    const configMod = await import("../../config.js");
    computeDeployAmount = configMod.computeDeployAmount;

    const state = await import("./concurrency.js");
    setLatestCandidates = state.setLatestCandidates;
    getLatestCandidatesMeta = state.getLatestCandidatesMeta;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("runDeterministicScreen", () => {
    it("should process and return a list of top candidates", async () => {
      getTopCandidates.mockResolvedValue({
        candidates: [
          { name: "Pool1", pool: "addr1", fee_active_tvl_ratio: 10, volume_window: 1000 },
          { name: "Pool2", pool: "addr2", fee_tvl_ratio: 5, volume_24h: 500, organic_score: 95 }
        ]
      });

      const result = await runDeterministicScreen(2);
      
      expect(getTopCandidates).toHaveBeenCalledWith({ limit: 2 });
      expect(setLatestCandidates).toHaveBeenCalledWith(expect.any(Array));
      expect(result).toContain("Top candidates (2)");
      expect(result).toContain("1. Pool1 | addr1");
      expect(result).toContain("2. Pool2 | addr2");
      expect(result).toContain("fee/aTVL 10%");
      expect(result).toContain("organic 95");
    });

    it("should handle empty candidates and return filtered examples", async () => {
      getTopCandidates.mockResolvedValue({
        candidates: [],
        filtered_examples: [
          { name: "BadPool", reason: "low volume" }
        ]
      });

      const result = await runDeterministicScreen(2);
      expect(setLatestCandidates).toHaveBeenCalledWith([]);
      expect(result).toContain("No candidates available.");
      expect(result).toContain("- BadPool: low volume");
    });

    it("should handle empty candidates and no filtered examples", async () => {
      getTopCandidates.mockResolvedValue({ candidates: [] });
      const result = await runDeterministicScreen(2);
      expect(result).toBe("No candidates available right now.");
    });
  });

  describe("deployLatestCandidate", () => {
    it("should deploy the specified candidate by index", async () => {
      const mockCandidate = { 
        name: "MockPool", 
        pool: "addr3", 
        volatility: 10,
        bin_step: 50,
        base_fee: 10
      };
      
      getLatestCandidatesMeta.mockReturnValue({
        candidates: [mockCandidate]
      });
      
      getWalletBalances.mockResolvedValue({ sol: 10 });
      computeDeployAmount.mockReturnValue(5);
      executeTool.mockResolvedValue({ success: true, position: "pos1" });

      const result = await deployLatestCandidate(0);

      expect(getWalletBalances).toHaveBeenCalled();
      expect(computeDeployAmount).toHaveBeenCalledWith(10);
      expect(executeTool).toHaveBeenCalledWith("deploy_position", expect.objectContaining({
        pool_address: "addr3",
        amount_y: 5,
        strategy: "test_strat",
        pool_name: "MockPool"
      }));

      expect(result.deployAmount).toBe(5);
      expect(result.candidate).toEqual(mockCandidate);
      expect(result.result.success).toBe(true);
    });

    it("should throw an error if index is invalid", async () => {
      getLatestCandidatesMeta.mockReturnValue({ candidates: [] });
      
      await expect(deployLatestCandidate(0)).rejects.toThrow("Invalid candidate index. Run /screen first.");
    });

    it("should throw an error if executeTool returns failure", async () => {
      getLatestCandidatesMeta.mockReturnValue({
        candidates: [{ name: "MockPool", pool: "addr3" }]
      });
      getWalletBalances.mockResolvedValue({ sol: 10 });
      computeDeployAmount.mockReturnValue(5);
      executeTool.mockResolvedValue({ success: false, error: "Not enough funds" });

      await expect(deployLatestCandidate(0)).rejects.toThrow("Not enough funds");
    });
  });
});
