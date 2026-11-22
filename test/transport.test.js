import test from "node:test";
import assert from "node:assert/strict";
import {
  basicAuth,
  discoverService,
  OpenCodeClient,
  OpenCodeError,
} from "../lib/opencode.js";
import {
  inlineKeyboard,
  TelegramClient,
} from "../lib/telegram.js";

test("basicAuth encodes the opencode user and password", () => {
  assert.equal(
    basicAuth("secret"),
    "Basic " + Buffer.from("opencode:secret").toString("base64"),
  );
  assert.equal(basicAuth(""), null);
});

test("discoverService prefers the explicit URL and trims slashes", () => {
  assert.deepEqual(
    discoverService({
      envUrl: "http://127.0.0.1:28894/",
      envPassword: "pw",
      stateFile: "Z:\\missing.json",
    }),
    { url: "http://127.0.0.1:28894", password: "pw" },
  );
});

test("OpenCodeClient sends the documented create-session payload", async () => {
  const calls = [];
  const client = new OpenCodeClient({
    url: "http://127.0.0.1:28894",
    password: "secret",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ data: { id: "ses_new", projectID: "p1" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const session = await client.createSession({
    directory: "C:\\Projects\\Demo",
    title: "Fix the gate",
  });
  assert.equal(session.id, "ses_new");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:28894/api/session");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(
    calls[0].init.headers.authorization,
    basicAuth("secret"),
  );
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    title: "Fix the gate",
    location: { directory: "C:\\Projects\\Demo" },
  });
});

test("OpenCodeClient lists root sessions by directory by default", async () => {
  const urls = [];
  const client = new OpenCodeClient({
    url: "http://127.0.0.1:28894",
    fetchImpl: async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    },
  });

  await client.sessions({ directory: "C:\\Projects\\Demo", limit: 5 });

  const url = new URL(urls[0]);
  assert.equal(url.pathname, "/api/session");
  assert.equal(url.searchParams.get("directory"), "C:\\Projects\\Demo");
  assert.equal(url.searchParams.get("parentID"), "null");
  assert.equal(url.searchParams.get("limit"), "5");
});

test("OpenCodeClient lists models and switches a session model", async () => {
  const calls = [];
  const client = new OpenCodeClient({
    url: "http://127.0.0.1:28894",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.includes("/api/model?")) {
        return new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
          status: 200,
        });
      }
      return new Response(null, { status: 204 });
    },
  });

  const models = await client.models({ directory: "C:\\Projects\\Demo" });
  assert.equal(models[0].id, "m1");
  const modelUrl = new URL(calls[0].url);
  assert.equal(modelUrl.pathname, "/api/model");
  assert.equal(
    modelUrl.searchParams.get("location[directory]"),
    "C:\\Projects\\Demo",
  );

  await client.switchModel("ses_1", {
    id: "m1",
    providerID: "p1",
    variant: "max",
  });
  assert.equal(
    calls[1].url,
    "http://127.0.0.1:28894/api/session/ses_1/model",
  );
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    model: { id: "m1", providerID: "p1", variant: "max" },
  });
});

test("OpenCodeClient prompt sends inline file attachments", async () => {
  const calls = [];
  const client = new OpenCodeClient({
    url: "http://127.0.0.1:28894",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    },
  });
  const files = [
    {
      uri: "data:image/png;base64,dGVzdA==",
      name: "photo.png",
      description: "Image attached from Telegram",
    },
  ];

  await client.prompt("ses_1", "Look at this", files);

  assert.equal(calls[0].url, "http://127.0.0.1:28894/api/session/ses_1/prompt");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    text: "Look at this",
    files,
  });
});

test("OpenCodeClient surfaces API errors with status", async () => {
  const client = new OpenCodeClient({
    url: "http://127.0.0.1:28894",
    fetchImpl: async () =>
      new Response(JSON.stringify({ message: "no such session" }), {
        status: 404,
      }),
  });
  await assert.rejects(
    () => client.session("ses_missing"),
    (error) =>
      error instanceof OpenCodeError &&
      error.status === 404 &&
      /no such session/.test(error.message),
  );
});

test("Telegram sendMessage posts the chat id, text and keyboard", async () => {
  const calls = [];
  const client = new TelegramClient({
    token: "123:abc",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 7 } }),
        { status: 200 },
      );
    },
  });
  const keyboard = inlineKeyboard([[{ text: "Go", data: "go" }]]);
  const result = await client.sendMessage(10, "hello", { keyboard });

  assert.deepEqual(result, { message_id: 7 });
  assert.match(calls[0].url, /\/bot123:abc\/sendMessage$/);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    chat_id: 10,
    text: "hello",
    disable_web_page_preview: true,
    reply_markup: keyboard,
  });
});

test("Telegram getFile and downloadFile use the Bot API file URL", async () => {
  const calls = [];
  const client = new TelegramClient({
    token: "123:abc",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.includes("/getFile")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { file_path: "photos/x.jpg", file_size: 4 },
          }),
          { status: 200 },
        );
      }
      return new Response(Buffer.from("test"), { status: 200 });
    },
  });

  const file = await client.getFile("photo_1");
  const data = await client.downloadFile(file.file_path);

  assert.equal(file.file_path, "photos/x.jpg");
  assert.equal(data.toString("utf8"), "test");
  assert.match(
    calls[1].url,
    /\/file\/bot123:abc\/photos\/x\.jpg$/,
  );
});

test("Telegram sendDocument posts a markdown file attachment", async () => {
  const calls = [];
  const client = new TelegramClient({
    token: "123:abc",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 9 } }),
        { status: 200 },
      );
    },
  });

  const result = await client.sendDocument(
    10,
    "answer.md",
    "# Answer",
    { caption: "full answer", replyTo: 5 },
  );

  assert.deepEqual(result, { message_id: 9 });
  assert.match(calls[0].url, /\/sendDocument$/);
  assert.ok(calls[0].init.body instanceof FormData);
  assert.equal(calls[0].init.body.get("chat_id"), "10");
  assert.equal(calls[0].init.body.get("caption"), "full answer");
  assert.equal(
    calls[0].init.body.get("reply_to_message_id"),
    "5",
  );
  const document = calls[0].init.body.get("document");
  assert.equal(document.type, "text/markdown");
  assert.equal(document.name, "answer.md");
});

test("Telegram sendMessage supports a persistent reply keyboard", async () => {
  const calls = [];
  const client = new TelegramClient({
    token: "123:abc",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 8 } }),
        { status: 200 },
      );
    },
  });
  const replyKeyboard = {
    keyboard: [[{ text: "📁 Projects" }]],
    resize_keyboard: true,
    is_persistent: true,
  };
  await client.sendMessage(10, "menu", { replyKeyboard });

  assert.deepEqual(JSON.parse(calls[0].init.body).reply_markup, replyKeyboard);
});

test("inlineKeyboard rejects callback data over 64 bytes", () => {
  assert.throws(
    () => inlineKeyboard([[{ text: "X", data: "x".repeat(65) }]]),
    /64 bytes/,
  );
});
