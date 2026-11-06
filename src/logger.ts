import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type Level = "info" | "warn" | "error" | "step" | "ok";

let runDir = "";
let jsonlPath = "";

export function initLogging(dir: string): void {
  runDir = dir;
  mkdirSync(dir, { recursive: true });
  jsonlPath = join(dir, "run.jsonl");
}

export function runDirectory(): string {
  if (!runDir) throw new Error("initLogging() no ha sido llamado");
  return runDir;
}

const color: Record<Level, string> = {
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  step: "\x1b[35m",
  ok: "\x1b[32m",
};

function stamp(): string {
  return new Date().toISOString();
}

export function log(level: Level, message: string, data?: unknown): void {
  const line = `[${stamp()}] ${level.toUpperCase().padEnd(5)} ${message}`;
  const prefix = process.stdout.isTTY ? color[level] : "";
  const reset = process.stdout.isTTY ? "\x1b[0m" : "";
  process.stdout.write(`${prefix}${line}${reset}\n`);
  if (data !== undefined) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  if (jsonlPath) {
    appendFileSync(
      jsonlPath,
      JSON.stringify({ ts: stamp(), level, message, data: data ?? null }) + "\n",
      "utf8",
    );
  }
}

export const info = (m: string, d?: unknown) => log("info", m, d);
export const warn = (m: string, d?: unknown) => log("warn", m, d);
export const error = (m: string, d?: unknown) => log("error", m, d);
export const step = (m: string, d?: unknown) => log("step", m, d);
export const ok = (m: string, d?: unknown) => log("ok", m, d);
