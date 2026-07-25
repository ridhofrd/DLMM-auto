import { jest } from "@jest/globals";
import { EventEmitter } from "events";
import { setScreeningBusy, setManagementBusy } from "../../src/cycles/state.js";
import { setCliBusy } from "../../src/cli/state.js";

// Mock the telegram-handler module so it doesn't actually hit the network
const handlerSpy = jest.fn().mockResolvedValue();
jest.unstable_mockModule("../../src/interfaces/telegram-handler.js", () => ({
  createTelegramHandler: jest.fn().mockReturnValue(handlerSpy)
}));

describe("CLI Locking Integration", () => {
  let replInstance;
  let mockStdin;
  let mockStdout;
  let startREPL;

  beforeEach(async () => {
    mockStdin = new EventEmitter();
    mockStdin.resume = jest.fn();
    mockStdout = { write: jest.fn() };
    
    // reset busy states
    setScreeningBusy(false);
    setManagementBusy(false);
    setCliBusy(false);
    handlerSpy.mockClear();
    
    const replMod = await import("../../src/cli/repl.js");
    startREPL = replMod.startREPL;
  });

  afterEach(() => {
    if (replInstance) replInstance.rl.close();
    jest.clearAllMocks();
  });

  it("should process CLI commands immediately if not busy", async () => {
    replInstance = startREPL({ stdin: mockStdin, stdout: mockStdout });
    
    // Simulate pressing enter
    replInstance.rl.emit("line", "/status");
    
    // Should pass through immediately
    expect(handlerSpy).toHaveBeenCalledWith(expect.objectContaining({ text: "/status" }));
  });

  it("should queue commands when screening is busy, and drain when done", async () => {
    replInstance = startREPL({ stdin: mockStdin, stdout: mockStdout });
    
    // Pretend a cron job just started the screening cycle
    setScreeningBusy(true);
    
    // User tries to type
    replInstance.rl.emit("line", "/status");
    replInstance.rl.emit("line", "/briefing");
    
    // Since it's busy, the handler shouldn't be called yet
    expect(handlerSpy).not.toHaveBeenCalled();
    
    // Cron job finishes
    setScreeningBusy(false);
    
    // Force drain
    await replInstance.drainCliQueue();
    
    expect(handlerSpy).toHaveBeenCalledTimes(2);
    expect(handlerSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({ text: "/status" }));
    expect(handlerSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ text: "/briefing" }));
  });
});
