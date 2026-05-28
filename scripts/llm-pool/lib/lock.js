import fs from "fs";
import path from "path";
import { POOL_DIR } from "./paths.js";

const LOCK_PATH = path.join(POOL_DIR, ".rotate.lock");
const STALE_MS = 5 * 60 * 1000;

export function withLock(fn) {
  acquire();
  try {
    return fn();
  } finally {
    release();
  }
}

export async function withLockAsync(fn) {
  acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

function acquire() {
  if (fs.existsSync(LOCK_PATH)) {
    const stat = fs.statSync(LOCK_PATH);
    if (Date.now() - stat.mtimeMs > STALE_MS) {
      fs.unlinkSync(LOCK_PATH);
    } else {
      throw new Error("Another rotation is in progress (.rotate.lock). Try again shortly.");
    }
  }
  fs.writeFileSync(LOCK_PATH, `${process.pid}\n${new Date().toISOString()}\n`);
}

function release() {
  try {
    if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH);
  } catch {
    /* ignore */
  }
}
