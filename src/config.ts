import "dotenv/config";

export type PersonId = "me" | "partner";
export type Mode = "audit" | "live";

export interface Person {
  id: PersonId;
  firstName: string;
  lastName: string;
  birthDate: string;
  phone?: string;
}

export type Step = "all" | "signup" | "register";

export interface AppConfig {
  mode: Mode;
  step: Step;
  person: Person;
  password: string;
  signupUrl: string;
  registerUrl: string;
  mailWaitMs: number;
  challengeWaitMs: number;
  resume: boolean;
  runsDir: string;
}

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit?.slice(prefix.length);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

function normalizeDate(value: string): string {
  const trimmed = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) return trimmed;
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  }
  throw new Error(`Fecha de nacimiento no válida: "${value}" (usa AAAA-MM-DD)`);
}

export function loadConfig(): AppConfig {
  const personId = (arg("person") ?? process.env.PERSON ?? "me") as PersonId;
  if (personId !== "me" && personId !== "partner") {
    throw new Error(`--person debe ser "me" o "partner", no "${personId}"`);
  }

  const mode = (arg("mode") ?? process.env.MODE ?? "audit") as Mode;
  if (mode !== "audit" && mode !== "live") {
    throw new Error(`--mode debe ser "audit" o "live", no "${mode}"`);
  }

  const step = (arg("step") ?? "all") as Step;
  if (step !== "all" && step !== "signup" && step !== "register") {
    throw new Error(`--step debe ser "all", "signup" o "register", no "${step}"`);
  }
  if (mode === "live" && step !== "all") {
    throw new Error("--step parcial solo está permitido en modo audit");
  }

  const prefix = personId === "me" ? "ME" : "PARTNER";
  const phone = process.env[`${prefix}_PHONE`]?.trim();

  return {
    mode,
    step,
    person: {
      id: personId,
      firstName: required(`${prefix}_FIRST_NAME`),
      lastName: required(`${prefix}_LAST_NAME`),
      birthDate: normalizeDate(required(`${prefix}_BIRTH_DATE`)),
      phone: phone || undefined,
    },
    password: process.env.BF_PASSWORD ?? "12345678Aa.",
    signupUrl:
      process.env.SIGNUP_URL ??
      "https://member.basic-fit.com/es-ES/signup/BlackFriday_FitTogether",
    registerUrl: process.env.REGISTER_URL ?? "https://login.basic-fit.com/register",
    mailWaitMs: Number(process.env.MAIL_WAIT_MINUTES ?? 20) * 60_000,
    challengeWaitMs: Number(process.env.CHALLENGE_WAIT_MINUTES ?? 5) * 60_000,
    resume: process.argv.includes("--resume"),
    runsDir: process.env.RUNS_DIR ?? "runs",
  };
}
