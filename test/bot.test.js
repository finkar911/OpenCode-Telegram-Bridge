import test from "node:test";
import assert from "node:assert/strict";
import { AuthGate } from "../lib/config.js";
import { Bot } from "../lib/bot.js";

class FakeTelegram {
  constructor() {
    this.messages = [];
    this.answers = [];
    this.edits = [];
    this.editTexts = [];
    this.commands = [];
    this.menuButton = false;
    this.documents = [];
    this.getFileCalls = [];
    this.downloadCalls = [];
    this.nextId = 100;
  }

  async sendMessage(chatId, text, options = {}) {
    const message = {
      message_id: ++this.nextId,
      chatId,
      text,
      options,
    };
    this.messages.push(message);
    return message;
  }

  async sendLong(chatId, text, options = {}) {
    return this.sendMessage(chatId, text, options);
  }

  async answerCallbackQuery(id, text = "") {
    this.answers.push({ id, text });
  }

  async editMessageReplyMarkup(chatId, messageId, keyboard) {
    this.edits.push({ chatId, messageId, keyboard });
  }

  async editMessageText(chatId, messageId, text, options = {}) {
    this.editTexts.push({ chatId, messageId, text, options });
    const message = this.messages.find(
      (item) => item.message_id === messageId,
    );
    if (message) {
      message.text = text;
      message.options.keyboard = options.keyboard;
    }
    return true;
  }

  async sendDocument(chatId, filename, content, options = {}) {
    this.documents.push({ chatId, filename, content, options });
    return { message_id: ++this.nextId };
  }

  async getFile(fileId) {
    this.getFileCalls.push(fileId);
    return { file_path: `photos/${fileId}.jpg`, file_size: 4 };
  }

  async downloadFile(filePath) {
    this.downloadCalls.push(filePath);
    return Buffer.from("test");
  }

  async setMyCommands(commands, languageCode = "") {
    this.commands.push({ commands, languageCode });
  }

  async setChatMenuButton() {
    this.menuButton = true;
  }
}

class FakeOpenCode {
  constructor() {
    this.url = "http://127.0.0.1:28894";
    this.projectList = [
      { id: "p1", canonical: "C:\\Projects\\Demo", time: { updated: 1 } },
    ];
    const session = {
      id: "ses_1",
      projectID: "p1",
      title: "Test session",
      model: {
        id: "deepseek/deepseek-v4.1-flash",
        providerID: "commandcode",
        variant: "max",
      },
      cost: 0.01,
      tokens: { input: 1000, output: 200 },
      time: { created: 1, updated: 2 },
      location: { directory: "C:\\Projects\\Demo" },
    };
    this.sessionsMap = new Map([["ses_1", session]]);
    this.messagesBySession = new Map([["ses_1", []]]);
    this.activeMap = {};
    this.formsBySession = new Map();
    this.permissionsBySession = new Map();
    this.modelList = [
      {
        id: "deepseek/deepseek-v4.1-flash",
        modelID: "deepseek/deepseek-v4.1-flash",
        providerID: "commandcode",
        name: "DeepSeek V4.1 Flash",
        type: "chat",
        enabled: true,
        status: "active",
        variants: [{ id: "low" }, { id: "max" }],
      },
      {
        id: "gpt-6-sol",
        modelID: "gpt-6-sol",
        providerID: "commandcode",
        name: "GPT-6 Sol",
        type: "chat",
        enabled: true,
        status: "active",
        variants: [],
      },
      {
        id: "deepseek-v4.1-flash",
        modelID: "deepseek-v4.1-flash",
        providerID: "opencode",
        name: "DeepSeek Free",
        type: "chat",
        enabled: true,
        status: "active",
        variants: [],
      },
    ];
    this.modelSwitches = [];
    this.promptCalls = [];
    this.formReplies = [];
    this.permissionReplies = [];
    this.created = [];
    this.nextSessionID = 1;
  }

  async info() {
    return { version: "2.3.2" };
  }

  async projects() {
    return this.projectList;
  }

  async models() {
    return this.modelList;
  }

  async switchModel(sessionID, model) {
    this.modelSwitches.push({ sessionID, model });
    const session = this.sessionsMap.get(sessionID);
    if (session) {
      session.model = {
        id: model.id,
        providerID: model.providerID,
        ...(model.variant ? { variant: model.variant } : {}),
      };
    }
  }

  async sessions(options = {}) {
    this.sessionOptions = options;
    let sessions = [...this.sessionsMap.values()];
    if (options.directory) {
      sessions = sessions.filter(
        (session) => session.location?.directory === options.directory,
      );
    }
    if (options.project) {
      sessions = sessions.filter(
        (session) => session.projectID === options.project,
      );
    }
    if (options.parentID === "null" || options.parentID === undefined) {
      sessions = sessions.filter((session) => !session.parentID);
    }
    return sessions.slice(0, options.limit ?? 10);
  }

  async session(id) {
    return this.sessionsMap.get(id) || null;
  }

  async activeSessions() {
    return this.activeMap;
  }

  async forms(sessionID) {
    return this.formsBySession.get(sessionID) || [];
  }

  async pendingPermissions(sessionID) {
    return this.permissionsBySession.get(sessionID) || [];
  }

  async messages(id, { type = "", limit = 6 } = {}) {
    let messages = this.messagesBySession.get(id) || [];
    if (type) messages = messages.filter((message) => message.type === type);
    return messages.slice(0, limit);
  }

  async createSession({ directory, title }) {
    const session = {
      id: `ses_new_${this.nextSessionID++}`,
      projectID: "p1",
      title,
      time: { created: 1, updated: 1 },
      location: { directory },
    };
    this.sessionsMap.set(session.id, session);
    this.messagesBySession.set(session.id, []);
    this.created.push({ directory, title, session });
    return session;
  }

  async prompt(sessionID, text, files = []) {
    this.promptCalls.push({
      sessionID,
      text,
      ...(files.length ? { files } : {}),
    });
  }

  async replyForm(sessionID, formID, answer) {
    this.formReplies.push({ sessionID, formID, answer });
  }

  async replyPermission(sessionID, requestID, decision) {
    this.permissionReplies.push({ sessionID, requestID, decision });
  }
}

