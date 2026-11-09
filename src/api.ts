import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join, resolve, sep } from "node:path";

const ROOT = process.cwd();
const RUNS_DIR = join(ROOT, "runs");
const JOBS_DIR = join(RUNS_DIR, "jobs");
mkdirSync(JOBS_DIR, { recursive: true });

const TOKEN = process.env.API_TOKEN?.trim() ?? "";
if (TOKEN.length < 24) {
  console.error("Falta API_TOKEN (mínimo 24 caracteres). No se arranca sin token.");
  process.exit(1);
}
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest();

const PORT = Number(process.env.PORT ?? 8787);
const BIND = process.env.BIND ?? "0.0.0.0";
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MINUTES ?? 60) * 60_000;
const MAX_QUEUE = Number(process.env.MAX_QUEUE ?? 4);
const MAX_LOG_BYTES = 200_000;

type Person = "me" | "partner";
type Mode = "audit" | "live";
type Step = "all" | "signup" | "register";
type JobStatus = "queued" | "running" | "succeeded" | "failed" | "timeout" | "cancelled";

interface Profile {
  firstName: string;
  lastName: string;
  birthDate: string;
  phone?: string;
}

interface Job {
  id: string;
  person: Person;
  mode: Mode;
  step: Step;
  resume: boolean;
  inlineProfile: boolean;
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  error: string | null;
  logDir: string | null;
  mailboxAddress: string | null;
  logFile: string;
}

const jobs = new Map<string, Job>();
const profiles = new Map<string, Profile>();
const queue: string[] = [];
const logBuffers = new Map<string, string>();
const children = new Map<string, ChildProcess>();
let running: string | null = null;
const startedAt = Date.now();

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function now(): string {
  return new Date().toISOString();
}

function publicJob(job: Job) {
  return {
    id: job.id,
    person: job.person,
    mode: job.mode,
    step: job.step,
    resume: job.resume,
    inlineProfile: job.inlineProfile,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    exitCode: job.exitCode,
    error: job.error,
    logDir: job.logDir,
    mailboxAddress: job.mailboxAddress,
    urls: {
      self: `/jobs/${job.id}`,
      log: `/jobs/${job.id}/log`,
      files: `/jobs/${job.id}/files`,
    },
  };
}

function saveJob(job: Job): void {
  writeFileSync(join(JOBS_DIR, `${job.id}.json`), JSON.stringify(job, null, 2), "utf8");
}

function loadJobs(): void {
  try {
    const files = readdirSync(JOBS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ f, mtime: statSync(join(JOBS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 100);

    for (const { f } of files) {
      const raw = JSON.parse(readFileSync(join(JOBS_DIR, f), "utf8")) as Job;
      raw.inlineProfile = raw.inlineProfile ?? false;
      raw.mailboxAddress = raw.mailboxAddress ?? null;
      if (raw.status === "running" || raw.status === "queued") {
        raw.status = "failed";
        raw.endedAt = raw.endedAt ?? now();
        raw.error = "Interrumpido por reinicio del servicio; usa resume para continuar.";
        saveJob(raw);
      }
      jobs.set(raw.id, raw);
    }
  } catch (e) {
    console.error("No se pudo cargar el historial de jobs:", (e as Error).message);
  }
}

function activeDuplicate(person: Person, mode: Mode, step: Step): Job | undefined {
  for (const job of jobs.values()) {
    if (job.person === person && job.mode === mode && job.step === step) {
      if (job.status === "queued" || job.status === "running") return job;
    }
  }
  return undefined;
}

function appendLog(job: Job, chunk: Buffer | string): void {
  const text = chunk.toString();
  appendFileSync(job.logFile, text, "utf8");
  // Reflejo en la consola del servicio (EasyPanel), prefijado por job.
  process.stdout.write(text.replace(/^(?=.)/gm, `[job ${job.id.slice(0, 8)}] `));

  let buffer = (logBuffers.get(job.id) ?? "") + text;
  if (buffer.length > MAX_LOG_BYTES) buffer = buffer.slice(-MAX_LOG_BYTES);
  logBuffers.set(job.id, buffer);

  const matches = [...buffer.matchAll(/Carpeta de ejecución:\s*(.+)/g)];
  const last = matches.at(-1)?.[1]?.trim();
  if (last && last !== job.logDir) {
    job.logDir = last;
    saveJob(job);
  }

  const mailbox = [...buffer.matchAll(/Buzón desechable:\s*([^\s]+@[^\s]+)/gi)].at(-1)?.[1];
  if (mailbox && mailbox !== job.mailboxAddress) {
    job.mailboxAddress = mailbox;
    saveJob(job);
  }
}

function killTree(jobId: string, signal: NodeJS.Signals): void {
  const child = children.get(jobId);
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* ya terminó */
    }
  }
}

