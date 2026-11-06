import type { Mailbox, MailMessage, WaitOptions } from "./types.ts";
import { info, warn } from "../logger.ts";

const API = process.env.MAILTM_API ?? "https://api.mail.tm";
const API_TIMEOUT_MS = 20_000;

interface Hydra<T> {
  "hydra:member"?: T[];
  "hydra:totalItems"?: number;
}

function collection<T>(data: T[] | Hydra<T>): T[] {
  if (Array.isArray(data)) return data;
  return data["hydra:member"] ?? [];
}

interface Domain {
  id: string;
  domain: string;
  isActive: boolean;
  isPrivate: boolean;
}

interface Account {
  id: string;
  address: string;
}

interface Token {
  token: string;
  id: string;
}

interface RawMessageSummary {
  id: string;
  subject: string;
  from: { address: string; name?: string };
  createdAt: string;
  seen: boolean;
}

interface RawMessage extends RawMessageSummary {
  text: string;
  html: string[];
}

async function api<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(init.body ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  for (let attempt = 1; attempt <= 4; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const res = await fetch(`${API}${path}`, { ...init, headers, signal: controller.signal });
      if (res.status === 429) {
        const wait = 2_000 * attempt;
        warn(`mail.tm rate limit (429), reintento en ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`mail.tm ${init.method ?? "GET"} ${path} -> ${res.status} ${body.slice(0, 300)}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`mail.tm ${path}: demasiados reintentos`);
}

function mapMessage(raw: RawMessage): MailMessage {
  return {
    id: raw.id,
    subject: raw.subject ?? "",
    from: { address: raw.from?.address ?? "", name: raw.from?.name ?? "" },
    createdAt: raw.createdAt,
    text: raw.text ?? "",
    html: Array.isArray(raw.html) ? raw.html.join("\n") : (raw.html ?? ""),
  };
}

class MailTmMailbox implements Mailbox {
  readonly address: string;
  readonly password: string;
  private token: string;
  private seen = new Set<string>();

  constructor(address: string, password: string, token: string) {
    this.address = address;
    this.password = password;
    this.token = token;
  }

  private async listSummaries(): Promise<RawMessageSummary[]> {
    const page = await api<RawMessageSummary[] | Hydra<RawMessageSummary>>("/messages?page=1", {}, this.token);
    return collection(page);
  }

  async getMessage(id: string): Promise<MailMessage> {
    const raw = await api<RawMessage>(`/messages/${id}`, {}, this.token);
    return mapMessage(raw);
  }

  async waitForMessage(options: WaitOptions): Promise<MailMessage> {
    const pollMs = options.pollMs ?? 5_000;
    const started = Date.now();
    const since = options.since ? Date.parse(options.since) : 0;
    const exclude = new Set(options.excludeIds ?? []);
    let lastLogged = 0;

    info(`Esperando "${options.label}" en ${this.address} (máx. ${Math.round(options.timeoutMs / 60_000)} min)`);

    while (Date.now() - started < options.timeoutMs) {
      const summaries = await this.listSummaries().catch((e: Error) => {
        warn(`Error consultando el buzón: ${e.message}`);
        return [];
      });

      const candidates = summaries
        .filter((m) => !exclude.has(m.id))
        .filter((m) => {
          const created = Date.parse(m.createdAt);
          return Number.isFinite(created) ? created >= since - 60_000 : true;
        })
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

      for (const summary of candidates) {
        if (this.seen.has(summary.id)) continue;
        const message = await this.getMessage(summary.id);
        this.seen.add(summary.id);
        info(`Correo recibido: "${message.subject}" de ${message.from.address}`);
        if (!options.match || options.match(message)) return message;
      }

      const elapsed = Date.now() - started;
      if (elapsed - lastLogged >= 30_000) {
        lastLogged = elapsed;
        info(`Seguimos esperando "${options.label}" (${Math.round(elapsed / 1000)}s, ${summaries.length} correo(s) en el buzón)`);
      }

      await new Promise((r) => setTimeout(r, pollMs));
    }

    throw new Error(`Timeout esperando "${options.label}" en ${this.address}`);
  }

  async close(): Promise<void> {
    // No se borra el buzón: guardamos las credenciales para poder reanudar.
  }
}

export interface CreatedMailbox {
  mailbox: Mailbox;
  address: string;
  password: string;
  token: string;
}

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

/**
 * Parte local distinta en cada ejecución: 10-13 letras aleatorias + 2-4 dígitos.
 * Sin prefijo fijo ni nombres reales, que mail.tm rechaza como "username no válido".
 */
function randomLocalPart(): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  const letterCount = 10 + Math.floor(Math.random() * 4);
  const digitCount = 2 + Math.floor(Math.random() * 3);

  let out = "";
  for (let i = 0; i < letterCount; i++) out += letters[Math.floor(Math.random() * letters.length)];
  for (let i = 0; i < digitCount; i++) out += digits[Math.floor(Math.random() * digits.length)];
  return out;
}

function randomPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 20; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${out}.aA1`;
}

async function pickDomain(): Promise<string> {
  if (process.env.MAIL_DOMAIN) return process.env.MAIL_DOMAIN;
  const page = await api<Domain[] | Hydra<Domain>>("/domains?page=1");
  const domains = collection(page).filter((d) => d.isActive && !d.isPrivate);
  if (domains.length === 0) throw new Error("mail.tm no ofrece ningún dominio activo");
  const domain = pick(domains);
  info(`Dominio de correo: ${domain.domain}`);
  return domain.domain;
}

export async function createMailbox(): Promise<CreatedMailbox> {
  const domain = await pickDomain();
  const password = randomPassword();

  for (let attempt = 1; attempt <= 5; attempt++) {
    const address = `${randomLocalPart()}@${domain}`;
    try {
      const account = await api<Account>("/accounts", {
        method: "POST",
        body: JSON.stringify({ address, password }),
      });
      const token = await api<Token>("/token", {
        method: "POST",
        body: JSON.stringify({ address, password }),
      });
      info(`Buzón creado: ${account.address}`);
      return {
        mailbox: new MailTmMailbox(account.address, password, token.token),
        address: account.address,
        password,
        token: token.token,
      };
    } catch (e) {
      warn(`No se pudo crear ${address} (intento ${attempt}/5): ${(e as Error).message}`);
    }
  }

  throw new Error("No se pudo crear ningún buzón en mail.tm");
}

export async function reopenMailbox(address: string, password: string): Promise<CreatedMailbox> {
  const token = await api<Token>("/token", {
    method: "POST",
    body: JSON.stringify({ address, password }),
  });
  return { mailbox: new MailTmMailbox(address, password, token.token), address, password, token: token.token };
}
