import fs from "fs";
import { ensureParentDir } from "./paths.js";

export function createLogger(logFile) {
  return function log(level, message) {
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
    console.log(line);
    if (logFile) {
      ensureParentDir(logFile);
      fs.appendFileSync(logFile, line + "\n");
    }
  };
}
