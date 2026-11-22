#!/usr/bin/env node
import {
  AuthGate,
  defaultPaths,
  loadConfig,
  loadState,
  saveState,
  validateForRun,
} from "./lib/config.js";
import { OpenCodeClient } from "./lib/opencode.js";
import { TelegramClient } from "./lib/telegram.js";
import { Bot } from "./lib/bot.js";
import { dedupeProjects, redact } from "./lib/ui.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function createLogger(level, secrets) {
  const threshold = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  const write = (name, args) => {
    if (LOG_LEVELS[name] > threshold) return;
    const text = args
      .map((value) => (value instanceof Error ? value.message : String(value)))
      .join(" ");
    console.log(
      `${new Date().toISOString()} ${name.toUpperCase()} ${redact(text, secrets)}`,
    );
  };
  return {
    error: (...args) => write("error", args),
    warn: (...args) => write("warn", args),
    info: (...args) => write("info", args),
    debug: (...args) => write("debug", args),
  };
}

async function runCheck(config) {
  console.log(`Env file: ${config.envFile}`);
  console.log(`OpenCode state: ${config.opencodeServiceFile}`);
  console.log(
    `Telegram token: ${config.token ? "set" : "MISSING (TELEGRAM_BOT_TOKEN)"}`,
  );
  console.log(
    `Owner ID: ${config.ownerId ?? "MISSING (TELEGRAM_OWNER_ID)"}`,
  );
  console.log(
    `PIN: ${config.pin ? "set" : "not set (owner allowlist only)"}`,
  );

  const oc = new OpenCodeClient({
    url: config.opencodeUrl,
    password: config.opencodePassword,
    stateFile: config.opencodeServiceFile,
  });
  let opencodeOk = false;
  try {
    const info = await oc.info();
    const projects = await oc.projects();
    const sessions = await oc.sessions({ limit: 5 });
    console.log(`OpenCode: ${info?.version || "unknown"} at ${oc.url}`);
    console.log(
      `Projects: ${projects.length} (${dedupeProjects(projects).length} unique paths)`,
    );
    console.log(`Recent sessions: ${sessions.length}`);
    opencodeOk = true;
  } catch (error) {
    console.log(`OpenCode: ERROR ${error.message}`);
  }

  let telegramTokenOk = false;
  if (config.token) {
    try {
      const me = await new TelegramClient({
        token: config.token,
        apiBase: config.apiBase,
      }).getMe();
      console.log(`Telegram bot: @${me.username || me.first_name || me.id}`);
      telegramTokenOk = true;
    } catch (error) {
      console.log(`Telegram: ERROR ${error.message}`);
    }
  }
  const telegramReady = Boolean(config.token && config.ownerId && telegramTokenOk);
  const telegramStatus = !config.token || !config.ownerId
    ? "NOT CONFIGURED"
    : telegramTokenOk
      ? "OK"
      : "FAIL";

  console.log(
    `Result: OpenCode ${opencodeOk ? "OK" : "FAIL"} · Telegram ${telegramStatus}`,
  );
  return opencodeOk && telegramReady;
}

async function pollUpdates({ tg, bot, config, state, signal, log }) {
  let offset = Number.isSafeInteger(state.offset) ? state.offset : 0;
  let backoff = 1000;

  while (!signal.aborted) {
    try {
      const updates = await tg.getUpdates({ offset, timeout: 50, signal });
      backoff = 1000;
      for (const update of updates) {
        offset = update.update_id + 1;
        state.offset = offset;
        await bot.handleUpdate(update);
        try {
          saveState(config.stateFile, state);
        } catch (error) {
          log.warn(`cannot save state: ${error.message}`);
        }
      }
    } catch (error) {
      if (signal.aborted) break;
      if (error.status === 401) {
        log.error("Telegram rejected the bot token (401). Stopping.");
        throw error;
      }
      log.warn(`getUpdates failed: ${error.message}; retry in ${backoff}ms`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    console.log(`Usage: node bridge.js [--check] [--help]

  --check   check OpenCode connectivity and Telegram configuration, do not poll
  --help    show this help

Environment is loaded from %USERPROFILE%\\.config\\opencode\\telegram.env
(override with TELEGRAM_ENV_FILE). Required: TELEGRAM_BOT_TOKEN and
TELEGRAM_OWNER_ID. Optional: TELEGRAM_PIN, TELEGRAM_PROJECT_ALIASES,
OPENCODE_URL, OPENCODE_PASSWORD.`);
    return 0;
  }

  const paths = defaultPaths();
  let config;
  try {
    config = loadConfig(process.env, paths);
  } catch (error) {
    console.error(`Configuration error: ${error.message}`);
    return 2;
  }
  const log = createLogger(config.logLevel, [
    config.token,
    config.opencodePassword,
    config.pin,
  ]);

  if (args.has("--check")) {
    const ok = await runCheck(config);
    return ok ? 0 : 1;
  }

  try {
    validateForRun(config);
  } catch (error) {
    console.error(`Configuration error: ${error.message}`);
    return 2;
  }

  const state = loadState(config.stateFile);
  const oc = new OpenCodeClient({
    url: config.opencodeUrl,
    password: config.opencodePassword,
    stateFile: config.opencodeServiceFile,
  });
  const tg = new TelegramClient({ token: config.token, apiBase: config.apiBase });
  const auth = new AuthGate({
    ownerId: config.ownerId,
    pin: config.pin,
    unlockMs: config.unlockMs,
  });
  const bot = new Bot({ tg, oc, auth, config, state, log });

  let me;
  try {
    me = await tg.getMe();
  } catch (error) {
    log.error(`Telegram getMe failed: ${error.message}`);
    return 1;
  }
  log.info(`Telegram bot ready: @${me.username || me.first_name || me.id}`);
  try {
    await bot.installMenus();
    log.info("Telegram command menu installed");
  } catch (error) {
    log.warn(`Cannot install Telegram command menu: ${error.message}`);
  }
  if (!config.pin) {
    log.warn(
      "TELEGRAM_PIN is not set; access is limited to TELEGRAM_OWNER_ID only",
    );
  }

  const controller = new AbortController();
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    log.info("stopping");
    controller.abort();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const handledEvents = new Set([
    "session.execution.started",
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
    "form.created",
    "form.replied",
    "form.cancelled",
    "permission.asked",
    "permission.replied",
    "session.renamed",
    "session.deleted",
  ]);
  log.info(`watching OpenCode events (${config.opencodeUrl || "auto-discovery"})`);
  const eventLoop = oc.subscribe((event) => {
    if (!handledEvents.has(event.type)) return;
    return bot.handleEvent(event);
  }, {
    signal: controller.signal,
    onStatus: (name, error) => {
      if (name === "connected") log.info(`OpenCode event stream connected (${oc.url})`);
      else if (name === "disconnected") log.warn("OpenCode event stream closed");
      else if (name === "waiting" || name === "error") {
        log.warn(`OpenCode event stream ${name}: ${error?.message || "unknown"}`);
      } else if (name === "handler-error") {
        log.error(`OpenCode event handler failed: ${error?.message || error}`);
      }
    },
  });
  let fatal = false;
  const pollLoop = pollUpdates({
    tg,
    bot,
    config,
    state,
    signal: controller.signal,
    log,
  }).catch((error) => {
    fatal = true;
    log.error(`Telegram polling stopped: ${error.message}`);
    controller.abort();
  });

  await Promise.allSettled([eventLoop, pollLoop]);
  return fatal ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`Fatal: ${error?.stack || error}`);
    process.exitCode = 1;
  });
