import crypto from "node:crypto";
import { splitMessage } from "./ui.js";

export class TelegramError extends Error {
  constructor(method, status, body) {
    super(`${method}: ${body?.description || "Telegram request failed"}`);
    this.name = "TelegramError";
    this.method = method;
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class TelegramClient {
  constructor({
    token,
    apiBase = "https://api.telegram.org",
    fetchImpl = globalThis.fetch,
  }) {
    this.token = token;
    this.apiBase = String(apiBase).replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  redact(value) {
    const text = String(value ?? "");
    return this.token ? text.split(this.token).join("<token>") : text;
  }

  async call(method, payload = {}, { signal, timeoutMs = 30000, retries = 1 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    let response;
    try {
      response = await this.fetchImpl(`${this.apiBase}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      const timeout = error.name === "AbortError";
      throw new TelegramError(method, 0, {
        description: this.redact(
          timeout ? `timeout after ${timeoutMs}ms` : error.message,
        ),
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        // fall through to the HTTP status
      }
    }

    if (!response.ok || !json?.ok) {
      const description = this.redact(json?.description || `HTTP ${response.status}`);
      if (response.status === 429 && retries > 0) {
        const retryAfter = Number(json?.parameters?.retry_after ?? 2);
        await sleep(Math.max(1, retryAfter) * 1000);
        return this.call(method, payload, { signal, timeoutMs, retries: retries - 1 });
      }
      throw new TelegramError(method, response.status, { description });
    }
    return json.result;
  }

  getMe(options = {}) {
    return this.call("getMe", {}, { ...options, timeoutMs: 15000 });
  }

  getFile(fileId, options = {}) {
    return this.call(
      "getFile",
      { file_id: fileId },
      { ...options, timeoutMs: 30000 },
    );
  }

  async downloadFile(filePath) {
    const url = `${this.apiBase}/file/bot${this.token}/${String(
      filePath,
    ).replace(/^\/+/, "")}`;
    let response;
    try {
      response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(60000),
      });
    } catch (error) {
      throw new TelegramError("downloadFile", 0, {
        description: this.redact(error.message),
      });
    }
    if (!response.ok) {
      throw new TelegramError("downloadFile", response.status, {
        description: `HTTP ${response.status}`,
      });
    }
    return Buffer.from(await response.arrayBuffer());
  }

  getUpdates({ offset = 0, timeout = 50, signal } = {}) {
    const payload = {
      timeout,
      allowed_updates: ["message", "callback_query"],
    };
    if (offset) payload.offset = offset;
    return this.call("getUpdates", payload, {
      signal,
      timeoutMs: (timeout + 15) * 1000,
    });
  }

  sendMessage(
    chatId,
    text,
    {
      keyboard,
      replyKeyboard,
      replyTo,
      forceReply,
      disableNotification,
      parseMode,
    } = {},
  ) {
    const payload = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    };
    if (disableNotification) payload.disable_notification = true;
    if (parseMode) payload.parse_mode = parseMode;
    if (replyTo) payload.reply_to_message_id = replyTo;
    if (forceReply) {
      payload.reply_markup = {
        force_reply: true,
        selective: true,
        input_field_placeholder: String(forceReply).slice(0, 64),
      };
    } else if (replyKeyboard) {
      payload.reply_markup = replyKeyboard;
    } else if (keyboard) {
      payload.reply_markup = keyboard;
    }
    return this.call("sendMessage", payload, { timeoutMs: 30000 });
  }

  async sendLong(chatId, text, options = {}) {
    const chunks = splitMessage(text, 3800);
    let last = null;
    for (let index = 0; index < chunks.length; index += 1) {
      const isLast = index === chunks.length - 1;
      last = await this.sendMessage(chatId, chunks[index], isLast ? options : {});
    }
    return last;
  }

  async sendDocument(
    chatId,
    filename,
    content,
    { caption = "", replyTo } = {},
  ) {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append(
      "document",
      new Blob([content], { type: "text/markdown" }),
      filename,
    );
    if (caption) form.append("caption", caption.slice(0, 1024));
    if (replyTo) form.append("reply_to_message_id", String(replyTo));

    let response;
    try {
      response = await this.fetchImpl(
        `${this.apiBase}/bot${this.token}/sendDocument`,
        {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(60000),
        },
      );
    } catch (error) {
      throw new TelegramError("sendDocument", 0, {
        description: this.redact(error.message),
      });
    }
    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        // fall through to HTTP status
      }
    }
    if (!response.ok || !json?.ok) {
      throw new TelegramError("sendDocument", response.status, {
        description: this.redact(
          json?.description || `HTTP ${response.status}`,
        ),
      });
    }
    return json.result;
  }

  editMessageReplyMarkup(chatId, messageId, keyboard) {
    return this.call("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: keyboard,
    });
  }

  editMessageText(chatId, messageId, text, { keyboard } = {}) {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  }

  answerCallbackQuery(callbackQueryId, text = "") {
    return this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text: text.slice(0, 200) } : {}),
    });
  }

  setMyCommands(commands, languageCode = "") {
    return this.call("setMyCommands", {
      commands,
      ...(languageCode ? { language_code: languageCode } : {}),
    });
  }

  setChatMenuButton() {
    return this.call("setChatMenuButton", {
      menu_button: { type: "commands" },
    });
  }
}

export function inlineKeyboard(rows) {
  const keyboard = [];
  for (const row of rows || []) {
    const buttons = [];
    for (const button of row) {
      if (!button?.text || !button?.data) continue;
      const data = String(button.data);
      if (Buffer.byteLength(data, "utf8") > 64) {
        throw new Error(`Telegram callback data is longer than 64 bytes: ${data}`);
      }
      buttons.push({ text: String(button.text).slice(0, 64), callback_data: data });
    }
    if (buttons.length) keyboard.push(buttons);
  }
  return { inline_keyboard: keyboard };
}

export function emptyKeyboard() {
  return { inline_keyboard: [] };
}

export function randomToken(prefix = "t") {
  return prefix + crypto.randomBytes(4).toString("hex");
}
