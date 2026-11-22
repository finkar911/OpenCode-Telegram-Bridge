import test from "node:test";
import assert from "node:assert/strict";
import {
  attachSettingsKeyboard,
  attachSettingsMessage,
  commandList,
  completionDocument,
  completionKeyboard,
  completionMessage,
  dedupeProjects,
  formatMarkdownForTelegram,
  formatNotificationText,
  formatAnswerValue,
  formatDuration,
  formatFieldAnswer,
  formatSettingsKeyboard,
  formatSettingsMessage,
  formatTokens,
  looksLikeQuestion,
  makeTitle,
  notificationDocument,
  notificationSettingsKeyboard,
  notificationSettingsMessage,
  permissionMessage,
  projectLabel,
  questionKeyboard,
  questionMessage,
  redact,
  replyKeyboard,
  sessionCard,
  sessionKeyboard,
  sessionsKeyboard,
  sessionsMessage,
  settingsKeyboard,
  settingsMessage,
  shouldShowField,
  splitMessage,
  startMessage,
  validateAnswer,
} from "../lib/ui.js";
import {
  normalizeLanguage,
  t,
  translationKeys,
} from "../lib/i18n.js";

test("i18n defaults to English and translates known keys", () => {
  assert.equal(normalizeLanguage(undefined), "en");
  assert.equal(normalizeLanguage("ru"), "ru");
  assert.match(t("en", "start.title"), /Started working/);
  assert.match(t("ru", "start.title"), /Начали выполнять/);
  assert.match(t("en", "settings.title"), /Settings/);
  assert.match(t("ru", "settings.title"), /Настройки/);
  assert.equal(t("en", "missing.key"), "missing.key");
  assert.deepEqual(
    translationKeys("ru").sort(),
    translationKeys("en").sort(),
  );
});

test("default UI messages are English", () => {
  const start = startMessage({
    project: "Demo",
    session: "Fix bugs",
    task: "Repair the gate",
  });
  assert.match(start, /Started working/);
  assert.match(start, /Task:\nRepair the gate/);

  const done = completionMessage({
    project: "Demo",
    session: "Fix bugs",
    summary: "Done.",
  });
  assert.match(done, /Task completed/);
  assert.match(done, /Outcome: succeeded/);
});

test("projectLabel prefers alias, then name, then path", () => {
  assert.equal(
    projectLabel(
      { id: "p1", canonical: "C:\\Work\\Game", name: "" },
      { p1: "My Project" },
    ),
    "My Project",
  );
  assert.equal(
    projectLabel({ id: "p2", canonical: "C:\\Work\\Other", name: "Other" }),
    "Other",
  );
  assert.equal(
    projectLabel({ id: "p3", canonical: "C:\\Work\\Third" }),
    "Third",
  );
  assert.equal(
    projectLabel(
      { id: "p4", canonical: "c:\\work\\demo" },
      { "C:\\Work\\Demo": "Demo alias" },
    ),
    "Demo alias",
  );
});

test("dedupeProjects keeps one project per canonical path", () => {
  const deduped = dedupeProjects([
    { id: "old", canonical: "C:\\Projects\\Demo", time: { updated: 1 } },
    { id: "new", canonical: "c:\\projects\\demo", time: { updated: 2 } },
    { id: "other", canonical: "C:\\Projects\\Other", time: { updated: 1 } },
  ]);
  assert.equal(deduped.length, 2);
  assert.equal(
    deduped.find((project) => project.canonical.toLowerCase() === "c:\\projects\\demo").id,
    "new",
  );
});

test("startMessage contains project, session and task", () => {
  const text = startMessage({
    project: "Demo",
    session: "Fix bugs",
    task: "Repair the gate",
    lang: "ru",
  });
  assert.match(text, /Начали выполнять/);
  assert.match(text, /Проект: Demo/);
  assert.match(text, /Сессия: Fix bugs/);
  assert.match(text, /Repair the gate/);
});

