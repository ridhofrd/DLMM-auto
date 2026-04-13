"use client";

import { useEffect, useState, useRef } from "react";
import Image from "next/image";
import { io } from "socket.io-client";
import { Moon, Sun, Send, Activity, BarChart2, BookOpen, Sliders, Zap, XSquare } from "lucide-react";
import { cn } from "@/lib/utils";

const MOCK_LOGS = [
  { level: "info", category: "system", message: "Agent initialization started..." },
  { level: "info", category: "cron", message: "Loading configuration presets... maxPositions=5, stopLoss=-15%" },
  { level: "info", category: "screening", message: "Screening cycle initiated. Fetching Meteora DLMM active pools..." },
  { level: "info", category: "screening", message: "Evaluating SOL/USDC (bin_step=15) - organic_score=92" },
  { level: "info", category: "screening", message: "Evaluating BONK/SOL (bin_step=80) - organic_score=60" },
  { level: "info", category: "agent", message: "Calling OKX On-chain OS for Smart Money token signals..." },
  { level: "info", category: "agent", message: "Signal confirmed: Smart money net buyers detected on SOL/USDC. Top 10 holder concentration safe." },
  { level: "info", category: "agent", message: "Calculating implied volatility to dynamically determine bin distribution spread..." },
  { level: "info", category: "agent", message: "Executing Tool: [deploy_position] 2.5 SOL into SOL/USDC | Strategy: Curve | Bins: 45 above, 45 below." },
  { level: "info", category: "dlmm", message: "Transaction successful. LP Position active. TxHash: 4zYx..." },
  { level: "info", category: "management", message: "Management cycle polling... 1 position active." },
  { level: "info", category: "management", message: "SOL/USDC position is IN-RANGE. Unclaimed fees: $12.40. No action required." },
  { level: "info", category: "system", message: "Waiting for next cron schedule..." }
];

