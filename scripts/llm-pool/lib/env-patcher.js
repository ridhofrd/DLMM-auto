import fs from "fs";
import { ensureParentDir } from "./paths.js";

export function readEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return { lines: [], map: new Map() };

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  const map = new Map();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) map.set(match[1], { index: i, value: match[2] });
  }

  return { lines, map };
}

export function patchEnv(envPath, { keys, apiKey, baseUrl, baseUrlKey, activeId }) {
  ensureParentDir(envPath);
  const { lines, map } = readEnvFile(envPath);

  if (lines.length === 0 && !fs.existsSync(envPath)) {
    lines.push("# Patched by llm-pool");
  }

  for (const key of keys) {
    if (map.has(key)) {
      lines[map.get(key).index] = `${key}=${quoteEnv(apiKey)}`;
    } else {
      lines.push(`${key}=${quoteEnv(apiKey)}`);
    }
  }

  if (baseUrl && baseUrlKey) {
    if (map.has(baseUrlKey)) {
      lines[map.get(baseUrlKey).index] = `${baseUrlKey}=${quoteEnv(baseUrl)}`;
    } else {
      lines.push(`${baseUrlKey}=${quoteEnv(baseUrl)}`);
    }
  }

  const marker = "# llm-pool-active-account";
  const markerLine = `${marker}=${activeId}`;
  const markerIdx = lines.findIndex((l) => l.startsWith(marker));
  if (markerIdx >= 0) lines[markerIdx] = markerLine;
  else lines.push(markerLine);

  const backup = `${envPath}.bak`;
  if (fs.existsSync(envPath)) fs.copyFileSync(envPath, backup);

  fs.writeFileSync(envPath, lines.filter((l) => l !== undefined).join("\n").replace(/\n*$/, "\n") + "\n");

  return { backup, patched: keys };
}

function quoteEnv(value) {
  const s = String(value);
  if (/[\s#"']/.test(s)) return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return s;
}
