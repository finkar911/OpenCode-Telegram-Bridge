import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AuthGate,
  loadConfig,
  parseDotenv,
  parseTelegramId,
  validateForRun,
} from "../lib/config.js";

test("parseDotenv keeps values and strips surrounding quotes", () => {
  const parsed = parseDotenv(`\uFEFF
# comment
TELEGRAM_OWNER_ID=12345
TELEGRAM_BOT_TOKEN="123:abc"
TELEGRAM_PROJECT_ALIASES='{"p":"Demo"}'
EMPTY=
`);
  assert.equal(parsed.TELEGRAM_OWNER_ID, "12345");
  assert.equal(parsed.TELEGRAM_BOT_TOKEN, "123:abc");
  assert.equal(parsed.TELEGRAM_PROJECT_ALIASES, '{"p":"Demo"}');
  assert.equal(parsed.EMPTY, "");
});

test("loadConfig reads env values, aliases and defaults", () => {
  const config = loadConfig(
    {
      TELEGRAM_BOT_TOKEN: "123:abc",
      TELEGRAM_OWNER_ID: "777",
      TELEGRAM_PIN: "4321",
      TELEGRAM_UNLOCK_MINUTES: "30",
      TELEGRAM_PROJECT_ALIASES: '{"p1":"Demo"}',
      NOTIFY_SUBAGENTS: "true",
    },
    {
      envFile: "Z:\\definitely-missing\\telegram.env",
      stateFile: "Z:\\state.json",
      serviceFile: "Z:\\service.json",
    },
  );
  assert.equal(config.token, "123:abc");
  assert.equal(config.ownerId, 777);
  assert.equal(config.pin, "4321");
  assert.equal(config.unlockMs, 30 * 60 * 1000);
  assert.deepEqual(config.projectAliases, { p1: "Demo" });
  assert.equal(config.notifySubagents, true);
});

test("loadConfig reads a UTF-16LE Notepad env file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tg-env-"));
  const envFile = path.join(directory, "telegram.env");
  fs.writeFileSync(
    envFile,
    Buffer.from("\uFEFFTELEGRAM_OWNER_ID=555\r\nTELEGRAM_PIN=9999\r\n", "utf16le"),
  );
  const config = loadConfig(
    {},
    {
      envFile,
      stateFile: path.join(directory, "state.json"),
      serviceFile: path.join(directory, "service.json"),
    },
  );
  assert.equal(config.ownerId, 555);
  assert.equal(config.pin, "9999");
  fs.rmSync(directory, { recursive: true, force: true });
});

test("loadConfig rejects invalid aliases JSON", () => {
  assert.throws(
    () =>
      loadConfig(
        { TELEGRAM_PROJECT_ALIASES: "{oops" },
        { envFile: "Z:\\missing", stateFile: "Z:\\state", serviceFile: "Z:\\svc" },
      ),
    /not valid JSON/,
  );
});

test("parseTelegramId accepts numeric ids only", () => {
  assert.equal(parseTelegramId(" 12345 "), 12345);
  assert.equal(parseTelegramId("-100123"), -100123);
  assert.equal(parseTelegramId("abc"), null);
  assert.equal(parseTelegramId(""), null);
});

test("validateForRun requires token and owner", () => {
  assert.throws(
    () => validateForRun({ token: "", ownerId: 1, envFile: "x" }),
    /TELEGRAM_BOT_TOKEN/,
  );
  assert.throws(
    () => validateForRun({ token: "t", ownerId: null, envFile: "x" }),
    /TELEGRAM_OWNER_ID/,
  );
});

test("AuthGate serves only the owner in a private chat", () => {
  const gate = new AuthGate({ ownerId: 10, pin: "" });
  assert.equal(
    gate.check({ from: { id: 10 }, chat: { id: 10, type: "private" } }),
    "ok",
  );
  assert.equal(
    gate.check({ from: { id: 11 }, chat: { id: 11, type: "private" } }),
    "ignore",
  );
  assert.equal(
    gate.check({ from: { id: 10 }, chat: { id: -100, type: "group" } }),
    "ignore",
  );
});

test("AuthGate PIN unlock, lock and lockout", () => {
  let clock = 1_000_000;
  const gate = new AuthGate({
    ownerId: 10,
    pin: "4321",
    unlockMs: 60_000,
    now: () => clock,
  });
  const owner = { from: { id: 10 }, chat: { id: 10, type: "private" } };

  assert.equal(gate.check(owner), "locked");
  const wrong = gate.unlock("0000");
  assert.equal(wrong.reason, "bad-pin");
  assert.equal(wrong.attemptsLeft, 4);

  assert.equal(gate.unlock("4321").ok, true);
  assert.equal(gate.check(owner), "ok");
  clock += 60_001;
  assert.equal(gate.check(owner), "locked");

  gate.lock();
  assert.equal(gate.check(owner), "locked");
});

test("AuthGate blocks PIN attempts after five failures", () => {
  let clock = 5_000_000;
  const gate = new AuthGate({
    ownerId: 10,
    pin: "4321",
    unlockMs: 60_000,
    now: () => clock,
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.equal(gate.unlock("bad").reason, "bad-pin");
  }
  assert.equal(gate.unlock("bad").reason, "too-many");
  assert.equal(gate.unlock("4321").reason, "locked");

  clock += 15 * 60 * 1000 + 1;
  assert.equal(gate.unlock("4321").ok, true);
});