function setup({ pin = "", language = "ru" } = {}) {
  const tg = new FakeTelegram();
  const oc = new FakeOpenCode();
  const auth = new AuthGate({
    ownerId: 1,
    pin,
    unlockMs: 60_000,
    now: () => 1_000_000,
  });
  const log = {
    errors: [],
    warnings: [],
    error(message) {
      this.errors.push(String(message));
    },
    warn(message) {
      this.warnings.push(String(message));
    },
    info() {},
    debug() {},
  };
  const config = {
    ownerId: 1,
    chatId: 1,
    pin,
    unlockMs: 60_000,
    projectAliases: { p1: "Demo" },
    notifySubagents: false,
    token: ["123456789", "A".repeat(35)].join(":"),
    opencodePassword: "",
    envFile: "C:\\Users\\TestUser\\.config\\opencode\\telegram.env",
    logLevel: "info",
  };
  const state = {};
  if (language) state.language = language;
  const bot = new Bot({ tg, oc, auth, config, state, log });
  return { bot, tg, oc, auth, log, state };
}

function ownerMessage(text, id = 1) {
  return {
    update_id: id,
    message: {
      message_id: id,
      from: { id: 1 },
      chat: { id: 1, type: "private" },
      text,
    },
  };
}

function ownerPhoto(caption = "", id = 1, mediaGroupID = null) {
  const message = {
    message_id: id,
    from: { id: 1 },
    chat: { id: 1, type: "private" },
    photo: [
      {
        file_id: `photo_${id}`,
        file_unique_id: `unique_${id}`,
        width: 10,
        height: 10,
        file_size: 4,
      },
    ],
  };
  if (caption) message.caption = caption;
  if (mediaGroupID) message.media_group_id = mediaGroupID;
  return { update_id: id, message };
}

function ownerCallback(data, id = "cb") {
  return {
    update_id: 99,
    callback_query: {
      id,
      from: { id: 1 },
      message: { message_id: 50, chat: { id: 1, type: "private" } },
      data,
    },
  };
}

test("start event reports project, session and the last user task", async () => {
  const { bot, tg, oc, log } = setup();
  oc.messagesBySession.set("ses_1", [{ type: "user", text: "Fix the gate" }]);

  await bot.handleEvent({
    type: "session.execution.started",
    data: { sessionID: "ses_1" },
  });

  assert.equal(log.errors.length, 0);
  assert.equal(tg.messages.length, 1);
  const message = tg.messages[0];
  assert.match(message.text, /Начали выполнять/);
  assert.match(message.text, /Проект: Demo/);
  assert.match(message.text, /Сессия: Test session/);
  assert.match(message.text, /Fix the gate/);
  assert.equal(
    message.options.keyboard.inline_keyboard[0][0].callback_data,
    "ses:ses_1",
  );
});

test("automatic resume shows the last agent update, not the original task", async () => {
  const { bot, tg, oc } = setup({ language: "ru" });
  oc.messagesBySession.set("ses_1", [
    { type: "idle" },
    {
      type: "assistant",
      content: [
        {
          type: "text",
          text: "Все артефакты подтверждены: gate 2476/2476, release passed.",
        },
      ],
    },
    {
      type: "synthetic",
      text: '<subagent sessionID="ses_child" state="completed">report</subagent>',
    },
    {
      type: "assistant",
      content: [{ type: "text", text: "Финальный прогон зелёный." }],
    },
    { type: "user", text: "Исходная задача, которую не нужно повторять" },
  ]);

  await bot.handleEvent({
    type: "session.execution.started",
    data: { sessionID: "ses_1" },
  });

  const message = tg.messages[0];
  assert.match(message.text, /Продолжаю выполнять задачу/);
  assert.match(message.text, /Последний текст/);
  assert.match(message.text, /Все артефакты подтверждены/);
  assert.doesNotMatch(message.text, /Исходная задача/);
  assert.doesNotMatch(message.text, /Начали выполнять/);
});

test("a new user prompt in an existing session is a new task start", async () => {
  const { bot, tg, oc } = setup({ language: "ru" });
  oc.messagesBySession.set("ses_1", [
    { type: "user", text: "Новая задача от пользователя" },
    {
      type: "assistant",
      content: [{ type: "text", text: "Предыдущий результат" }],
    },
    { type: "user", text: "Старая задача" },
  ]);

  await bot.handleEvent({
    type: "session.execution.started",
    data: { sessionID: "ses_1" },
  });

  const message = tg.messages[0];
  assert.match(message.text, /Начали выполнять/);
  assert.match(message.text, /Задача:\nНовая задача от пользователя/);
  assert.doesNotMatch(message.text, /Продолжаю выполнять задачу/);
  assert.doesNotMatch(message.text, /Старая задача/);
});

