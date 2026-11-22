import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class OpenCodeError extends Error {
  constructor(message, status = 0, body = null) {
    super(message);
    this.name = "OpenCodeError";
    this.status = status;
    this.body = body;
  }
}

export function basicAuth(password) {
  if (!password) return null;
  return "Basic " + Buffer.from("opencode:" + password, "utf8").toString("base64");
}

export function discoverService({ stateFile, envUrl, envPassword } = {}) {
  if (envUrl) {
    return { url: String(envUrl).replace(/\/+$/, ""), password: envPassword || "" };
  }
  let state;
  try {
    state = JSON.parse(
      fs.readFileSync(stateFile, "utf8").replace(/^\uFEFF/, ""),
    );
  } catch (error) {
    throw new OpenCodeError(
      `OpenCode service is not running (cannot read ${stateFile}): ${error.message}`,
    );
  }
  if (!state?.url) {
    throw new OpenCodeError(`${stateFile} has no OpenCode service URL`);
  }
  return {
    url: String(state.url).replace(/\/+$/, ""),
    password: state.password || envPassword || "",
  };
}

export class OpenCodeClient {
  constructor({
    url = "",
    password = "",
    stateFile = "",
    fetchImpl = globalThis.fetch,
    timeoutMs = 20000,
  } = {}) {
    this.explicitUrl = Boolean(url);
    this.url = url ? String(url).replace(/\/+$/, "") : "";
    this.password = password || "";
    this.stateFile = stateFile;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  refresh() {
    if (this.explicitUrl) return;
    const service = discoverService({ stateFile: this.stateFile });
    this.url = service.url;
    this.password = service.password;
  }

  headers() {
    const headers = { accept: "application/json" };
    const auth = basicAuth(this.password);
    if (auth) headers.authorization = auth;
    return headers;
  }

  async request(method, path, { body, retry = true } = {}) {
    if (!this.url) this.refresh();
    const headers = this.headers();
    const init = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await this.fetchImpl(this.url + path, init);
    } catch (error) {
      if (retry && !this.explicitUrl && method === "GET") {
        try {
          this.refresh();
          return await this.request(method, path, { body, retry: false });
        } catch {
          // fall through to the original connection error
        }
      }
      throw new OpenCodeError(
        `OpenCode request failed: ${error.message}`,
        0,
        null,
      );
    }

    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        // keep null; the status and raw text are enough for the error
      }
    }

    if (!response.ok) {
      if (response.status === 401 && retry && !this.explicitUrl) {
        try {
          this.refresh();
          return await this.request(method, path, { body, retry: false });
        } catch {
          // fall through to the original 401
        }
      }
      throw new OpenCodeError(
        json?.message || json?._tag || `OpenCode HTTP ${response.status}`,
        response.status,
        json ?? text,
      );
    }
    return json;
  }

  async info() {
    return this.request("GET", "/api/info");
  }

  async projects() {
    const result = await this.request("GET", "/api/project");
    return Array.isArray(result) ? result : [];
  }

  async models({ directory = "" } = {}) {
    const query = new URLSearchParams();
    if (directory) query.set("location[directory]", directory);
    const suffix = query.toString();
    const result = await this.request(
      "GET",
      "/api/model" + (suffix ? `?${suffix}` : ""),
    );
    return result?.data || [];
  }

  async defaultModel({ directory = "" } = {}) {
    const query = new URLSearchParams();
    if (directory) query.set("location[directory]", directory);
    const suffix = query.toString();
    const result = await this.request(
      "GET",
      "/api/model/default" + (suffix ? `?${suffix}` : ""),
    );
    return result?.data || null;
  }

  async switchModel(sessionID, model) {
    return this.request(
      "POST",
      `/api/session/${encodeURIComponent(sessionID)}/model`,
      { body: { model } },
    );
  }

  async sessions({
    project = "",
    directory = "",
    limit = 10,
    parentID = "null",
  } = {}) {
    const query = new URLSearchParams({ limit: String(limit), order: "desc" });
    if (project) query.set("project", project);
    if (directory) query.set("directory", directory);
    if (parentID !== null && parentID !== undefined && parentID !== "") {
      query.set("parentID", String(parentID));
    }
    const result = await this.request("GET", "/api/session?" + query);
    return result?.data || [];
  }

  async session(sessionID) {
    const result = await this.request(
      "GET",
      `/api/session/${encodeURIComponent(sessionID)}`,
    );
    return result?.data || null;
  }

  async sessionTree(sessionID, root = null, { since = 0 } = {}) {
    const source = root || (await this.session(sessionID));
    if (!source) return null;
    const totals = {
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      sessions: 0,
      subagents: 0,
      activeIDs: [],
    };
    const seen = new Set();
    const add = (session) => {
      if (!session?.id || seen.has(session.id)) return false;
      seen.add(session.id);
      totals.sessions += 1;
      totals.cost += Number(session.cost) || 0;
      for (const key of ["input", "output", "reasoning"]) {
        totals.tokens[key] += Number(session.tokens?.[key]) || 0;
      }
      totals.tokens.cache.read += Number(session.tokens?.cache?.read) || 0;
      totals.tokens.cache.write += Number(session.tokens?.cache?.write) || 0;
      if ((Number(session.time?.updated) || 0) >= since) {
        totals.activeIDs.push(session.id);
      }
      return true;
    };

    add(source);
    const queue = [source.id];
    while (queue.length) {
      const parentID = queue.shift();
      let children = [];
      try {
        children = await this.sessions({ parentID, limit: 1000 });
      } catch {
        children = [];
      }
      for (const child of children) {
        if (!add(child)) continue;
        totals.subagents += 1;
        queue.push(child.id);
      }
    }
    return totals;
  }

  async sessionUsageSince(sessionIDs, since) {
    let cost = 0;
    let input = 0;
    let output = 0;
    let messages = 0;
    for (const sessionID of sessionIDs || []) {
      let cursor = "";
      for (let page = 0; page < 50; page += 1) {
        const query = new URLSearchParams({
          limit: "100",
          type: "assistant",
        });
        if (cursor) {
          query.set("cursor", cursor);
        } else {
          query.set("order", "desc");
        }
        const result = await this.request(
          "GET",
          `/api/session/${encodeURIComponent(sessionID)}/message?${query}`,
        );
        const data = result?.data || [];
        if (!data.length) break;
        let reachedOlder = false;
        for (const message of data) {
          const created = Number(message.time?.created) || 0;
          if (created && created < since) {
            reachedOlder = true;
            break;
          }
          messages += 1;
          cost += Number(message.cost) || 0;
          input += Number(message.tokens?.input) || 0;
          output += Number(message.tokens?.output) || 0;
        }
        cursor = result?.cursor?.next || "";
        if (reachedOlder || !cursor) break;
      }
    }
    return { cost, tokens: { input, output }, messages };
  }

  async latestUserTime(sessionID) {
    const query = new URLSearchParams({
      limit: "1",
      type: "user",
      order: "desc",
    });
    const result = await this.request(
      "GET",
      `/api/session/${encodeURIComponent(sessionID)}/message?${query}`,
    );
    return Number(result?.data?.[0]?.time?.created) || null;
  }

  async activeSessions() {
    const result = await this.request("GET", "/api/session/active");
    return result?.data || {};
  }

  async forms(sessionID) {
    const result = await this.request(
      "GET",
      `/api/session/${encodeURIComponent(sessionID)}/form`,
    );
    return result?.data || [];
  }

  async pendingPermissions(sessionID) {
    const result = await this.request(
      "GET",
      `/api/session/${encodeURIComponent(sessionID)}/permission`,
    );
    return result?.data || [];
  }

  async messages(sessionID, { type = "", limit = 6, order = "desc" } = {}) {
    const query = new URLSearchParams({ limit: String(limit), order });
    if (type) query.set("type", type);
    const result = await this.request(
      "GET",
      `/api/session/${encodeURIComponent(sessionID)}/message?${query}`,
    );
    return result?.data || [];
  }

  async createSession({ directory, title }) {
    const result = await this.request("POST", "/api/session", {
      body: { title, location: { directory } },
    });
    return result?.data || null;
  }

  async prompt(sessionID, text, files = []) {
    return this.request(
      "POST",
      `/api/session/${encodeURIComponent(sessionID)}/prompt`,
      { body: files.length ? { text, files } : { text } },
    );
  }

  async replyForm(sessionID, formID, answer) {
    return this.request(
      "POST",
      `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(
        formID,
      )}/reply`,
      { body: { answer } },
    );
  }

  async replyPermission(sessionID, requestID, decision) {
    return this.request(
      "POST",
      `/api/session/${encodeURIComponent(
        sessionID,
      )}/permission/${encodeURIComponent(requestID)}/reply`,
      { body: { decision } },
    );
  }

  async subscribe(onEvent, { signal, onStatus = () => {} } = {}) {
    let backoff = 1000;
    while (!signal?.aborted) {
      try {
        this.refresh();
      } catch (error) {
        onStatus("waiting", error);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30000);
        continue;
      }
      try {
        onStatus("connecting");
        await this.stream(onEvent, signal, onStatus);
        backoff = 1000;
        onStatus("disconnected");
      } catch (error) {
        if (signal?.aborted) break;
        onStatus("error", error);
      }
      if (signal?.aborted) break;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30000);
    }
  }

  stream(onEvent, signal, onStatus) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      let url;
      try {
        url = new URL(this.url + "/api/event");
      } catch (error) {
        reject(error);
        return;
      }
      const lib = url.protocol === "https:" ? https : http;
      const headers = { accept: "text/event-stream" };
      const auth = basicAuth(this.password);
      if (auth) headers.authorization = auth;

      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        fn(value);
      };
      const abort = () => {
        request.destroy();
        finish(resolve);
      };

      const request = lib.request(url, { method: "GET", headers }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          finish(
            reject,
            new OpenCodeError(
              `OpenCode event stream HTTP ${response.statusCode}`,
              response.statusCode,
            ),
          );
          return;
        }
        onStatus("connected");
        const decoder = new TextDecoder();
        let buffer = "";
        let chain = Promise.resolve();

        response.on("data", (chunk) => {
          buffer += decoder.decode(chunk, { stream: true });
          buffer = buffer.replace(/\r\n/g, "\n");
          let boundary;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = block
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            let event;
            try {
              event = JSON.parse(data);
            } catch {
              continue;
            }
            if (!event?.type) continue;
            chain = chain
              .then(() => onEvent(event))
              .catch((error) => onStatus("handler-error", error));
          }
        });
        response.on("end", () => finish(resolve));
        response.on("close", () => finish(resolve));
        response.on("error", (error) => finish(reject, error));
      });

      if (signal) {
        signal.addEventListener("abort", abort, { once: true });
      }
      request.on("error", (error) => {
        if (signal?.aborted) finish(resolve);
        else finish(reject, error);
      });
      request.end();
    });
  }
}
