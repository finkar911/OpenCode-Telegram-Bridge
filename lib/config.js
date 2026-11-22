import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_UNLOCK_MINUTES = 12 * 60;
const MAX_PIN_FAILURES = 5;
const PIN_LOCKOUT_MS = 15 * 60 * 1000;

export function parseDotenv(text) {
  const values = {};
  for (const rawLine of String(text).replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function defaultPaths(home = os.homedir(), env = process.env) {
  const stateHome = env.XDG_STATE_HOME
    ? env.XDG_STATE_HOME
    : path.join(home, ".local", "state");
  const configHome = env.XDG_CONFIG_HOME
    ? env.XDG_CONFIG_HOME
    : path.join(home, ".config");
  return {
    home,
    serviceFile: path.join(stateHome, "opencode", "service.json"),
    stateDir: path.join(stateHome, "opencode-telegram-bridge"),
    stateFile: path.join(stateHome, "opencode-telegram-bridge", "state.json"),
    envFile: path.join(configHome, "opencode", "telegram.env"),
  };
}

export function loadConfig(env = process.env, paths = defaultPaths()) {
  const envFile = env.TELEGRAM_ENV_FILE
    ? path.resolve(env.TELEGRAM_ENV_FILE)
    : paths.envFile;
  let fileValues = {};
  if (fs.existsSync(envFile)) {
    fileValues = parseDotenv(readTextFile(envFile));
  }
  const value = (name) => String(env[name] ?? fileValues[name] ?? "").trim();

  const pin = value("TELEGRAM_PIN");
  const unlockMinutes = parsePositiveInt(
    value("TELEGRAM_UNLOCK_MINUTES"),
    DEFAULT_UNLOCK_MINUTES,
  );

  return {
    envFile,
    token: value("TELEGRAM_BOT_TOKEN"),
    ownerId: parseTelegramId(value("TELEGRAM_OWNER_ID")),
    pin,
    unlockMs: unlockMinutes * 60 * 1000,
    apiBase: value("TELEGRAM_API_BASE") || "https://api.telegram.org",
    projectAliases: parseAliases(value("TELEGRAM_PROJECT_ALIASES")),
    notifySubagents: value("NOTIFY_SUBAGENTS") === "true",
    logLevel: value("TELEGRAM_LOG_LEVEL") || "info",
    stateFile: value("TELEGRAM_STATE_FILE") || paths.stateFile,
    opencodeUrl: value("OPENCODE_URL"),
    opencodePassword: value("OPENCODE_PASSWORD"),
    opencodeServiceFile: value("OPENCODE_STATE_FILE") || paths.serviceFile,
  };
}

export function validateForRun(config) {
  if (!config.token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is not set. Put it in " +
        config.envFile +
        " or the process environment.",
    );
  }
  if (!config.ownerId) {
    throw new Error(
      "TELEGRAM_OWNER_ID is not set. Use the numeric id from @userinfobot.",
    );
  }
}

function readTextFile(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.slice(2).toString("utf16le");
  }
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

function parsePositiveInt(text, fallback) {
  if (!text) return fallback;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export function parseTelegramId(text) {
  const s = String(text ?? "").trim();
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

function parseAliases(text) {
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("TELEGRAM_PROJECT_ALIASES is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("TELEGRAM_PROJECT_ALIASES must be a JSON object");
  }
  const aliases = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string" && value.trim()) aliases[key] = value.trim();
  }
  return aliases;
}

export class AuthGate {
  constructor({ ownerId, pin = "", unlockMs = DEFAULT_UNLOCK_MINUTES * 60 * 1000, now = Date.now }) {
    this.ownerId = Number(ownerId);
    this.pin = String(pin || "");
    this.pinHash = hash(this.pin);
    this.unlockMs = unlockMs;
    this.now = now;
    this.unlockedUntil = 0;
    this.failures = 0;
    this.lockUntil = 0;
  }

  check({ from, chat } = {}) {
    if (!from || Number(from.id) !== this.ownerId) return "ignore";
    if (!chat || chat.type !== "private") return "ignore";
    if (!this.pin) return "ok";
    const now = this.now();
    if (this.lockUntil && now >= this.lockUntil) {
      this.lockUntil = 0;
      this.failures = 0;
    }
    return now < this.unlockedUntil ? "ok" : "locked";
  }

  unlock(candidate) {
    const now = this.now();
    if (this.lockUntil && now < this.lockUntil) {
      return { ok: false, reason: "locked", retryAt: this.lockUntil };
    }
    if (!this.pin) {
      this.unlockedUntil = now + this.unlockMs;
      return { ok: true };
    }
    const supplied = hash(String(candidate ?? ""));
    if (crypto.timingSafeEqual(supplied, this.pinHash)) {
      this.failures = 0;
      this.lockUntil = 0;
      this.unlockedUntil = now + this.unlockMs;
      return { ok: true };
    }
    this.failures += 1;
    if (this.failures >= MAX_PIN_FAILURES) {
      this.failures = 0;
      this.lockUntil = now + PIN_LOCKOUT_MS;
      return { ok: false, reason: "too-many", retryAt: this.lockUntil };
    }
    return {
      ok: false,
      reason: "bad-pin",
      attemptsLeft: MAX_PIN_FAILURES - this.failures,
    };
  }

  lock() {
    this.unlockedUntil = 0;
  }

  isUnlocked() {
    if (!this.pin) return true;
    return this.now() < this.unlockedUntil;
  }
}

function hash(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

export function loadState(file) {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""),
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

export function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best effort
    }
  }
}
