import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const POOL_DIR = path.resolve(__dirname, "..");
export const REPO_ROOT = path.resolve(POOL_DIR, "../..");

export function resolveFromRepo(relativePath) {
  if (!relativePath) return REPO_ROOT;
  return path.isAbsolute(relativePath) ? relativePath : path.resolve(REPO_ROOT, relativePath);
}

export function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