test("startMessage continuation shows the latest update", () => {
  const text = startMessage({
    project: "Demo",
    session: "Content",
    task: "Все артефакты подтверждены.",
    continuation: true,
    asUpdate: true,
    lang: "ru",
  });
  assert.match(text, /Продолжаю выполнять задачу/);
  assert.match(text, /Последний текст/);
  assert.match(text, /Все артефакты подтверждены/);
  assert.doesNotMatch(text, /Начали выполнять/);
  assert.doesNotMatch(text, /Задача:/);
});

test("markdown is converted to safe Telegram HTML", () => {
  const html = formatMarkdownForTelegram(
    "# Report\n\n**Done** with `code` and <script>.\n\n```js\nconst x = 1;\n```\n\n- item one",
    { lang: "en" },
  );
  assert.match(html, /<b>Report<\/b>/);
  assert.match(html, /<b>Done<\/b>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<pre><code class="language-js">/);
  assert.match(html, /• item one/);
  assert.doesNotMatch(html, /\*\*Done\*\*/);
});

test("completion document contains the full markdown answer", () => {
  const document = completionDocument({
    project: "Demo",
    session: {
      id: "ses_1",
      title: "Content",
      model: { id: "m", providerID: "p" },
    },
    summary: "# Full answer\n\nAll details.",
    outcome: "succeeded",
    lang: "en",
  });
  assert.match(
    document.filename,
    /^Demo_Content_\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.md$/,
  );
  assert.match(document.content, /^# Content/m);
  assert.match(document.content, /# Full answer/);
  assert.match(document.content, /All details/);
});

test("completion document filename is filesystem-safe", () => {
  const document = completionDocument({
    project: "My:Project",
    session: { id: "ses_2", title: "Fix/bugs?" },
    summary: "Done.",
    outcome: "succeeded",
    lang: "en",
  });
  assert.match(
    document.filename,
    /^My-Project_Fix-bugs_\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.md$/,
  );
});

test("completionMessage supports html, code and plain formats", () => {
  const base = {
    project: "Demo",
    session: "Content",
    summary: "**Done** with `code`.",
    durationMs: 1000,
    lang: "en",
  };
  const html = completionMessage({ ...base, format: "html" });
  assert.match(html, /<b>Done<\/b>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /Full answer is attached/);

  const noFile = completionMessage({
    ...base,
    format: "html",
    attached: false,
  });
  assert.doesNotMatch(noFile, /Full answer is attached/);

  const code = completionMessage({ ...base, format: "code" });
  assert.match(code, /^<pre><code class="language-markdown">/);
  assert.match(code, /\*\*Done\*\* with `code`\./);
  assert.match(code, /<\/code><\/pre>$/);
  assert.doesNotMatch(code, /<b>Done<\/b>/);

  const plain = completionMessage({ ...base, format: "plain" });
  assert.doesNotMatch(plain, /<[a-z/]/i);
  assert.match(plain, /\*\*Done\*\* with `code`\./);
});

test("completion keyboard offers open and continue for the same session", () => {
  const keyboard = completionKeyboard(
    { id: "ses_1", title: "Content" },
    "p1",
    false,
    "ru",
  );
  const buttons = keyboard.inline_keyboard.flat();
  assert.ok(buttons.some((button) => button.callback_data === "ses:ses_1"));
  assert.ok(buttons.some((button) => button.callback_data === "cont:ses_1"));
  assert.ok(buttons.some((button) => /Продолжить/.test(button.text)));
  assert.ok(
    buttons.every((button) => !String(button.callback_data).startsWith("new:")),
  );

  const question = completionKeyboard(
    { id: "ses_1", title: "Content" },
    "p1",
    true,
    "ru",
  ).inline_keyboard.flat();
  assert.ok(question.some((button) => /Ответить/.test(button.text)));
  assert.equal(
    new Set(question.map((button) => button.callback_data)).size,
    question.length,
  );
});

test("settings expose response format and full result attachment", () => {
  const text = settingsMessage(
    "ru",
    {},
    "code",
    "auto",
  );
  assert.match(text, /Формат ответа: Блок MD-кода/);
  assert.match(text, /Файл полного ответа: Только если не помещается/);

  const formatData = formatSettingsKeyboard("ru", "code")
    .inline_keyboard.flat()
    .map((button) => button.callback_data);
  assert.ok(formatData.includes("fmt:html"));
  assert.ok(formatData.includes("fmt:code"));
  assert.ok(formatData.includes("fmt:plain"));
  assert.ok(formatData.includes("settings"));

  const attachData = attachSettingsKeyboard("ru", "never")
    .inline_keyboard.flat()
    .map((button) => button.callback_data);
  assert.ok(attachData.includes("att:always"));
  assert.ok(attachData.includes("att:auto"));
  assert.ok(attachData.includes("att:never"));
  assert.ok(attachData.includes("settings"));

  assert.match(formatSettingsMessage("ru"), /Выберите формат/);
  assert.match(attachSettingsMessage("ru"), /Прикреплять полный ответ/);
});

test("completionMessage shows summary and stats, and flags a question", () => {
  const text = completionMessage({
    project: "Demo",
    session: "Fix bugs",
    summary: "Changed 3 files. Which branch should I use?",
    durationMs: 125_000,
    cost: 0.0123,
    tokens: { input: 1200, output: 300 },
    maybeQuestion: true,
    lang: "ru",
  });
  assert.match(text, /Задача завершена/);
  assert.match(text, /Changed 3 files/);
  assert.match(text, /2 мин 5 с/);
  assert.match(text, /\$0\.0123/);
  assert.match(text, /1\.5k токенов/);
  assert.match(text, /ждёт ответа/);
});

test("completion waits for subagents before reporting success", () => {
  const text = completionMessage({
    project: "Demo",
    session: "Content",
    summary: "Main step finished.",
    waitingForSubagents: 2,
    lang: "ru",
  });
  assert.match(text, /Сессия ждёт субагентов/);
  assert.match(text, /Итог: waiting sub agents \(2\)/);
  assert.doesNotMatch(text, /Задача завершена/);
});

test("session card reports waiting subagents", () => {
  const text = sessionCard({
    project: "Demo",
    session: { id: "ses_1", title: "Content", outcome: "succeeded" },
    waitingChildren: 1,
    lang: "ru",
  });
  assert.match(text, /Итог: waiting sub agents/);

  const running = sessionCard({
    project: "Demo",
    session: { id: "ses_1", title: "Content", outcome: "succeeded" },
    active: true,
    waitingChildren: 1,
    lang: "ru",
  });
  assert.match(running, /Итог: running · субагенты: 1/);

  const completed = sessionCard({
    project: "Demo",
    session: { id: "ses_1", title: "Content", outcome: "succeeded" },
    status: { icon: "✅", label: "completed" },
    lang: "en",
  });
  assert.match(completed, /Outcome: ✅ completed/);
});

test("start notification formats the task for HTML and code", () => {
  const html = startMessage({
    project: "Demo",
    session: "Content",
    task: "# Plan\n\n**Do** `x`",
    lang: "en",
    format: "html",
  });
  assert.match(html, /<b>Plan<\/b>/);
  assert.match(html, /<b>Do<\/b>/);
  assert.match(html, /<code>x<\/code>/);
  assert.doesNotMatch(html, /\*\*Do\*\*/);

  const code = startMessage({
    project: "Demo",
    session: "Content",
    task: "# Plan",
    lang: "en",
    format: "code",
  });
  assert.match(code, /^<pre><code class="language-markdown">/);
  assert.match(code, /Task:\n# Plan/);

  const plain = startMessage({
    project: "Demo",
    session: "Content",
    task: "# Plan",
    lang: "en",
  });
  assert.match(plain, /Task:\n# Plan/);
});

test("session card formats only the last block", () => {
  const session = {
    id: "ses_1",
    title: "Content",
    model: { id: "m", providerID: "p" },
    time: { updated: 1 },
  };
  const html = sessionCard({
    project: "Demo",
    session,
    lastText: "**Done** with `code`",
    lang: "en",
    format: "html",
  });
  assert.match(html, /ID: ses_1/);
  assert.doesNotMatch(html, /<i>ses/);
  assert.match(html, /<b>Done<\/b>/);
  assert.match(html, /<code>code<\/code>/);

  const code = sessionCard({
    project: "Demo",
    session,
    lastText: "**Done**",
    lang: "en",
    format: "code",
  });
  assert.match(code, /^<pre><code class="language-markdown">/);
  assert.match(code, /Last:\n\*\*Done\*\*/);
});

test("question notification formats dynamic text and footer", () => {
  const text = questionMessage({
    project: "Demo",
    session: "Content",
    form: { title: "Questions" },
    field: {
      key: "color",
      title: "**Color**",
      description: "Pick **one**",
      type: "string",
      options: [
        { value: "red", label: "**Red**", description: "warm" },
      ],
    },
    index: 0,
    total: 1,
    lang: "en",
    format: "html",
    footer: "\n\nReply to this message.",
  });
  assert.match(text, /Question: <b>Color<\/b>/);
  assert.match(text, /<b>Color<\/b>/);
  assert.match(text, /Pick <b>one<\/b>/);
  assert.match(text, /1\. <b>Red<\/b>/);
  assert.match(text, /Reply to this message\./);
});

test("permission notification escapes paths and formats the message", () => {
  const text = permissionMessage({
    project: "Demo",
    session: "Content",
    request: {
      action: "bash",
      resources: ["src/a_b.js"],
      message: "**Allow** this",
    },
    lang: "en",
    format: "html",
  });
  assert.match(text, /• src\/a_b\.js/);
  assert.doesNotMatch(text, /<i>a/);
  assert.match(text, /<b>Allow<\/b> this/);

  const code = permissionMessage({
    project: "Demo",
    session: "Content",
    request: { action: "bash", resources: ["a"] },
    lang: "en",
    format: "code",
  });
  assert.match(code, /^<pre><code class="language-markdown">/);
});

test("notification document uses the completion filename shape", () => {
  const document = notificationDocument({
    project: "Demo",
    session: "Content",
    title: "Started working",
    body: "Full notification body.",
  });
  assert.match(
    document.filename,
    /^Demo_Content_\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.md$/,
  );
  assert.match(document.content, /^# Started working/m);
  assert.match(document.content, /Full notification body\./);
});

test("formatNotificationText supports html, code and plain", () => {
  assert.match(
    formatNotificationText("**Done**", { format: "html" }),
    /<b>Done<\/b>/,
  );
  assert.match(
    formatNotificationText("**Done**", { format: "code" }),
    /^<pre><code class="language-markdown">\*\*Done\*\*<\/code><\/pre>$/,
  );
  assert.equal(
    formatNotificationText("**Done**", { format: "plain" }),
    "**Done**",
  );
});

test("failed completion shows the error", () => {
  const text = completionMessage({
    project: "Demo",
    session: "Fix bugs",
    outcome: "failed",
    error: "provider disconnected",
    lang: "ru",
  });
  assert.match(text, /ошибкой/);
  assert.match(text, /provider disconnected/);
});

test("looksLikeQuestion only accepts a trailing question mark", () => {
  assert.equal(looksLikeQuestion("Which file?"), true);
  assert.equal(looksLikeQuestion("Which file?  "), true);
  assert.equal(looksLikeQuestion("Which file?`"), true);
  assert.equal(looksLikeQuestion("Done. Changed 3 files."), false);
  assert.equal(looksLikeQuestion(""), false);
});

test("makeTitle uses the first non-empty line", () => {
  assert.equal(makeTitle("\n# Fix the gate\nDetails"), "Fix the gate");
  assert.equal(makeTitle("", "ru"), "Задача из Telegram");
});

test("validateAnswer handles strings, numbers, booleans and multiselect", () => {
  assert.deepEqual(validateAnswer({ type: "string", required: true }, " ok "), {
    ok: true,
    value: "ok",
  });
  assert.equal(
    validateAnswer(
      {
        type: "string",
        options: [{ value: "a", label: "A" }],
        required: true,
      },
      "b",
    ).ok,
    false,
  );
  assert.equal(
    validateAnswer(
      {
        type: "string",
        options: [{ value: "a", label: "A" }],
        required: true,
      },
      "b",
      { allowFreeText: true },
    ).ok,
    true,
  );
  assert.deepEqual(validateAnswer({ type: "integer", minimum: 1 }, "3"), {
    ok: true,
    value: 3,
  });
  assert.equal(
    validateAnswer({ type: "integer", minimum: 1 }, "1.5").ok,
    false,
  );
  assert.deepEqual(validateAnswer({ type: "boolean" }, "да"), {
    ok: true,
    value: true,
  });
  assert.deepEqual(
    validateAnswer(
      { type: "multiselect", minItems: 1, options: [] },
      ["a", "b"],
    ),
    { ok: true, value: ["a", "b"] },
  );
  assert.equal(
    validateAnswer({ type: "multiselect", minItems: 1 }, []).ok,
    false,
  );
});

test("shouldShowField evaluates when conditions", () => {
  const field = {
    key: "b",
    when: [{ key: "a", op: "eq", value: "yes" }],
  };
  assert.equal(shouldShowField(field, { a: "yes" }), true);
  assert.equal(shouldShowField(field, { a: "no" }), false);
  assert.equal(shouldShowField({ key: "hidden", hidden: true }, {}), false);
});

test("questionMessage lists options with context and custom answer", () => {
  const text = questionMessage({
    project: "Demo",
    session: "Content",
    form: { title: "Questions" },
    field: {
      key: "process",
      type: "string",
      title: "Telegram writer",
      description: "Что делаем с процессом Telegram-моста?",
      options: [
        {
          value: "stop",
          label: "Остановлю процесс сам (Recommended)",
          description: "Вы останавливаете PID 28860 и запускаете финальный gate.",
        },
        {
          value: "you",
          label: "Можно остановить тебе",
          description: "Разрешаете integrator остановить процесс.",
        },
      ],
      custom: true,
    },
    index: 0,
    total: 1,
    lang: "ru",
  });

  assert.match(text, /1\. Остановлю процесс сам/);
  assert.match(text, /Вы останавливаете PID 28860/);
  assert.match(text, /2\. Можно остановить тебе/);
  assert.match(text, /3\. Введите свой ответ/);
});

test("questionKeyboard numbers options and the custom answer", () => {
  const keyboard = questionKeyboard(
    "f1",
    {
      key: "color",
      type: "string",
      required: true,
      options: [
        { value: "red", label: "Red" },
        { value: "blue", label: "Blue" },
      ],
      custom: true,
    },
    [],
    3,
    "ru",
  );
  const buttons = keyboard.inline_keyboard.flat();
  const data = buttons.map((button) => button.callback_data);
  assert.deepEqual(data, ["q:f1:3:o:0", "q:f1:3:o:1", "q:f1:3:x"]);
  assert.deepEqual(
    buttons.map((button) => button.text),
    ["1. Red", "2. Blue", "3. ✍️ Ввести свой ответ"],
  );
  for (const item of data) {
    assert.ok(Buffer.byteLength(item, "utf8") <= 64);
  }
});

test("formatFieldAnswer keeps option numbers and labels", () => {
  const field = {
    options: [
      { value: "red", label: "Red" },
      { value: "blue", label: "Blue" },
    ],
  };
  assert.equal(formatFieldAnswer(field, "blue", "ru"), "2. Blue");
  assert.equal(
    formatFieldAnswer(field, ["red", "blue"], "ru"),
    "1. Red, 2. Blue",
  );
  assert.equal(formatFieldAnswer(field, "custom text", "ru"), "custom text");
  assert.equal(formatFieldAnswer({}, true, "ru"), "Да");
  assert.equal(formatFieldAnswer({}, true, "en"), "Yes");
});

test("reply keyboard is one row with the three main actions", () => {
  const en = replyKeyboard("en");
  const enLabels = en.keyboard.flat().map((button) => button.text);
  assert.deepEqual(enLabels, [
    "📁 Projects",
    "🕘 Sessions",
    "➕ New task",
  ]);
  assert.equal(en.keyboard.length, 1);
  assert.equal(en.resize_keyboard, true);
  assert.equal(en.is_persistent, true);

  const ru = replyKeyboard("ru");
  const ruLabels = ru.keyboard.flat().map((button) => button.text);
  assert.deepEqual(ruLabels, [
    "📁 Проекты",
    "🕘 Сессии",
    "➕ Новая задача",
  ]);
});

test("notification settings show and toggle all six types", () => {
  const notifications = {
    start: false,
    continuation: true,
    subagents: false,
    questions: true,
    permissions: true,
    completion: false,
  };
  const text = notificationSettingsMessage("en", notifications);
  assert.match(text, /⬜ Started working/);
  assert.match(text, /✅ Continuing the task/);
  assert.match(text, /⬜ Waiting for subagents/);
  assert.match(text, /✅ Questions/);
  assert.match(text, /✅ Permissions/);
  assert.match(text, /⬜ Completion/);
  assert.match(text, /remain visible as session statuses/);

  const keyboard = notificationSettingsKeyboard("en", notifications);
  const data = keyboard.inline_keyboard
    .flat()
    .map((button) => button.callback_data);
  for (const type of [
    "start",
    "continuation",
    "subagents",
    "questions",
    "permissions",
    "completion",
  ]) {
    assert.ok(data.includes(`notif:${type}`));
  }
  assert.ok(data.includes("notif:all"));
  assert.ok(data.includes("notif:none"));
  assert.ok(data.includes("settings"));
});

test("native command list includes implemented commands", () => {
  const commands = commandList("en");
  const names = commands.map((command) => command.command);
  for (const name of [
    "menu",
    "start",
    "projects",
    "sessions",
    "new",
    "status",
    "settings",
    "help",
    "id",
    "cancel",
    "lock",
    "unlock",
  ]) {
    assert.ok(names.includes(name));
  }
  assert.equal(names[0], "menu");
  assert.equal(names.at(-1), "start");
  assert.equal(
    commands.find((command) => command.command === "settings").description,
    "Settings",
  );
  assert.equal(
    commandList("ru").find((command) => command.command === "settings")
      .description,
    "Настройки",
  );
});

test("session list shows status icons and a legend", () => {
  const sessions = [
    { id: "a", title: "Done", status: { icon: "✅" } },
    { id: "b", title: "Waiting", status: { icon: "⏳" } },
  ];
  const text = sessionsMessage({
    project: "Demo",
    sessions,
    lang: "en",
  });
  assert.match(text, /✅ Done/);
  assert.match(text, /⏳ Waiting/);
  assert.match(text, /✅ completed/);
  assert.match(text, /⏳ subagents/);

  const keyboard = sessionsKeyboard({
    sessions,
    projectID: "p1",
    lang: "en",
  });
  const labels = keyboard.inline_keyboard
    .flat()
    .map((button) => button.text);
  assert.equal(labels[0], "✅ Done");
  assert.equal(labels[1], "⏳ Waiting");
});

test("sessionKeyboard routes to the session and its project", () => {
  const keyboard = sessionKeyboard(
    { id: "ses_1", projectID: "p1" },
    "p1",
  );
  const data = keyboard.inline_keyboard.flat().map((button) => button.callback_data);
  assert.ok(data.includes("cont:ses_1"));
  assert.ok(data.includes("new:p1"));
  assert.ok(data.includes("refresh:ses_1"));
});

test("redact removes configured secrets and token-like strings", () => {
  const token = ["123456789", "A".repeat(35)].join(":");
  const key = "sk-" + "a".repeat(32);
  const text = `token=${token} key=${key}`;
  const clean = redact(text, [token]);
  assert.equal(clean.includes(token), false);
  assert.equal(clean.includes(key), false);
  assert.match(clean, /token=\*\*\*/);
});

test("splitMessage keeps chunks below the limit", () => {
  const text = Array.from({ length: 200 }, (_, index) => `line ${index}`).join(
    "\n",
  );
  const chunks = splitMessage(text, 100);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 100);
  assert.equal(chunks.join("\n"), text);
});

test("format helpers are stable", () => {
  assert.equal(formatDuration(65_000, "ru"), "1 мин 5 с");
  assert.equal(formatDuration(3_725_000, "ru"), "1 ч 2 мин");
  assert.equal(formatDuration(65_000, "en"), "1 min 5 s");
  assert.equal(formatTokens(1200), "1.2k");
  assert.equal(formatTokens(2_500_000), "2.5M");
  assert.equal(formatAnswerValue(["a", "b"], "ru"), "a, b");
  assert.equal(formatAnswerValue(true, "ru"), "Да");
  assert.equal(formatAnswerValue(true, "en"), "Yes");
});