export default function Dashboard() {
  const [theme, setTheme] = useState("dark");
  const [logs, setLogs] = useState([]);
  const [connected, setConnected] = useState(false);
  const [isSimulation, setIsSimulation] = useState(false);
  const [commandInput, setCommandInput] = useState("");
  const endOfMessagesRef = useRef(null);
  const mockIndexRef = useRef(0);

  // Initialize Socket Connection
  useEffect(() => {
    const socketUrl = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:3001";
    const socket = io(socketUrl);

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));

    // Receive log history buffer on load
    socket.on("log_history", (history) => {
      setLogs(history || []);
    });

    // Receive new real-time log
    socket.on("log", (logEntry) => {
      setLogs((prev) => [...prev, logEntry].slice(-1000));
    });

    return () => socket.disconnect();
  }, []);

  // Handle Simulation Mode Fallback
  useEffect(() => {
    if (connected) {
      setIsSimulation(false);
      return;
    }
    const fallbackTimer = setTimeout(() => setIsSimulation(true), 2500);
    return () => clearTimeout(fallbackTimer);
  }, [connected]);

  // Run Simulation Log Playback
  useEffect(() => {
    if (!isSimulation) return;
    const interval = setInterval(() => {
      const log = MOCK_LOGS[mockIndexRef.current % MOCK_LOGS.length];
      mockIndexRef.current++;
      setLogs((prev) => [...prev, { ...log, timestamp: new Date().toISOString() }].slice(-1000));
    }, 3000);
    return () => clearInterval(interval);
  }, [isSimulation]);

  // Auto-scroll to bottom of terminal
  useEffect(() => {
    endOfMessagesRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Toggle Theme
  useEffect(() => {
    if (theme === "dark") document.documentElement.classList.add("dark");
    else document.documentElement.classList.remove("dark");
  }, [theme]);

  // Handle Command emitting
  const sendCommand = (action) => {
    if (!action) return;
    setLogs((prev) => [...prev, { timestamp: new Date().toISOString(), level: "info", category: "you", message: `> ${action}` }]);

    if (isSimulation) {
      setTimeout(() => {
        let mockResponse = `Executing command '${action}' in simulation mode...`;

        switch (action) {
          case "/status":
            mockResponse = `
Wallet: 14.502 SOL  ($2610.36)
Positions: 2
  SOL/USDC         in-range ✓  fees: $12.40
  BONK/SOL         in-range ✓  fees: $4.20
`;
            break;
          case "/candidates":
            mockResponse = `
Top pools (3 eligible from 142 screened):

  1. SOL/USDC (bin_step=15) - Vol: $4.2M, Organic: 92
  2. JUP/SOL  (bin_step=20) - Vol: $1.1M, Organic: 85
  3. PYTH/SOL (bin_step=40) - Vol: $850K, Organic: 78
`;
            break;
          case "/learn":
            mockResponse = `
Studying top LPers across candidate pools...
✓ Analyzed 150 unique wallets.
✓ Correlating LP shape success rates...
[LESSON ADDED] "Top performers with >60% win rate exit immediately when 1h variance index exceeds 4.2. Updating deployment heuristics."
`;
            break;
          case "/thresholds":
            mockResponse = `
Current screening thresholds:
  minFeeActiveTvlRatio: 0.05
  minOrganicScore: 60
  minHolders: 500
  maxBotHoldersPct: 15%
  stopLossPct: -15%
  managementIntervalMin: 10
`;
            break;
          case "/evolve":
            mockResponse = `
Triggering threshold evolution from performance data...
✓ Analyzed last 12 closed positions
✓ Win rate: 66% | Avg PnL: +4.2%
[EVOLVED] Adjusted minOrganicScore from 60 -> 65 to tighten filter against low-volume bleed.
`;
            break;
          case "/stop":
            mockResponse = `[SYSTEM] Graceful shutdown sequence initiated. Closing open handlers...`;
            break;
        }

        setLogs((prev) => [...prev, { timestamp: new Date().toISOString(), level: "info", category: "agent", message: mockResponse.trim() }]);
      }, 600);
      return;
    }

    const socketUrl = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:3001";
    const socket = io(socketUrl);
    socket.emit("command", { action });
  };

  const submitCustomCommand = (e) => {
    e.preventDefault();
    if (commandInput.trim()) {
      sendCommand(commandInput.trim());
      setCommandInput("");
    }
  };

  return (
    <div className="min-h-screen bg-[var(--bg-color)] flex transition-colors duration-300">

      {/* Sidebar */}
      <aside className="w-80 border-r border-[var(--border-color)] bg-[var(--surface-color)] p-6 flex flex-col justify-between hidden lg:flex z-10 h-screen overflow-y-auto">
        <div>
          <div className="flex items-center gap-2 mb-8">
            <Image src="/logo.png" alt="DLMM_Auto Logo" width={32} height={32} className="rounded-full shadow-md shadow-bibit-500/20" />
            <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">DLMM_Auto</h1>
          </div>

          <nav className="space-y-4">
            <div className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">Agent Commands</div>

            <SidebarBtn
              icon={<Activity size={18} />}
              label="/status"
              desc="View Wallet balance & open positions"
              onClick={() => sendCommand("/status")}
            />
            <SidebarBtn
              icon={<BarChart2 size={18} />}
              label="/candidates"
              desc="Re-screen and display top pool candidates"
              onClick={() => sendCommand("/candidates")}
            />
            <SidebarBtn
              icon={<BookOpen size={18} />}
              label="/learn"
              desc="Study top LPers across candidate pools"
              onClick={() => sendCommand("/learn")}
            />
            <SidebarBtn
              icon={<Sliders size={18} />}
              label="/thresholds"
              desc="Current screening thresholds & performance"
              onClick={() => sendCommand("/thresholds")}
            />
            <SidebarBtn
              icon={<Zap size={18} />}
              label="/evolve"
              desc="Trigger threshold evolution from performance data"
              onClick={() => sendCommand("/evolve")}
            />

            <div className="h-2"></div>

            <button
              onClick={() => sendCommand("/stop")}
              className="w-full flex items-center justify-between p-3 border border-red-500/20 text-red-500 hover:bg-red-500/10 rounded-xl transition-all font-medium text-left"
            >
              <div>
                <div className="flex items-center gap-2">
                  <XSquare size={16} />
                  <span>/stop</span>
                </div>
                <div className="text-xs opacity-70 mt-1 font-normal">Graceful shutdown of agent</div>
              </div>
            </button>
          </nav>
        </div>

        <div className="mt-8">
          <div className="flex items-center justify-between p-4 rounded-xl border border-[var(--border-color)] bg-[var(--bg-color)]">
            <span className="text-sm font-medium text-[var(--text-muted)]">Theme</span>
            <button
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              className="p-2 rounded-lg bg-[var(--surface-color)] text-[var(--text-primary)] hover:text-bibit-500 transition-colors border border-[var(--border-color)]"
            >
              {theme === "dark" ? <Moon size={16} /> : <Sun size={16} />}
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-screen overflow-hidden relative">
        {/* Topbar */}
        <header className="h-20 border-b border-[var(--border-color)] bg-[var(--surface-color)] flex items-center justify-between px-8 z-10 shrink-0">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-medium text-[var(--text-primary)]">Terminal Stream</h2>
            <div className={cn(
              "px-3 py-1 text-xs font-medium rounded-full flex items-center gap-2",
              connected ? "bg-bibit-500/10 text-bibit-600 dark:text-bibit-500"
                : isSimulation ? "bg-purple-500/10 text-purple-600 dark:text-purple-400"
                  : "bg-red-500/10 text-red-600"
            )}>
              <span className={cn(
                "w-2 h-2 rounded-full",
                connected ? "bg-currentColor"
                  : isSimulation ? "bg-purple-500 animate-pulse"
                    : "bg-red-500"
              )}></span>
              {connected ? "Connected to Agent" : isSimulation ? "Simulation Mode" : "Connecting..."}
            </div>
          </div>

          {/* Quick Stats Mockup */}
          <div className="flex gap-6">
            <StatBox label="Dashboard" value="Alpha v1.0" />
            <StatBox label="Status" value={connected ? "Active" : "Offline"} positive={connected} />
          </div>
        </header>

        {/* Terminal Window */}
        <div className="flex-1 p-6 relative flex flex-col min-h-0">
          <div className="absolute inset-0 bg-gradient-to-b from-bibit-500/5 to-transparent pointer-events-none z-0 opacity-50 dark:opacity-20 hidden md:block"></div>

          {/* Simulation Mode Disclaimer Banner */}
          {isSimulation && (
            <div className="mb-4 p-4 rounded-xl bg-purple-500/10 border border-purple-500/20 flex flex-col md:flex-row gap-4 items-start md:items-center justify-between shrink-0 relative z-10 shadow-lg shadow-purple-500/5">
              <div>
                <h3 className="text-purple-600 dark:text-purple-400 font-bold mb-1 flex items-center gap-2">
                  <Activity size={16} /> Dashboard is in Simulation Mode
                </h3>
                <p className="text-[var(--text-muted)] text-sm">
                  You are viewing a demonstration of the agent's capabilities. Terminal outputs below are synthesized mockups.
                </p>
              </div>
              <div className="bg-[var(--bg-color)] p-3 rounded-xl border border-[var(--border-color)] text-xs font-mono shrink-0 shadow-sm">
                <div className="text-[var(--text-muted)] mb-1.5 uppercase tracking-wider text-[10px] font-bold">To connect live agent locally:</div>
                <div className="text-[var(--text-primary)]"><span className="text-bibit-500">git clone</span> https://github.com/ridhofrd/DLMM-auto.git</div>
                <div className="text-[var(--text-primary)] mt-1"><span className="text-bibit-500">npm</span> install && <span className="text-bibit-500">node</span> index.js</div>
              </div>
            </div>
          )}

          <div className="flex-1 rounded-2xl border border-[var(--border-color)] bg-[var(--surface-color)] shadow-sm overflow-hidden flex flex-col relative z-10 mb-4 h-full">

            {/* Terminal Header */}
            <div className="h-10 bg-[var(--border-color)]/30 border-b border-[var(--border-color)] flex items-center px-4 gap-2 shrink-0">
              <div className="w-3 h-3 rounded-full bg-red-400"></div>
              <div className="w-3 h-3 rounded-full bg-yellow-400"></div>
              <div className="w-3 h-3 rounded-full bg-green-400"></div>
              <span className="ml-4 text-xs text-[var(--text-muted)] font-mono">agent-process ~ node index.js</span>
            </div>

            {/* Terminal Body */}
            <div className="flex-1 overflow-y-auto p-4 font-mono text-sm space-y-1">
              {logs.length === 0 ? (
                <div className="text-[var(--text-muted)] font-mono animate-pulse">
                  {isSimulation ? "Initializing simulated environment..." : "Waiting for agent to boot..."}
                </div>
              ) : (
                logs.map((log, i) => (
                  <div key={i} className="break-words whitespace-pre-wrap">
                    {log.category === "you" ? (
                      <span className="text-bibit-500 font-semibold">{log.message}</span>
                    ) : (
                      <>
                        <span className="text-[var(--text-muted)]">[{log.timestamp?.split("T")[1]?.slice(0, 8) || "00:00:00"}]</span>{" "}
                        {log.level === "warn" && <span className="text-yellow-500 font-semibold">[WARN]</span>}
                        {log.level === "error" && <span className="text-red-500 font-semibold">[ERROR]</span>}
                        {log.category && log.category !== "unknown" && log.level !== "warn" && log.level !== "error" && (
                          <span className="text-bibit-500">[{log.category.toUpperCase()}]</span>
                        )}{" "}
                        <span className={cn(
                          "text-[var(--text-primary)]",
                          log.level === "error" && "text-red-400",
                          log.level === "warn" && "text-yellow-400"
                        )}>
                          {log.display || log.message}
                        </span>
                      </>
                    )}
                  </div>
                ))
              )}
              <div ref={endOfMessagesRef} />
            </div>
          </div>

          {/* Command Input Bar */}
          <form onSubmit={submitCustomCommand} className="relative z-10 shrink-0">
            <div className="relative flex items-center">
              <div className="absolute left-4 text-[var(--text-muted)] font-mono">{'>'}</div>
              <input
                type="text"
                value={commandInput}
                onChange={(e) => setCommandInput(e.target.value)}
                placeholder="Type a command (e.g. /status) or chat freely..."
                className="w-full bg-[var(--surface-color)] border border-[var(--border-color)] rounded-xl py-4 pl-10 pr-14 text-[var(--text-primary)] font-mono text-sm focus:outline-none focus:border-bibit-500 transition-colors shadow-sm"
              />
              <button
                type="submit"
                disabled={!commandInput.trim()}
                className="absolute right-3 p-2 bg-bibit-500 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-bibit-600 transition-colors"
              >
                <Send size={16} />
              </button>
            </div>
          </form>

        </div>
      </main>

    </div>
  );
}

function SidebarBtn({ icon, label, desc, onClick }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-start gap-3 p-3 border border-transparent text-[var(--text-primary)] hover:bg-[var(--border-color)]/30 hover:border-[var(--border-color)] rounded-xl transition-all text-left"
    >
      <div className="text-[var(--text-muted)] mt-0.5">{icon}</div>
      <div>
        <div className="font-medium text-sm font-mono">{label}</div>
        <div className="text-xs text-[var(--text-muted)] mt-1">{desc}</div>
      </div>
    </button>
  );
}

function StatBox({ label, value, positive }) {
  return (
    <div className="flex flex-col items-end">
      <span className="text-xs text-[var(--text-muted)]">{label}</span>
      <span className={cn("text-sm font-semibold", positive ? "text-bibit-500" : "text-[var(--text-primary)]")}>
        {value}
      </span>
    </div>
  );
}