test("start notification follows the format and attaches the full text", async () => {
  const { bot, tg, oc } = setup({ language: "en" });
  bot.responseFormat = "html";
  oc.messagesBySession.set("ses_1", [
    { type: "user", text: "# Task\n\n**Do** `x`" },
  ]);

  await bot.handleEvent({
    type: "session.execution.started",
    data: { sessionID: "ses_1" },
  });

  const message = tg.messages.at(-1);
  assert.equal(message.options.parseMode, "HTML");
  assert.match(message.text, /<b>Task<\/b>/);
  assert.match(message.text, /<b>Do<\/b>/);
  assert.match(message.text, /<code>x<\/code>/);
  assert.equal(tg.documents.length, 1);
  assert.match(tg.documents[0].filename, /^Demo_Test session_/);
  assert.match(tg.documents[0].content, /# Task/);
});

test("start notification supports code and plain formats", async () => {
  const code = setup({ language: "en" });
  code.bot.responseFormat = "code";
  code.oc.messagesBySession.set("ses_1", [{ type: "user", text: "Task" }]);
  await code.bot.handleEvent({
    type: "session.execution.started",
    data: { sessionID: "ses_1" },
  });
  assert.equal(code.tg.messages.at(-1).options.parseMode, "HTML");
  assert.match(
    code.tg.messages.at(-1).text,
    /^<pre><code class="language-markdown">/,
  );

  const plain = setup({ language: "en" });
  plain.bot.responseFormat = "plain";
  plain.bot.attachFullResult = "never";
  plain.oc.messagesBySession.set("ses_1", [
    { type: "user", text: "**Task**" },
  ]);
  await plain.bot.handleEvent({
    type: "session.execution.started",
    data: { sessionID: "ses_1" },
  });
  assert.equal(plain.tg.messages.at(-1).options.parseMode, undefined);
  assert.match(plain.tg.messages.at(-1).text, /\*\*Task\*\*/);
  assert.equal(plain.tg.documents.length, 0);
});

test("auto attach adds a file when a notification is truncated", async () => {
  const short = setup({ language: "en" });
  short.bot.responseFormat = "plain";
  short.bot.attachFullResult = "auto";
  short.oc.messagesBySession.set("ses_1", [
    { type: "user", text: "Short task" },
  ]);
  await short.bot.handleEvent({
    type: "session.execution.started",
    data: { sessionID: "ses_1" },
  });
  assert.equal(short.tg.documents.length, 0);

  const { bot, tg, oc } = setup({ language: "en" });
  bot.responseFormat = "plain";
  bot.attachFullResult = "auto";
  oc.messagesBySession.set("ses_1", [
    { type: "user", text: "x".repeat(1500) },
  ]);

  await bot.handleEvent({
    type: "session.execution.started",
    data: { sessionID: "ses_1" },
  });

  assert.equal(tg.documents.length, 1);
  assert.match(tg.documents[0].content, /x{1500}/);
});

test("question notification follows the format and attaches the full question", async () => {
  const { bot, tg } = setup({ language: "en" });
  bot.responseFormat = "html";
  const form = {
    id: "frm_fmt",
    sessionID: "ses_1",
    title: "Questions",
    fields: [
      {
        key: "choice",
        type: "string",
        title: "Pick",
        description: "**Choose** one",
        required: true,
        options: [{ value: "a", label: "**A**" }],
      },
    ],
  };

  await bot.handleEvent({ type: "form.created", data: { form } });

  const message = tg.messages.at(-1);
  assert.equal(message.options.parseMode, "HTML");
  assert.match(message.text, /<b>Choose<\/b> one/);
  assert.match(message.text, /1\. <b>A<\/b>/);
  assert.equal(tg.documents.length, 1);
  assert.match(tg.documents[0].content, /\*\*Choose\*\* one/);
});

test("permission notification follows the format and attaches the full text", async () => {
  const { bot, tg } = setup({ language: "en" });
  bot.responseFormat = "html";

  await bot.handleEvent({
    type: "permission.asked",
    data: {
      id: "per_fmt",
      sessionID: "ses_1",
      action: "shell",
      resources: ["src/a_b.js"],
      message: "**Allow** this",
    },
  });

  const message = tg.messages.at(-1);
  assert.equal(message.options.parseMode, "HTML");
  assert.match(message.text, /<b>Allow<\/b> this/);
  assert.match(message.text, /src\/a_b\.js/);
  assert.equal(tg.documents.length, 1);
});

test("session card formats the last block without attaching a file", async () => {
  const { bot, tg, oc } = setup({ language: "en" });
  bot.responseFormat = "html";
  oc.messagesBySession.set("ses_1", [
    {
      type: "assistant",
      content: [{ type: "text", text: "**Done** last" }],
    },
    { type: "user", text: "Task" },
  ]);

  await bot.handleUpdate(ownerCallback("ses:ses_1"));

  const message = tg.messages.at(-1);
  assert.equal(message.options.parseMode, "HTML");
  assert.match(message.text, /<b>Done<\/b> last/);
  assert.equal(tg.documents.length, 0);
});

test("form closed notification follows the format and attaches", async () => {
  const { bot, tg } = setup({ language: "en" });
  bot.responseFormat = "code";
  const form = {
    id: "frm_closed",
    sessionID: "ses_1",
    title: "Questions",
    fields: [
      { key: "q", type: "boolean", title: "Q", required: true },
    ],
  };
  await bot.handleEvent({ type: "form.created", data: { form } });
  const before = tg.documents.length;

  await bot.handleEvent({
    type: "form.replied",
    data: { id: "frm_closed" },
  });

  const message = tg.messages.at(-1);
  assert.equal(message.options.parseMode, "HTML");
  assert.match(message.text, /^<pre><code/);
  assert.equal(tg.documents.length, before + 1);
});

test("subagent start/finish events are skipped by default", async () => {
  const { bot, tg, oc } = setup();
  const child = {
    id: "ses_child",
    parentID: "ses_1",
    projectID: "p1",
    title: "Child",
    time: { created: 1, updated: 1 },
    location: { directory: "C:\\Projects\\Demo" },
  };
  oc.sessionsMap.set("ses_child", child);
  oc.messagesBySession.set("ses_child", [{ type: "user", text: "Help" }]);

  await bot.handleEvent({
    type: "session.execution.started",
    data: { sessionID: "ses_child" },
  });
  await bot.handleEvent({
    type: "session.execution.succeeded",
    data: { sessionID: "ses_child" },
  });

  assert.equal(tg.messages.length, 0);
});

test("completion event sends the latest assistant text and stats", async () => {
  const { bot, tg, oc, log } = setup();
  oc.messagesBySession.set("ses_1", [
    {
      type: "assistant",
      content: [{ type: "text", text: "Done. Changed 3 files." }],
    },
    { type: "user", text: "Fix the gate" },
    {
      type: "assistant",
      content: [{ type: "text", text: "This older text must be ignored." }],
    },
  ]);

  await bot.handleEvent({
    type: "session.execution.succeeded",
    data: { sessionID: "ses_1" },
  });

  assert.equal(log.errors.length, 0);
  const message = tg.messages[0];
  assert.match(message.text, /Задача завершена/);
  assert.match(message.text, /Итог: succeeded/);
  assert.match(message.text, /Done\. Changed 3 files\./);
  assert.match(message.text, /1\.2k токенов/);
  assert.doesNotMatch(message.text, /older text/);
  assert.equal(message.options.parseMode, "HTML");
  assert.equal(tg.documents.length, 1);
  assert.match(tg.documents[0].filename, /\.md$/);
  assert.match(tg.documents[0].content, /Done\. Changed 3 files\./);
  assert.equal(tg.documents[0].options.replyTo, message.message_id);
});

test("completion continue button starts a prompt in the same session", async () => {
  const { bot, oc } = setup({ language: "en" });

  await bot.handleUpdate(ownerCallback("cont:ses_1", "cont-1"));
  assert.equal(bot.pending.kind, "prompt");
  assert.equal(bot.pending.sessionID, "ses_1");

  await bot.handleUpdate(ownerMessage("Add the second part"));
  assert.equal(oc.created.length, 0);
  assert.deepEqual(oc.promptCalls, [
    { sessionID: "ses_1", text: "Add the second part" },
  ]);
});

test("settings switch response format and full result attachment", async () => {
  const { bot, tg, state } = setup({ language: "en" });

  await bot.handleUpdate(ownerCallback("settings", "settings-1"));
  const text = tg.messages.at(-1).text;
  assert.match(text, /Response format: Formatted \(HTML\)/);
  assert.match(text, /Full result file: Always/);
  const data = tg.messages
    .at(-1)
    .options.keyboard.inline_keyboard.flat()
    .map((button) => button.callback_data);
  assert.ok(data.includes("format"));
  assert.ok(data.includes("attach"));

  await bot.handleUpdate(ownerCallback("fmt:code", "fmt-1"));
  assert.equal(bot.responseFormat, "code");
  assert.equal(state.responseFormat, "code");
  const formatButtons = tg.editTexts
    .at(-1)
    .options.keyboard.inline_keyboard.flat();
  assert.ok(
    formatButtons.some(
      (button) =>
        button.callback_data === "fmt:code" &&
        button.text.startsWith("✅"),
    ),
  );

  await bot.handleUpdate(ownerCallback("att:auto", "att-1"));
  assert.equal(bot.attachFullResult, "auto");
  assert.equal(state.attachFullResult, "auto");
});

test("plain format sends no HTML and never attaches when disabled", async () => {
  const { bot, tg, oc } = setup({ language: "en" });
  bot.responseFormat = "plain";
  bot.attachFullResult = "never";
  oc.messagesBySession.set("ses_1", [
    {
      type: "assistant",
      content: [{ type: "text", text: "**Done** in plain text." }],
    },
  ]);

  await bot.handleEvent({
    type: "session.execution.succeeded",
    data: { sessionID: "ses_1" },
  });

  const message = tg.messages.at(-1);
  assert.equal(message.options.parseMode, undefined);
  assert.match(message.text, /\*\*Done\*\* in plain text\./);
  assert.equal(tg.documents.length, 0);
});

test("auto attach adds the file only when the answer does not fit", async () => {
  const short = setup({ language: "en" });
  short.bot.attachFullResult = "auto";
  short.oc.messagesBySession.set("ses_1", [
    {
      type: "assistant",
      content: [{ type: "text", text: "Short answer." }],
    },
  ]);
  await short.bot.handleEvent({
    type: "session.execution.succeeded",
    data: { sessionID: "ses_1" },
  });
  assert.equal(short.tg.documents.length, 0);

  const long = setup({ language: "en" });
  long.bot.attachFullResult = "auto";
  long.oc.messagesBySession.set("ses_1", [
    {
      type: "assistant",
      content: [{ type: "text", text: "x".repeat(3800) }],
    },
  ]);
  await long.bot.handleEvent({
    type: "session.execution.succeeded",
    data: { sessionID: "ses_1" },
  });
  assert.equal(long.tg.documents.length, 1);
  assert.equal(long.tg.documents[0].content.includes("x".repeat(3800)), true);
});

test("failed completion attaches the error text", async () => {
  const { bot, tg, oc } = setup({ language: "en" });
  oc.messagesBySession.set("ses_1", [{ type: "user", text: "Task" }]);

  await bot.handleEvent({
    type: "session.execution.failed",
    data: { sessionID: "ses_1", error: "provider disconnected" },
  });

  assert.equal(tg.documents.length, 1);
  assert.match(tg.documents[0].content, /provider disconnected/);
});

test("completion waits for active subagents instead of reporting success", async () => {
  const { bot, tg, oc } = setup();
  oc.sessionsMap.set("ses_child", {
    id: "ses_child",
    parentID: "ses_1",
    projectID: "p1",
    title: "Child",
    time: { created: 1, updated: 1 },
    location: { directory: "C:\\Projects\\Demo" },
  });
  oc.activeMap = { ses_child: { type: "running" } };
  oc.messagesBySession.set("ses_1", [
    {
      type: "assistant",
      content: [{ type: "text", text: "Main step finished." }],
    },
    { type: "user", text: "Run subagents" },
  ]);

  await bot.handleEvent({
    type: "session.execution.succeeded",
    data: { sessionID: "ses_1" },
  });

  const message = tg.messages[0];
  assert.match(message.text, /Сессия ждёт субагентов/);
  assert.match(message.text, /Итог: waiting sub agents/);
  assert.doesNotMatch(message.text, /Задача завершена/);
});

test("session card shows waiting sub agents while a child is running", async () => {
  const { bot, tg, oc } = setup();
  oc.sessionsMap.set("ses_child", {
    id: "ses_child",
    parentID: "ses_1",
    projectID: "p1",
    title: "Child",
    time: { created: 1, updated: 1 },
    location: { directory: "C:\\Projects\\Demo" },
  });
  oc.activeMap = { ses_child: { type: "running" } };

  await bot.handleUpdate(ownerCallback("ses:ses_1"));

  const message = tg.messages.at(-1);
  assert.match(message.text, /Итог: ⏳ ожидает субагентов/);
});

test("completion with a trailing question offers a reply button", async () => {
  const { bot, tg, oc } = setup();
  oc.messagesBySession.set("ses_1", [
    {
      type: "assistant",
      content: [{ type: "text", text: "Which branch should I use?" }],
    },
    { type: "user", text: "Fix the gate" },
  ]);

  await bot.handleEvent({
    type: "session.execution.succeeded",
    data: { sessionID: "ses_1" },
  });

  const message = tg.messages[0];
  assert.match(message.text, /ждёт ответа/);
  const data = message.options.keyboard.inline_keyboard
    .flat()
    .map((button) => button.callback_data);
  assert.ok(data.includes("cont:ses_1"));
});

test("form option callback replies to the OpenCode form", async () => {
  const { bot, tg, oc, log } = setup();
  const form = {
    id: "frm_1",
    sessionID: "ses_1",
    title: "Choose color",
    fields: [
      {
        key: "color",
        type: "string",
        title: "Color",
        required: true,
        options: [
          {
            value: "red",
            label: "Red",
            description: "Use the red palette.",
          },
          {
            value: "blue",
            label: "Blue",
            description: "Use the blue palette.",
          },
        ],
        custom: true,
      },
    ],
  };

  await bot.handleEvent({ type: "form.created", data: { form } });
  assert.equal(log.errors.length, 0);
  assert.equal(tg.messages.length, 1);
  assert.match(tg.messages[0].text, /Появились вопросы/);
  assert.match(tg.messages[0].text, /Choose color/);
  assert.match(tg.messages[0].text, /1\. Red/);
  assert.match(tg.messages[0].text, /Use the red palette/);
  assert.match(tg.messages[0].text, /3\. Введите свой ответ/);

  const token = [...bot.forms.keys()][0];
  await bot.handleUpdate(
    ownerCallback(`q:${token}:0:o:1`),
  );

  assert.equal(log.errors.length, 0);
  assert.deepEqual(oc.formReplies, [
    { sessionID: "ses_1", formID: "frm_1", answer: { color: "blue" } },
  ]);
  assert.ok(tg.answers.some((answer) => answer.text === "Принято"));
  assert.match(tg.messages.at(-1).text, /Ответы отправлены/);
  assert.match(tg.messages.at(-1).text, /2\. Blue/);
  assert.equal(bot.forms.size, 0);
});

test("stale form buttons are rejected", async () => {
  const { bot, tg, oc } = setup();
  const form = {
    id: "frm_2",
    sessionID: "ses_1",
    title: "Choose",
    fields: [
      {
        key: "value",
        type: "boolean",
        title: "Enable?",
        required: true,
      },
    ],
  };
  await bot.handleEvent({ type: "form.created", data: { form } });
  const token = [...bot.forms.keys()][0];

  await bot.handleUpdate(ownerCallback(`q:${token}:9:b:1`, "stale"));
  assert.equal(oc.formReplies.length, 0);
  assert.ok(
    tg.answers.some((answer) => /Вопрос уже устарел/.test(answer.text)),
  );
});

test("text form field accepts a Telegram reply", async () => {
  const { bot, tg, oc, log } = setup();
  const form = {
    id: "frm_3",
    sessionID: "ses_1",
    title: "Name",
    fields: [{ key: "name", type: "string", title: "Name", required: true }],
  };
  await bot.handleEvent({ type: "form.created", data: { form } });

  assert.equal(bot.pending.kind, "formText");
  assert.equal(tg.messages[0].options.forceReply, "Ответ");

  await bot.handleUpdate(ownerMessage("Alice"));
  assert.equal(log.errors.length, 0);
  assert.deepEqual(oc.formReplies, [
    { sessionID: "ses_1", formID: "frm_3", answer: { name: "Alice" } },
  ]);
  assert.equal(bot.pending, null);
});

test("required text fields reject /skip", async () => {
  const { bot, tg, oc } = setup();
  const form = {
    id: "frm_4",
    sessionID: "ses_1",
    title: "Name",
    fields: [{ key: "name", type: "string", title: "Name", required: true }],
  };
  await bot.handleEvent({ type: "form.created", data: { form } });

  await bot.handleUpdate(ownerMessage("/skip"));
  assert.equal(oc.formReplies.length, 0);
  assert.equal(bot.pending.kind, "formText");
  assert.match(tg.messages.at(-1).text, /обязательное/);

  await bot.handleUpdate(ownerMessage("Alice"));
  assert.deepEqual(oc.formReplies, [
    { sessionID: "ses_1", formID: "frm_4", answer: { name: "Alice" } },
  ]);
});

test("slash text is accepted as a task when a task input is pending", async () => {
  const { bot, oc } = setup();
  await bot.handleUpdate(ownerCallback("new:p1"));
  await bot.handleUpdate(ownerMessage("/var/log/app.log"));

  assert.equal(oc.created.length, 1);
  assert.equal(oc.created[0].title, "/var/log/app.log");
});

test("project list deduplicates legacy projects with the same path", async () => {
  const { bot, tg, oc } = setup();
  oc.projectList = [
    { id: "p1", canonical: "C:\\Projects\\Demo", time: { updated: 2 } },
    { id: "p1-old", canonical: "C:\\Projects\\Demo", time: { updated: 1 } },
    { id: "p2", canonical: "C:\\Projects\\Other", time: { updated: 1 } },
  ];

  await bot.handleUpdate(ownerCallback("projects"));

  const data = tg.messages
    .at(-1)
    .options.keyboard.inline_keyboard.flat()
    .map((button) => button.callback_data)
    .filter((value) => value.startsWith("proj:"));
  assert.deepEqual(data.sort(), ["proj:p1", "proj:p2"]);
  assert.equal(tg.messages.at(-1).text.match(/C:\\Projects\\Demo/g)?.length, 1);
});

test("project sessions are read by directory and hide subagents", async () => {
  const { bot, tg, oc } = setup();
  bot.favoriteSessions.add("ses_1");
  bot.state.favoriteSessions = ["ses_1"];
  oc.sessionsMap.set("ses_child", {
    id: "ses_child",
    parentID: "ses_1",
    projectID: "p1",
    title: "Child hidden",
    time: { created: 1, updated: 1 },
    location: { directory: "C:\\Projects\\Demo" },
  });

  await bot.handleUpdate(ownerCallback("proj:p1"));

  assert.equal(oc.sessionOptions.directory, "C:\\Projects\\Demo");
  assert.equal(oc.sessionOptions.limit, 100);
  assert.match(tg.messages.at(-1).text, /Test session/);
  assert.doesNotMatch(tg.messages.at(-1).text, /Child hidden/);
  const data = tg.messages
    .at(-1)
    .options.keyboard.inline_keyboard.flat()
    .map((button) => button.callback_data);
  assert.ok(data.includes("ses:ses_1"));
  assert.equal(data.includes("ses:ses_child"), false);
});

test("project session list shows the latest status icon per session", async () => {
  const { bot, tg, oc } = setup();
  const base = {
    projectID: "p1",
    time: { created: 1, updated: 1 },
    location: { directory: "C:\\Projects\\Demo" },
  };
  oc.sessionsMap.set("ses_running", {
    ...base,
    id: "ses_running",
    title: "Running session",
  });
  oc.sessionsMap.set("ses_form", {
    ...base,
    id: "ses_form",
    title: "Form session",
  });
  oc.sessionsMap.set("ses_perm", {
    ...base,
    id: "ses_perm",
    title: "Permission session",
  });
  oc.sessionsMap.set("ses_failed", {
    ...base,
    id: "ses_failed",
    title: "Failed session",
    outcome: "failed",
  });
  oc.sessionsMap.set("ses_child", {
    ...base,
    id: "ses_child",
    parentID: "ses_1",
    title: "Active child",
  });
  oc.activeMap = {
    ses_running: { type: "running" },
    ses_child: { type: "running" },
  };
  oc.formsBySession.set("ses_form", [{ id: "frm_status" }]);
  oc.permissionsBySession.set("ses_perm", [{ id: "per_status" }]);

  await bot.handleUpdate(ownerCallback("allp:p1:0"));

  const text = tg.messages.at(-1).text;
  assert.match(text, /⏳ Test session/);
  assert.match(text, /🔄 Running session/);
  assert.match(text, /❓ Form session/);
  assert.match(text, /🔐 Permission session/);
  assert.match(text, /❌ Failed session/);

  const labels = tg.messages
    .at(-1)
    .options.keyboard.inline_keyboard.flat()
    .map((button) => button.text);
  assert.ok(labels.includes("⏳ Test session"));
  assert.ok(labels.includes("🔄 Running session"));
  assert.ok(labels.includes("❓ Form session"));
  assert.ok(labels.includes("🔐 Permission session"));
  assert.ok(labels.includes("❌ Failed session"));
});

test("new task callback creates a session and sends the prompt", async () => {
  const { bot, tg, oc, state } = setup();

  await bot.handleUpdate(ownerCallback("new:p1"));
  assert.equal(bot.pending.kind, "task");
  assert.equal(tg.messages.at(-1).options.forceReply, "Опишите задачу");

  await bot.handleUpdate(ownerMessage("Implement feature X"));
  assert.equal(oc.created.length, 1);
  assert.equal(oc.created[0].directory, "C:\\Projects\\Demo");
  assert.equal(oc.created[0].title, "Implement feature X");
  assert.deepEqual(oc.promptCalls, [
    { sessionID: oc.created[0].session.id, text: "Implement feature X" },
  ]);
  assert.equal(state.activeSessionID, oc.created[0].session.id);
  assert.match(tg.messages.at(-1).text, /Задача поставлена/);
});

test("start installs a persistent reply keyboard with bot actions", async () => {
  const { bot, tg } = setup({ language: "en" });
  await bot.handleUpdate(ownerMessage("/start"));

  const message = tg.messages.at(-1);
  assert.ok(message.options.replyKeyboard);
  const labels = message.options.replyKeyboard.keyboard
    .flat()
    .map((button) => button.text);
  assert.deepEqual(labels, [
    "📁 Projects",
    "🕘 Sessions",
    "➕ New task",
  ]);

  await bot.handleUpdate(ownerMessage("⚙️ Settings"));
  assert.match(tg.messages.at(-1).text, /Settings/);
});

test("/menu shows the three-button keyboard with a short service message", async () => {
  const { bot, tg } = setup({ language: "en" });

  await bot.handleUpdate(ownerMessage("/menu"));

  assert.equal(tg.messages.length, 1);
  const message = tg.messages[0];
  assert.equal(message.text, "⌨️");
  assert.deepEqual(
    message.options.replyKeyboard.keyboard
      .flat()
      .map((button) => button.text),
    ["📁 Projects", "🕘 Sessions", "➕ New task"],
  );
});

test("installs native command menus in English and Russian", async () => {
  const { bot, tg } = setup();
  await bot.installMenus();

  assert.equal(tg.commands.length, 3);
  assert.equal(tg.commands[0].languageCode, "en");
  assert.ok(
    tg.commands[0].commands.some(
      (command) => command.command === "settings",
    ),
  );
  assert.equal(tg.commands[1].languageCode, "ru");
  assert.ok(
    tg.commands[1].commands.some(
      (command) => command.description === "Настройки",
    ),
  );
  assert.equal(tg.commands[2].languageCode, "");
  assert.equal(tg.menuButton, true);
});

test("defaults to English and settings switch the bot to Russian", async () => {
  const { bot, tg, state } = setup({ language: null });
  assert.equal(bot.language, "en");

  await bot.handleUpdate(ownerCallback("settings"));
  assert.match(tg.messages.at(-1).text, /Settings/);
  assert.match(tg.messages.at(-1).text, /Language: English/);
  const buttons = tg.messages
    .at(-1)
    .options.keyboard.inline_keyboard.flat();
  assert.ok(buttons.some((button) => button.callback_data === "lang:en"));
  assert.ok(buttons.some((button) => button.callback_data === "lang:ru"));

  await bot.handleUpdate(ownerCallback("lang:ru", "lang-cb"));
  assert.equal(bot.language, "ru");
  assert.equal(state.language, "ru");
  assert.match(tg.messages.at(-1).text, /Настройки/);
  assert.match(tg.messages.at(-1).text, /Язык: Русский/);
  const reply = [...tg.messages]
    .reverse()
    .find((message) => message.options.replyKeyboard);
  assert.ok(reply);
  assert.deepEqual(
    reply.options.replyKeyboard.keyboard
      .flat()
      .map((button) => button.text),
    ["📁 Проекты", "🕘 Сессии", "➕ Новая задача"],
  );
});

test("selected session stays selected after a completion notification", async () => {
  const { bot, oc, tg } = setup({ language: "en" });
  await bot.handleUpdate(ownerCallback("ses:ses_1"));
  assert.equal(bot.activeSessionID, "ses_1");

  oc.messagesBySession.set("ses_1", [
    {
      type: "assistant",
      content: [{ type: "text", text: "Previous task finished." }],
    },
    { type: "user", text: "Previous task" },
  ]);
  await bot.handleEvent({
    type: "session.execution.succeeded",
    data: { sessionID: "ses_1" },
  });

  await bot.handleUpdate(ownerMessage("New task for the selected session"));

  assert.equal(oc.created.length, 0);
  assert.equal(oc.promptCalls.length, 1);
  assert.equal(oc.promptCalls[0].sessionID, "ses_1");
  assert.equal(
    oc.promptCalls[0].text,
    "New task for the selected session",
  );
  assert.equal(bot.activeSessionID, "ses_1");
  assert.ok(tg.messages.some((message) => /Task completed/.test(message.text)));
});

test("session model picker switches to a model without variants", async () => {
  const { bot, tg, oc } = setup({ language: "en" });
  await bot.handleUpdate(ownerCallback("model:ses_1"));

  assert.match(tg.editTexts.at(-1).text, /Choose a provider/);
  const provider = tg.editTexts
    .at(-1)
    .options.keyboard.inline_keyboard.flat()
    .find((button) => button.text.includes("commandcode"));
  assert.ok(provider);

  await bot.handleUpdate(ownerCallback(provider.callback_data, "provider"));
  assert.match(tg.editTexts.at(-1).text, /Choose a model \(commandcode\)/);
  const modelButton = tg.editTexts
    .at(-1)
    .options.keyboard.inline_keyboard.flat()
    .find((button) => button.text.includes("GPT-6 Sol"));
  assert.ok(modelButton);

  await bot.handleUpdate(ownerCallback(modelButton.callback_data, "model"));
  assert.deepEqual(oc.modelSwitches, [
    {
      sessionID: "ses_1",
      model: { id: "gpt-6-sol", providerID: "commandcode" },
    },
  ]);
  assert.match(
    tg.messages.at(-1).text,
    /Model: gpt-6-sol \(commandcode\)/,
  );
});

test("session model picker offers variants", async () => {
  const { bot, tg, oc } = setup({ language: "en" });
  await bot.handleUpdate(ownerCallback("model:ses_1"));
  const provider = tg.editTexts
    .at(-1)
    .options.keyboard.inline_keyboard.flat()
    .find((button) => button.text.includes("commandcode"));
  await bot.handleUpdate(ownerCallback(provider.callback_data, "provider2"));

  const modelButton = tg.editTexts
    .at(-1)
    .options.keyboard.inline_keyboard.flat()
    .find((button) => button.text.includes("DeepSeek V4.1 Flash"));
  assert.ok(modelButton);
  await bot.handleUpdate(ownerCallback(modelButton.callback_data, "model2"));

  assert.match(tg.editTexts.at(-1).text, /Choose a variant/);
  const variant = tg.editTexts
    .at(-1)
    .options.keyboard.inline_keyboard.flat()
    .find((button) => button.text === "low");
  assert.ok(variant);
  await bot.handleUpdate(ownerCallback(variant.callback_data, "variant"));

  assert.deepEqual(oc.modelSwitches, [
    {
      sessionID: "ses_1",
      model: {
        id: "deepseek/deepseek-v4.1-flash",
        providerID: "commandcode",
        variant: "low",
      },
    },
  ]);
});

test("notification settings toggle and suppress start messages", async () => {
  const { bot, tg, oc, state } = setup({ language: "en" });

  await bot.handleUpdate(ownerCallback("notifications"));
  assert.match(tg.editTexts.at(-1).text, /Notifications/);
  assert.match(tg.editTexts.at(-1).text, /Started working/);

  const before = tg.messages.length;
  await bot.handleUpdate(ownerCallback("notif:start", "notif-1"));
  assert.equal(bot.notifications.start, false);
  assert.equal(state.notifications.start, false);
  assert.match(tg.editTexts.at(-1).text, /⬜ Started working/);

  oc.messagesBySession.set("ses_1", [{ type: "user", text: "Task" }]);
  await bot.handleEvent({
    type: "session.execution.started",
    data: { sessionID: "ses_1" },
  });
  assert.equal(tg.messages.length, before);
});

test("continuation notifications have their own switch", async () => {
  const { bot, tg, oc } = setup({ language: "ru" });
  bot.notifications.continuation = false;
  bot.state.notifications = { ...bot.notifications };
  oc.messagesBySession.set("ses_1", [
    {
      type: "assistant",
      content: [{ type: "text", text: "Последний текст" }],
    },
    { type: "user", text: "Исходная задача" },
  ]);

  await bot.handleEvent({
    type: "session.execution.started",
    data: { sessionID: "ses_1" },
  });

  assert.equal(tg.messages.length, 0);
});

test("subagent-waiting notifications have their own switch", async () => {
  const { bot, tg, oc } = setup({ language: "en" });
  bot.notifications.subagents = false;
  bot.state.notifications = { ...bot.notifications };
  oc.sessionsMap.set("ses_child", {
    id: "ses_child",
    parentID: "ses_1",
    projectID: "p1",
    title: "Child",
    time: { created: 1, updated: 1 },
    location: { directory: "C:\\Projects\\Demo" },
  });
  oc.activeMap = { ses_child: { type: "running" } };
  oc.messagesBySession.set("ses_1", [
    {
      type: "assistant",
      content: [{ type: "text", text: "Main step finished." }],
    },
    { type: "user", text: "Task" },
  ]);

  await bot.handleEvent({
    type: "session.execution.succeeded",
    data: { sessionID: "ses_1" },
  });
  assert.equal(tg.messages.length, 0);

  oc.activeMap = {};
  bot.finishedAt.delete("ses_1");
  await bot.handleEvent({
    type: "session.execution.succeeded",
    data: { sessionID: "ses_1" },
  });

  assert.equal(tg.messages.length, 1);
  assert.match(tg.messages[0].text, /Task completed/);
  assert.match(tg.messages[0].text, /Outcome: succeeded/);
});

test("disabled question notifications remain as session status", async () => {
  const { bot, tg, oc } = setup({ language: "en" });
  bot.notifications.questions = false;
  bot.state.notifications = { ...bot.notifications };
  const form = {
    id: "frm_status",
    sessionID: "ses_1",
    title: "Questions",
    fields: [
      {
        key: "value",
        type: "boolean",
        title: "Enable?",
        required: true,
      },
    ],
  };
  oc.formsBySession.set("ses_1", [{ id: "frm_status" }]);

  await bot.handleEvent({ type: "form.created", data: { form } });

  assert.equal(tg.messages.length, 0);
  const status = await bot.sessionStatus(await oc.session("ses_1"));
  assert.equal(status.key, "waiting_answers");
  assert.equal(status.icon, "❓");
});

test("disabled completion notifications remain as session status", async () => {
  const { bot, tg, oc } = setup({ language: "en" });
  bot.notifications.completion = false;
  bot.state.notifications = { ...bot.notifications };
  oc.messagesBySession.set("ses_1", [
    {
      type: "assistant",
      content: [{ type: "text", text: "Done." }],
    },
    { type: "user", text: "Task" },
  ]);

  await bot.handleEvent({
    type: "session.execution.succeeded",
    data: { sessionID: "ses_1" },
  });

  assert.equal(tg.messages.length, 0);
  oc.sessionsMap.get("ses_1").outcome = "succeeded";
  const status = await bot.sessionStatus(await oc.session("ses_1"));
  assert.equal(status.key, "completed");
  assert.equal(status.icon, "✅");
});

test("favorites are shown first and all sessions are in a submenu", async () => {
  const { bot, tg, oc } = setup({ language: "en" });
  bot.favoriteSessions.add("ses_1");
  bot.state.favoriteSessions = ["ses_1"];
  oc.sessionsMap.set("ses_other", {
    id: "ses_other",
    projectID: "p1",
    title: "Other session",
    time: { created: 1, updated: 2 },
    location: { directory: "C:\\Projects\\Demo" },
  });

  await bot.handleUpdate(ownerCallback("sessions"));
  const favoriteText = tg.messages.at(-1).text;
  assert.match(favoriteText, /Favorite sessions/);
  assert.match(favoriteText, /Test session/);
  assert.doesNotMatch(favoriteText, /Other session/);

  const allButton = tg.messages
    .at(-1)
    .options.keyboard.inline_keyboard.flat()
    .find((button) => button.text.includes("All sessions"));
  assert.ok(allButton);
  await bot.handleUpdate(ownerCallback(allButton.callback_data, "all"));

  const allText = tg.messages.at(-1).text;
  assert.match(allText, /All sessions/);
  assert.match(allText, /Test session/);
  assert.match(allText, /Other session/);
  assert.match(allText, /⭐ Test session/);
});

test("favorite button toggles and persists the session", async () => {
  const { bot, tg, state } = setup({ language: "en" });
  await bot.handleUpdate(ownerCallback("ses:ses_1"));
  const addButton = tg.messages
    .at(-1)
    .options.keyboard.inline_keyboard.flat()
    .find((button) => button.callback_data === "fav:ses_1");
  assert.equal(addButton.text, "☆ Favorite");

  await bot.handleUpdate(ownerCallback("fav:ses_1", "fav-add"));
  assert.equal(bot.favoriteSessions.has("ses_1"), true);
  assert.deepEqual(state.favoriteSessions, ["ses_1"]);
  const removeButton = tg.messages
    .at(-1)
    .options.keyboard.inline_keyboard.flat()
    .find((button) => button.callback_data === "fav:ses_1");
  assert.equal(removeButton.text, "⭐ In favorites");

  await bot.handleUpdate(ownerCallback("fav:ses_1", "fav-remove"));
  assert.equal(bot.favoriteSessions.has("ses_1"), false);
  assert.deepEqual(state.favoriteSessions, []);
});

test("new task can include a Telegram image", async () => {
  const { bot, tg, oc } = setup({ language: "en" });
  await bot.handleUpdate(ownerCallback("new:p1"));
  await bot.handleUpdate(ownerPhoto("Inspect this", 42));

  assert.equal(oc.created.length, 1);
  assert.equal(oc.promptCalls[0].text, "Inspect this");
  const files = oc.promptCalls[0].files;
  assert.equal(files.length, 1);
  assert.match(files[0].uri, /^data:image\/jpeg;base64,/);
  assert.equal(files[0].name, "telegram-42.jpg");
  assert.equal(tg.getFileCalls[0], "photo_42");
  assert.match(tg.messages.at(-1).text, /Images: 1/);
});

test("continuing a session can include a Telegram image", async () => {
  const { bot, oc } = setup({ language: "en" });
  await bot.handleUpdate(ownerCallback("cont:ses_1"));
  await bot.handleUpdate(ownerPhoto("", 43));

  assert.equal(oc.promptCalls.length, 1);
  assert.equal(oc.promptCalls[0].sessionID, "ses_1");
  assert.equal(oc.promptCalls[0].text, "Analyze the attached image.");
  assert.equal(oc.promptCalls[0].files.length, 1);
});

test("image without an active task flow is rejected", async () => {
  const { bot, tg, oc } = setup({ language: "en" });
  await bot.handleUpdate(ownerPhoto("", 44));

  assert.equal(oc.promptCalls.length, 0);
  assert.match(tg.messages.at(-1).text, /Attach images/);
});

test("photo album is attached as multiple images to one task", async () => {
  const { bot, oc } = setup({ language: "en" });
  await bot.handleUpdate(ownerCallback("new:p1"));
  await bot.handleUpdate(ownerPhoto("Album", 51, "group-1"));
  await bot.handleUpdate(ownerPhoto("", 52, "group-1"));
  assert.equal(oc.created.length, 0);

  await bot.flushMediaGroup("group-1");
  assert.equal(oc.created.length, 1);
  assert.equal(oc.promptCalls[0].text, "Album");
  assert.equal(oc.promptCalls[0].files.length, 2);
});

test("unauthorized Telegram users are ignored", async () => {
  const { bot, tg } = setup();
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      from: { id: 2 },
      chat: { id: 2, type: "private" },
      text: "/start",
    },
  });
  assert.equal(tg.messages.length, 0);
  assert.equal(tg.answers.length, 0);
});

test("permission callback replies once and removes the keyboard", async () => {
  const { bot, tg, oc, log } = setup();
  await bot.handleEvent({
    type: "permission.asked",
    data: {
      id: "per_1",
      sessionID: "ses_1",
      action: "shell",
      resources: ["git status"],
    },
  });

  assert.equal(log.errors.length, 0);
  assert.match(tg.messages[0].text, /Требуется разрешение/);
  const callbackData =
    tg.messages[0].options.keyboard.inline_keyboard[0][0].callback_data;
  assert.match(callbackData, /^perm:p[0-9a-f]{8}:once$/);

  await bot.handleUpdate(ownerCallback(callbackData, "perm-cb"));

  assert.deepEqual(oc.permissionReplies, [
    { sessionID: "ses_1", requestID: "per_1", decision: "once" },
  ]);
  assert.equal(bot.permissions.size, 0);
  assert.equal(bot.permissionTokens.size, 0);
  assert.equal(tg.edits.length, 1);
});
