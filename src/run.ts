import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type PersonId } from "./config.ts";
import { initLogging, info, ok, warn, error, step } from "./logger.ts";
import { createMailbox, reopenMailbox } from "./mail/mailtm.ts";
import type { Mailbox } from "./mail/types.ts";
import { launchBrowser, newContext, stepSnap, waitPastChallenge } from "./browser.ts";
import { runSignup } from "./flow/signup.ts";
import { runRegister } from "./flow/register.ts";

interface RunState {
  person: PersonId;
  startedAt: string;
  logDir: string;
  mailbox: { address: string; password: string };
  signupSubmitted: boolean;
  signupDone: boolean;
  registerSubmitted: boolean;
  registerDone: boolean;
  emailIds: string[];
  storageStatePath?: string;
}

function readState(path: string): RunState | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RunState;
  } catch {
    return null;
  }
}

function saveState(path: string, state: RunState): void {
  writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
}

async function main(): Promise<void> {
  const config = loadConfig();
  const person = config.person;
  const stateDir = join(process.cwd(), config.runsDir, "state");
  mkdirSync(stateDir, { recursive: true });
  const statePath = join(stateDir, `${person.id}.json`);

  let state = config.resume ? readState(statePath) : null;
  if (config.resume && !state) {
    throw new Error(`No hay estado previo para ${person.id} en ${statePath}`);
  }

  if (!state) {
    const logDir = join(
      process.cwd(),
      config.runsDir,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${person.id}`,
    );
    state = {
      person: person.id,
      startedAt: new Date().toISOString(),
      logDir,
      mailbox: { address: "", password: "" },
      signupSubmitted: false,
      signupDone: false,
      registerSubmitted: false,
      registerDone: false,
      emailIds: [],
    };
  }

  // Estados antiguos sin los nuevos campos.
  state.signupSubmitted ??= false;
  state.registerSubmitted ??= false;
  const st: RunState = state;

  initLogging(state.logDir);
  info(`Persona: ${person.id} (${person.firstName} ${person.lastName})`);
  info(`Modo: ${config.mode}`);
  info(`Carpeta de ejecución: ${state.logDir}`);
  info(`Estado: ${statePath}`);

  let mailbox: Mailbox;
  if (config.resume && state.mailbox.address) {
    const reopened = await reopenMailbox(state.mailbox.address, state.mailbox.password);
    mailbox = reopened.mailbox;
    ok(`Buzón reabierto: ${reopened.address}`);
  } else {
    const created = await createMailbox();
    mailbox = created.mailbox;
    state.mailbox = { address: created.address, password: created.password };
    saveState(statePath, state);
    ok(`Buzón desechable: ${created.address}`);
  }

  const browser = await launchBrowser();
  const context = await newContext(browser);

  // Solo se restauran cookies si el alta sigue pendiente. Con el alta ya hecha
  // el registro va por email y cookies viejas pueden dejar la web en mal estado.
  if (config.resume && !state.signupDone && state.storageStatePath && existsSync(state.storageStatePath)) {
    // Reutiliza cookies de la ejecución anterior en el mismo origen.
    const saved = JSON.parse(readFileSync(state.storageStatePath, "utf8")) as {
      cookies?: Parameters<typeof context.addCookies>[0];
    };
    if (saved.cookies?.length) {
      await context.addCookies(saved.cookies);
      info(`Cookies restauradas: ${saved.cookies.length}`);
    }
  }

  const page = await context.newPage();
  const runSignupStep = config.step === "all" || config.step === "signup";
  const runRegisterStep = config.step === "all" || config.step === "register";
  const justSignedUp = runSignupStep && !state.signupDone;

  try {
    if (runSignupStep && !state.signupDone) {
      const result = await runSignup(
        page,
        config,
        mailbox,
        state.logDir,
        state.startedAt,
        state.emailIds,
        {
          skipSubmit: st.signupSubmitted,
          onSubmitted: async () => {
            st.signupSubmitted = true;
            st.storageStatePath = join(st.logDir, "storage.json");
            await context.storageState({ path: st.storageStatePath });
            saveState(statePath, st);
            info("Estado guardado: alta enviada.");
          },
        },
      );

      if (config.mode === "audit") {
        info("Auditoría del paso 1 completada. No se ha enviado nada.");
        return;
      }

      if (result.email) state.emailIds.push(result.email.id);
      state.signupDone = true;
      state.storageStatePath = join(state.logDir, "storage.json");
      await context.storageState({ path: state.storageStatePath });
      saveState(statePath, state);
      ok("Paso 1-2 completados: alta enviada y correo recibido.");
    } else if (runSignupStep) {
      info("Paso 1-2 ya completados en una ejecución anterior; continúo con el registro.");
    }

    if (runRegisterStep && !state.registerDone) {
      // Si el alta acaba de enviarse, deja que Basic-Fit la asiente antes del registro.
      if (justSignedUp && config.mode === "live" && config.signupSettleMs > 0) {
        info(`Espero ${Math.round(config.signupSettleMs / 1000)}s antes del registro para que el alta se asiente.`);
        await new Promise((r) => setTimeout(r, config.signupSettleMs));
      }

      const result = await runRegister(
        page,
        config,
        mailbox,
        state.logDir,
        state.startedAt,
        state.emailIds,
        {
          skipSubmit: st.registerSubmitted,
          onSubmitted: async () => {
            st.registerSubmitted = true;
            st.storageStatePath = join(st.logDir, "storage.json");
            await context.storageState({ path: st.storageStatePath });
            saveState(statePath, st);
            info("Estado guardado: correo de contraseña solicitado.");
          },
        },
      );

      if (config.mode === "audit") {
        info("Auditoría del paso 3 completada. No se ha enviado nada.");
        return;
      }

      if (!result) throw new Error("El registro no devolvió resultado en modo live");
      state.emailIds.push(result.passwordEmail.id);
      state.registerDone = true;
      state.storageStatePath = join(state.logDir, "storage.json");
      await context.storageState({ path: state.storageStatePath });
      saveState(statePath, state);
      ok("Pasos 3-5 completados.");
    } else {
      info("El registro ya estaba completado para esta persona.");
    }

    step("FLUJO COMPLETO", {
      persona: `${person.firstName} ${person.lastName}`,
      email: mailbox.address,
    });
  } catch (e) {
    error("Flujo interrumpido", { message: (e as Error).message });
    await stepSnap(page, state.logDir, "error").catch(() => {});
    saveState(statePath, state);
    throw e;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await mailbox.close().catch(() => {});
  }
}

main().catch((e) => {
  error("Error fatal", { message: (e as Error).message, stack: (e as Error).stack });
  process.exitCode = 1;
});