function pump(): void {
  if (running) return;
  const id = queue.shift();
  if (!id) return;
  const job = jobs.get(id);
  if (!job || job.status !== "queued") {
    pump();
    return;
  }
  startJob(job);
}

function startJob(job: Job): void {
  job.status = "running";
  job.startedAt = now();
  running = job.id;
  saveJob(job);

  const tsx = join(ROOT, "node_modules", ".bin", "tsx");
  const script = join(ROOT, "src", "run.ts");
  const runArgs = [`--person=${job.person}`, `--mode=${job.mode}`];
  if (job.step !== "all") runArgs.push(`--step=${job.step}`);
  if (job.resume) runArgs.push("--resume");

  // En el contenedor se usa Xvfb; en local (Windows) XVFB_RUN=none.
  const useXvfb = process.env.XVFB_RUN !== "none";
  const tsxCli = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const command = useXvfb ? "xvfb-run" : process.execPath;
  const args = useXvfb ? ["-a", tsx, script, ...runArgs] : [tsxCli, script, ...runArgs];

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PLAYWRIGHT_NO_SANDBOX: process.env.PLAYWRIGHT_NO_SANDBOX ?? "1",
  };

  // Si el flujo manda el perfil en el POST, estos valores mandan sobre el env.
  const profile = profiles.get(job.id);
  if (profile) {
    const prefix = job.person === "me" ? "ME" : "PARTNER";
    childEnv[`${prefix}_FIRST_NAME`] = profile.firstName;
    childEnv[`${prefix}_LAST_NAME`] = profile.lastName;
    childEnv[`${prefix}_BIRTH_DATE`] = profile.birthDate;
    if (profile.phone) childEnv[`${prefix}_PHONE`] = profile.phone;
    appendLog(job, `[api] Perfil recibido en la petición (${prefix}_*); no se usa el env.\n`);
  }

  const child = spawn(command, args, {
    cwd: ROOT,
    env: childEnv,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.set(job.id, child);

  const timer = setTimeout(() => {
    if (job.status !== "running") return;
    job.status = "timeout";
    job.error = `Tiempo máximo superado (${Math.round(JOB_TIMEOUT_MS / 60_000)} min)`;
    job.endedAt = now();
    saveJob(job);
    appendLog(job, `\n[api] Timeout: matando el proceso\n`);
    killTree(job.id, "SIGTERM");
    setTimeout(() => killTree(job.id, "SIGKILL"), 10_000).unref();
  }, JOB_TIMEOUT_MS);
  timer.unref();

  child.stdout?.on("data", (d: Buffer) => appendLog(job, d));
  child.stderr?.on("data", (d: Buffer) => appendLog(job, d));

  child.on("error", (e) => {
    clearTimeout(timer);
    job.status = "failed";
    job.error = `No se pudo lanzar el runner: ${e.message}`;
    job.endedAt = now();
    saveJob(job);
    children.delete(job.id);
    profiles.delete(job.id);
    running = null;
    pump();
  });

  child.on("exit", (code, signal) => {
    clearTimeout(timer);
    children.delete(job.id);
    profiles.delete(job.id);
    if (job.status !== "timeout" && job.status !== "cancelled") {
      job.status = code === 0 ? "succeeded" : "failed";
      job.error = code === 0 ? null : `Salida ${code ?? "null"}${signal ? ` (${signal})` : ""}`;
    }
    job.exitCode = code;
    job.endedAt = now();
    saveJob(job);
    running = null;
    pump();
  });
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match?.[1]) return false;
  const given = createHash("sha256").update(match[1]).digest();
  return given.length === TOKEN_HASH.length && timingSafeEqual(given, TOKEN_HASH);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > 16_384) throw new HttpError(413, "Body demasiado grande");
    chunks.push(buf);
  }
  if (total === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("no es un objeto");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "JSON inválido");
  }
}

