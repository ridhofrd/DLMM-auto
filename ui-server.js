import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import util from "util";

// We keep a small memory buffer of the last few logs so when a client connects, they see recent history
const logBuffer = [];
const BUFFER_SIZE = 1000;

export let io = null;
export const commandListeners = [];

export function startUIServer() {
  // Intercept all terminal output to stream to UI
  const originalLog = console.log;
  const originalError = console.error;

  console.log = function (...args) {
    const text = util.format(...args);
    originalLog.apply(console, args);
    broadcastLog({ type: "log", message: text, timestamp: new Date().toISOString() });
  };

  console.error = function (...args) {
    const text = util.format(...args);
    originalError.apply(console, args);
    broadcastLog({ type: "log", level: "error", message: text, timestamp: new Date().toISOString() });
  };

  const app = express();
  app.use(cors());

  const server = createServer(app);
  io = new Server(server, {
    cors: {
      origin: "*", // Next.js dev server defaults to localhost:3000
    },
  });

  io.on("connection", (socket) => {
    console.log(`[UI] Client connected: ${socket.id}`);
    
    // Send history
    socket.emit("log_history", logBuffer);

    // Listen for commands from the UI
    socket.on("command", (cmd) => {
      console.log(`[UI] Received command: ${cmd.action}`);
      commandListeners.forEach(listener => listener(cmd.action));
    });

    socket.on("disconnect", () => {
      console.log(`[UI] Client disconnected: ${socket.id}`);
    });
  });

  const PORT = process.env.UI_PORT || 3001;
  server.listen(PORT, () => {
    console.log(`[UI] Server listening on port ${PORT}`);
  });
}

// Function to call from logger.js to broadcast logs
export function broadcastLog(entry) {
  // Store in buffer
  logBuffer.push(entry);
  if (logBuffer.length > BUFFER_SIZE) {
    logBuffer.shift();
  }
  
  if (io) {
    io.emit("log", entry);
  }
}
