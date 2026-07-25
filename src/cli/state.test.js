import { 
  isCliBusy, 
  setCliBusy, 
  sessionHistory, 
  appendHistory, 
  clearHistory,
  getLatestCandidatesMeta,
  setLatestCandidates
} from "./state.js";

describe("CLI State", () => {
  beforeEach(() => {
    setCliBusy(false);
    clearHistory();
    setLatestCandidates([]);
  });

  it("should manage CLI busy state", () => {
    expect(isCliBusy).toBe(false);
    setCliBusy(true);
    expect(isCliBusy).toBe(true);
  });

  it("should append and format history", () => {
    expect(sessionHistory).toEqual([]);
    
    appendHistory("Hello bot", "I am a bot");
    expect(sessionHistory.length).toBe(2);
    expect(sessionHistory[0]).toEqual({
      role: "user",
      content: "Hello bot"
    });
    // Append adds an additional assistant response right after
    expect(sessionHistory[1]).toEqual({
      role: "assistant",
      content: "I am a bot"
    });
  });

  it("should maintain a rolling history limit of 20 items (10 pairs)", () => {
    for (let i = 0; i < 15; i++) {
      appendHistory(`User ${i}`, `Bot ${i}`);
    }
    // Should cap at 20 items (10 user messages, 10 assistant messages)
    expect(sessionHistory.length).toBe(20);
    expect(sessionHistory[18].content).toBe("User 14");
    expect(sessionHistory[19].content).toBe("Bot 14");
    expect(sessionHistory[0].content).toBe("User 5");
  });

  it("should set and get candidate metadata", () => {
    const mockCandidates = [{ name: "TestPool" }, { name: "Another" }];
    setLatestCandidates(mockCandidates);

    const meta = getLatestCandidatesMeta();
    expect(meta.candidates).toEqual(mockCandidates);
    expect(typeof meta.updatedAt).toBe("string");
  });
});