function parseProfile(value: unknown): Profile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "profile debe ser un objeto");
  }
  const raw = value as Record<string, unknown>;
  const firstName = String(raw.firstName ?? "").trim();
  const lastName = String(raw.lastName ?? "").trim();
  const birthDate = String(raw.birthDate ?? "").trim();
  const phone = String(raw.phone ?? "").trim();

  if (!firstName || firstName.length > 100) {
    throw new HttpError(400, "profile.firstName es obligatorio (máx. 100 caracteres)");
  }
  if (!lastName || lastName.length > 100) {
    throw new HttpError(400, "profile.lastName es obligatorio (máx. 100 caracteres)");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate) && !/^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/.test(birthDate)) {
    throw new HttpError(400, "profile.birthDate debe ser AAAA-MM-DD o DD/MM/AAAA");
  }
  if (phone.length > 30) {
    throw new HttpError(400, "profile.phone es demasiado largo");
  }
  return { firstName, lastName, birthDate, phone: phone || undefined };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".html":
      return "text/html; charset=utf-8";
    case ".txt":
    case ".log":
      return "text/plain; charset=utf-8";
    case ".json":
    case ".jsonl":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function tailFile(path: string, lines: number): string {
  const raw = readFileSync(path, "utf8");
  const slice = raw.length > MAX_LOG_BYTES ? raw.slice(-MAX_LOG_BYTES) : raw;
  const all = slice.split(/\r?\n/);
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

function walk(dir: string, base: string, out: string[], budget: { n: number }): void {
  if (budget.n <= 0) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (budget.n <= 0) return;
    const full = join(dir, entry.name);
    const rel = join(base, entry.name).replaceAll(sep, "/");
    if (entry.isDirectory()) {
      walk(full, rel, out, budget);
    } else if (entry.isFile()) {
      out.push(`${rel}\t${statSync(full).size}`);
      budget.n--;
    }
  }
}

