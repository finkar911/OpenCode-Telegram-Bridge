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

test("OpenCodeClient sums assistant usage since a timestamp", async () => {
  const calls = [];
  const client = new OpenCodeClient({
    url: "http://127.0.0.1:28894",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          data: [
            {
              type: "assistant",
              cost: 0.5,
              tokens: { input: 100, output: 10 },
              time: { created: 2000 },
            },
            {
              type: "assistant",
              cost: 0.3,
              tokens: { input: 50, output: 5 },
              time: { created: 1500 },
            },
            {
              type: "assistant",
              cost: 9,
              tokens: { input: 999, output: 99 },
              time: { created: 500 },
            },
          ],
        }),
        { status: 200 },
      );
    },
  });

  const usage = await client.sessionUsageSince(["ses_1"], 1000);

  assert.equal(usage.cost, 0.8);
  assert.deepEqual(usage.tokens, { input: 150, output: 15 });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/api/session/ses_1/message");
  assert.equal(url.searchParams.get("type"), "assistant");
  assert.equal(url.searchParams.get("order"), "desc");
  assert.equal(url.searchParams.get("limit"), "100");
});

test("OpenCodeClient reads the project default model", async () => {
  const calls = [];
  const client = new OpenCodeClient({
    url: "http://127.0.0.1:28894",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          data: { id: "m1", modelID: "m1", providerID: "p1" },
        }),
        { status: 200 },
      );
    },
  });

  const model = await client.defaultModel({ directory: "C:\\Projects\\Demo" });

  assert.equal(model.id, "m1");
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/api/model/default");
  assert.equal(
    url.searchParams.get("location[directory]"),
    "C:\\Projects\\Demo",
  );
});

test("OpenCodeClient reads the latest user message time", async () => {
  const calls = [];
  const client = new OpenCodeClient({
    url: "http://127.0.0.1:28894",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          data: [{ type: "user", time: { created: 123456 } }],
        }),
        { status: 200 },
      );
    },
  });

  const created = await client.latestUserTime("ses_1");

  assert.equal(created, 123456);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/api/session/ses_1/message");
  assert.equal(url.searchParams.get("type"), "user");
  assert.equal(url.searchParams.get("limit"), "1");
  assert.equal(url.searchParams.get("order"), "desc");
});

test("OpenCodeClient aggregates a session tree including subagents", async () => {
  const root = {
    id: "ses_root",
    cost: 1,
    tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 1000 } },
  };
  const child = {
    id: "ses_child",
    parentID: "ses_root",
    cost: 2,
    tokens: { input: 200, output: 20, reasoning: 10, cache: { read: 2000 } },
  };
  const grandchild = {
    id: "ses_grandchild",
    parentID: "ses_child",
    cost: 3,
    tokens: { input: 300, output: 30, reasoning: 15, cache: { read: 3000 } },
  };
  const client = new OpenCodeClient({
    url: "http://127.0.0.1:28894",
    fetchImpl: async (url) => {
      const parentID = new URL(url).searchParams.get("parentID");
      const data =
        parentID === "ses_root"
          ? [child]
          : parentID === "ses_child"
            ? [grandchild]
            : [];
      return new Response(JSON.stringify({ data }), { status: 200 });
    },
  });

  const tree = await client.sessionTree("ses_root", root);

  assert.equal(tree.cost, 6);
  assert.deepEqual(tree.tokens, {
    input: 600,
    output: 60,
    reasoning: 30,
    cache: { read: 6000, write: 0 },
  });
  assert.equal(tree.sessions, 3);
  assert.equal(tree.subagents, 2);
  assert.deepEqual(tree.activeIDs, ["ses_root", "ses_child", "ses_grandchild"]);
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