function jobOrThrow(id: string): Job {
  const job = jobs.get(id);
  if (!job) throw new HttpError(404, "Job no encontrado");
  return job;
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "GET" && path === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "basicfit-signup-api",
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      running,
      queued: queue.length,
      jobs: jobs.size,
    });
    return;
  }

  if (!authorized(req)) {
    sendJson(res, 401, { error: "No autorizado. Usa Authorization: Bearer <token>." });
    return;
  }

  if (req.method === "POST" && path === "/run") {
    const body = await readJson(req);
    const person = body.person;
    const mode = body.mode ?? "audit";
    const step = body.step ?? "all";
    const resume = body.resume === true;
    const force = body.force === true;

    if (person !== "me" && person !== "partner") {
      throw new HttpError(400, 'person debe ser "me" o "partner"');
    }
    if (mode !== "audit" && mode !== "live") {
      throw new HttpError(400, 'mode debe ser "audit" o "live"');
    }
    if (step !== "all" && step !== "signup" && step !== "register") {
      throw new HttpError(400, 'step debe ser "all", "signup" o "register"');
    }
    if (mode === "live" && step !== "all") {
      throw new HttpError(400, 'step parcial solo se permite con mode="audit"');
    }
    if (!force) {
      const dup = activeDuplicate(person, mode, step);
      if (dup) {
        sendJson(res, 409, {
          error: "Ya hay un job activo para esa persona/modo/paso",
          existing: publicJob(dup),
        });
        return;
      }
    }
    if (queue.length >= MAX_QUEUE) {
      throw new HttpError(429, `Cola llena (${MAX_QUEUE}); espera a que termine algún job`);
    }

    const profile = body.profile === undefined ? null : parseProfile(body.profile);

    const id = randomUUID();
    const job: Job = {
      id,
      person,
      mode,
      step,
      resume,
      inlineProfile: profile !== null,
      status: "queued",
      createdAt: now(),
      startedAt: null,
      endedAt: null,
      exitCode: null,
      error: null,
      logDir: null,
      mailboxAddress: null,
      logFile: join(JOBS_DIR, `${id}.log`),
    };
    jobs.set(id, job);
    if (profile) profiles.set(id, profile);
    saveJob(job);
    appendLog(
      job,
      `[api] Job ${id}: person=${person} mode=${mode} step=${step} resume=${resume} profile=${profile ? "inline" : "env"}\n`,
    );
    queue.push(id);
    pump();

    sendJson(res, 202, publicJob(job));
    return;
  }

  if (req.method === "GET" && path === "/jobs") {
    const list = [...jobs.values()]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 100)
      .map(publicJob);
    sendJson(res, 200, { jobs: list });
    return;
  }

  const jobMatch = /^\/jobs\/([a-f0-9-]+)(?:\/(log|files|file|cancel))?$/.exec(path);
  if (jobMatch) {
    const id = jobMatch[1]!;
    const action = jobMatch[2];
    const job = jobOrThrow(id);

    if (req.method === "POST" && action === "cancel") {
      if (job.status === "queued") {
        const idx = queue.indexOf(id);
        if (idx >= 0) queue.splice(idx, 1);
        job.status = "cancelled";
        job.endedAt = now();
        profiles.delete(id);
        saveJob(job);
      } else if (job.status === "running") {
        job.status = "cancelled";
        job.error = "Cancelado por petición";
        job.endedAt = now();
        saveJob(job);
        killTree(id, "SIGTERM");
        setTimeout(() => killTree(id, "SIGKILL"), 10_000).unref();
      }
      sendJson(res, 200, publicJob(job));
      return;
    }

    if (req.method === "GET" && action === "log") {
      const lines = Math.min(5_000, Math.max(1, Number(url.searchParams.get("lines") ?? 400)));
      const body = existsSync(job.logFile) ? tailFile(job.logFile, lines) : "(sin log todavía)";
      sendText(res, 200, body);
      return;
    }

    if (req.method === "GET" && action === "files") {
      if (!job.logDir || !existsSync(job.logDir)) {
        sendJson(res, 200, { logDir: job.logDir, files: [] });
        return;
      }
      const files: string[] = [];
      walk(job.logDir, "", files, { n: 500 });
      sendJson(res, 200, { logDir: job.logDir, files });
      return;
    }

    if (req.method === "GET" && action === "file") {
      if (!job.logDir) throw new HttpError(404, "El job aún no tiene carpeta de ejecución");
      const rel = url.searchParams.get("path");
      if (!rel) throw new HttpError(400, "Falta ?path=");
      const base = resolve(job.logDir);
      const target = resolve(base, rel);
      if (target !== base && !target.startsWith(base + sep)) {
        throw new HttpError(400, "Ruta fuera del job");
      }
      if (!existsSync(target) || !statSync(target).isFile()) {
        throw new HttpError(404, "Archivo no encontrado");
      }
      res.writeHead(200, {
        "Content-Type": contentType(target),
        "Content-Length": statSync(target).size,
        "Cache-Control": "no-store",
      });
      createReadStream(target).pipe(res);
      return;
    }

    if (req.method === "GET" && !action) {
      const wait = Math.min(120, Math.max(0, Number(url.searchParams.get("wait") ?? 0)));
      if (wait > 0) {
        const deadline = Date.now() + wait * 1000;
        while (Date.now() < deadline) {
          if (job.status !== "queued" && job.status !== "running") break;
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
      sendJson(res, 200, publicJob(job));
      return;
    }
  }

  sendJson(res, 404, { error: "Ruta no encontrada" });
}

const server = createServer((req, res) => {
  route(req, res).catch((e) => {
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) console.error(e);
    if (!res.headersSent) {
      sendJson(res, status, { error: (e as Error).message });
    } else {
      res.end();
    }
  });
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(`\n[api] ${signal}: cerrando...`);
  for (const id of children.keys()) killTree(id, "SIGTERM");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

loadJobs();
server.listen(PORT, BIND, () => {
  console.log(`[api] escuchando en http://${BIND}:${PORT}`);
  console.log(`[api] token configurado (${TOKEN.length} caracteres)`);
});
