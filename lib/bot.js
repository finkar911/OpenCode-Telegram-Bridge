import {
  attachSettingsKeyboard,
  attachSettingsMessage,
  commandList,
  completionDocument,
  completionKeyboard,
  completionMessage,
  dedupeProjects,
  formatDate,
  formatFieldAnswer,
  formatNotificationText,
  formatSettingsKeyboard,
  formatSettingsMessage,
  helpMessage,
  looksLikeQuestion,
  makeTitle,
  modelProvidersKeyboard,
  modelProvidersMessage,
  modelsKeyboard,
  modelsMessage,
  modelVariantsKeyboard,
  modelVariantsMessage,
  newTaskModelKeyboard,
  notificationEnabled,
  notificationDocument,
  notificationSettingsKeyboard,
  notificationSettingsMessage,
  permissionKeyboard,
  permissionMessage,
  projectLabel,
  projectsKeyboard,
  projectsMessage,
  questionKeyboard,
  questionMessage,
  redact,
  replyKeyboard,
  sessionCard,
  sessionLabel,
  sessionModelLabel,
  sessionKeyboard,
  sessionsKeyboard,
  sessionsMessage,
  settingsKeyboard,
  settingsMessage,
  shouldShowField,
  sortProjects,
  startKeyboard,
  startMessage,
  statusMessage,
  truncate,
  validateAnswer,
} from "./ui.js";
import { emptyKeyboard, randomToken } from "./telegram.js";
import { normalizeLanguage, t } from "./i18n.js";

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MODEL_PAGE_SIZE = 10;
const SESSION_PAGE_SIZE = 10;
const RESPONSE_FORMATS = ["html", "code", "plain"];
const ATTACH_MODES = ["always", "auto", "never"];

function normalizeResponseFormat(value) {
  return RESPONSE_FORMATS.includes(value) ? value : "html";
}

function normalizeAttachMode(value) {
  return ATTACH_MODES.includes(value) ? value : "always";
}

const SESSION_STATUS_ICONS = {
  completed: "✅",
  failed: "❌",
  interrupted: "⏹",
  waiting_answers: "❓",
  waiting_permission: "🔐",
  waiting_subagents: "⏳",
  running: "🔄",
  idle: "⚪",
};

const NOTIFICATION_TYPES = [
  "start",
  "continuation",
  "subagents",
  "questions",
  "permissions",
  "completion",
];

function normalizeNotifications(value) {
  const notifications = {};
  for (const type of NOTIFICATION_TYPES) {
    notifications[type] = value?.[type] !== false;
  }
  return notifications;
}

export class Bot {
  constructor({ tg, oc, auth, config, state = {}, log = console }) {
    this.tg = tg;
    this.oc = oc;
    this.auth = auth;
    this.config = config;
    this.state = state;
    this.log = log;
    this.chatId = config.ownerId;
    this.language = normalizeLanguage(state.language || config.language);
    this.notifications = normalizeNotifications(state.notifications);
    this.activeSessionID = state.activeSessionID || null;
    this.pending = null;
    this.forms = new Map();
    this.formTokens = new Map();
    this.permissions = new Map();
    this.permissionTokens = new Map();
    this.startTimes = new Map();
    this.finishedAt = new Map();
    this.projectCache = { at: 0, items: [] };
    this.sessionCache = new Map();
    this.mediaGroups = new Map();
    this.mediaGroupDelayMs = config.mediaGroupDelayMs ?? 800;
    this.modelViews = new Map();
    this.modelChoices = new Map();
    this.favoriteSessions = new Set(
      Array.isArray(state.favoriteSessions)
        ? state.favoriteSessions
        : [],
    );
    this.responseFormat = normalizeResponseFormat(state.responseFormat);
    this.attachFullResult = normalizeAttachMode(state.attachFullResult);
    this.aliases = config.projectAliases || {};
    this.secrets = [config.token, config.opencodePassword].filter(Boolean);
    this.replyActions = new Map();
    const actions = [
      ["keyboard.projects", "projects"],
      ["keyboard.sessions", "sessions"],
      ["keyboard.newTask", "new"],
      ["keyboard.status", "status"],
      ["keyboard.settings", "settings"],
      ["keyboard.help", "help"],
      ["keyboard.id", "id"],
      ["keyboard.cancel", "cancel"],
      ["keyboard.lock", "lock"],
    ];
    for (const lang of ["en", "ru"]) {
      for (const [key, action] of actions) {
        this.replyActions.set(t(lang, key), action);
      }
    }
  }

  chat() {
    return this.chatId;
  }

  tr(key, vars = {}) {
    return t(this.language, key, vars);
  }

  isNotificationEnabled(type) {
    return notificationEnabled(this.notifications, type);
  }

  async send(text, keyboard = null, options = {}) {
    return this.tg.sendMessage(this.chat(), redact(text, this.secrets), {
      ...options,
      keyboard: options.keyboard ?? keyboard ?? undefined,
    });
  }

  async sendFormatted(text, keyboard = null, options = {}) {
    return this.send(text, keyboard, {
      ...options,
      ...(this.responseFormat === "plain" ? {} : { parseMode: "HTML" }),
    });
  }

  async sendNotification(render, options = {}) {
    const {
      project = "",
      session = "",
      title = "",
      keyboard = null,
      forceReply = "",
      attach = true,
    } = options;
    const fullText = render({
      format: "plain",
      attached: false,
      full: true,
    });
    const chatPlain = render({
      format: "plain",
      attached: false,
      full: false,
    });
    const shouldAttach =
      Boolean(fullText) &&
      attach &&
      (this.attachFullResult === "always" ||
        (this.attachFullResult === "auto" &&
          (fullText !== chatPlain || fullText.length > 3700)));
    const text = render({
      format: this.responseFormat,
      attached: shouldAttach,
      full: false,
    });
    const sent = await this.send(text, keyboard, {
      ...(this.responseFormat === "plain" ? {} : { parseMode: "HTML" }),
      ...(forceReply ? { forceReply } : {}),
    });
    if (shouldAttach) {
      await this.sendNotificationDocument({
        project,
        session,
        title,
        body: fullText,
        replyTo: sent?.message_id,
      });
    }
    return sent;
  }

  async sendNotificationDocument({
    project,
    session,
    title,
    body,
    replyTo,
  }) {
    if (!body) return;
    const document = notificationDocument({
      project,
      session,
      title,
      body: redact(body, this.secrets),
    });
    try {
      await this.tg.sendDocument(
        this.chat(),
        document.filename,
        document.content,
        {
          caption: truncate(
            this.tr("notification.fileCaption", {
              title: title || "—",
              session: session || "—",
            }),
            900,
          ),
          replyTo,
        },
      );
    } catch (error) {
      this.log.warn?.(`Cannot attach notification document: ${error.message}`);
      await this.send(
        this.tr("notification.fileError", { error: error.message }),
      ).catch(() => {});
    }
  }

  async safeAnswer(callbackQueryId, text = "") {
    try {
      await this.tg.answerCallbackQuery(callbackQueryId, text);
    } catch (error) {
      this.log.warn?.(`answerCallbackQuery failed: ${error.message}`);
    }
  }

  async handleUpdate(update) {
    const message = update.message;
    const callback = update.callback_query;
    const from = message?.from || callback?.from;
    const chat = message?.chat || callback?.message?.chat;
    const access = this.auth.check({ from, chat });

    if (access === "ignore") {
      this.log.info?.(`ignored Telegram update from user ${from?.id ?? "unknown"}`);
      return;
    }

    if (access === "locked") {
      try {
        const text = String(message?.text ?? "").trim();
        if (/^\/unlock(\s|@|$)/i.test(text)) {
          await this.handleUnlock(message);
          return;
        }
        if (callback) {
          await this.safeAnswer(callback.id, this.tr("bot.lockedCallback"));
        }
        await this.send(this.tr("bot.locked"));
      } catch (error) {
        this.log.error?.(
          `Locked update failed: ${redact(error.message, this.secrets)}`,
        );
      }
      return;
    }

    try {
      if (callback) await this.onCallback(callback);
      else if (message) await this.onMessage(message);
    } catch (error) {
      this.log.error?.(`Telegram update failed: ${redact(error.message, this.secrets)}`);
      await this.send(
        this.tr("bot.updateError", { error: truncate(error.message, 500) }),
      ).catch(() => {});
    }
  }

  async onMessage(message) {
    const text = String(message.text ?? message.caption ?? "").trim();
    const fromId = message.from?.id;
    const media = messageMedia(message);

    if (media.length && message.media_group_id) {
      this.bufferMediaGroup(message, text, media);
      return;
    }
    if (media.length) {
      return this.handleMediaInput(message, text, media);
    }
    if (
      message.document ||
      message.voice ||
      message.video ||
      message.audio ||
      message.sticker
    ) {
      await this.send(this.tr("bot.textOnly"));
      return;
    }

    if (!text) {
      return;
    }

    const replyAction = this.replyActions.get(text);
    if (replyAction) {
      return this.handleReplyAction(replyAction, message);
    }

    if (text.startsWith("/")) {
      const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();
      const space = text.search(/\s/);
      const argument = space === -1 ? "" : text.slice(space + 1).trim();

      switch (command) {
        case "/menu":
          return this.showMenuKeyboard();
        case "/start":
        case "/help":
          return this.sendMenu();
        case "/projects":
          return this.showProjects();
        case "/sessions":
          return this.showRecentSessions();
        case "/new":
          return this.startNewTask("");
        case "/status":
          return this.showStatus();
        case "/settings":
          return this.showSettings();
        case "/cancel":
          this.pending = null;
          return this.send(this.tr("bot.cancelled"));
        case "/lock":
          return this.handleLock();
        case "/unlock":
          return this.handleUnlock(message, argument);
        case "/id":
          return this.send(this.tr("bot.yourTelegramId", { id: fromId }));
        default:
          if (!this.pending) {
            return this.send(
              this.tr("bot.unknownCommand", {
                help: helpMessage(this.language),
              }),
            );
          }
          break;
      }
    }

    if (this.pending?.kind === "taskTitle") {
      return this.startNewTaskText(text);
    }
    if (this.pending?.kind === "taskText") {
      return this.createTask(text, this.pending);
    }
    if (this.pending?.kind === "taskModel") {
      return this.send(this.tr("bot.newTaskModelHint"));
    }
    if (this.pending?.kind === "prompt") {
      return this.sendPrompt(this.pending.sessionID, text);
    }
    if (this.pending?.kind === "formText") {
      return this.answerFormText(text);
    }

    if (this.activeSessionID) {
      return this.sendPrompt(this.activeSessionID, text);
    }

    await this.send(this.tr("bot.chooseProjectOrSession"));
  }

  bufferMediaGroup(message, text, media) {
    const groupID = String(message.media_group_id);
    let group = this.mediaGroups.get(groupID);
    if (!group) {
      group = { media: [], text: "", lastMessage: message, timer: null };
      this.mediaGroups.set(groupID, group);
    }
    for (const item of media) {
      if (!group.media.some((entry) => entry.fileId === item.fileId)) {
        group.media.push(item);
      }
    }
    if (text && !group.text) group.text = text;
    group.lastMessage = message;
    if (group.timer) return;
    group.timer = setTimeout(() => {
      this.flushMediaGroup(groupID).catch((error) => {
        this.log.error?.(
          `Media group ${groupID} failed: ${redact(error.message, this.secrets)}`,
        );
        this.send(
          this.tr("bot.imageDownloadError", { error: error.message }),
        ).catch(() => {});
      });
    }, this.mediaGroupDelayMs);
    group.timer.unref?.();
  }

  async flushMediaGroup(groupID) {
    const group = this.mediaGroups.get(groupID);
    if (!group) return;
    this.mediaGroups.delete(groupID);
    await this.handleMediaInput(
      group.lastMessage,
      group.text,
      group.media,
    );
  }

  async handleMediaInput(message, text, media) {
    if (this.pending?.kind === "taskText") {
      return this.createTask(text || this.tr("bot.imageTaskFallback"), {
        ...this.pending,
        media,
      });
    }
    if (
      this.pending?.kind === "taskTitle" ||
      this.pending?.kind === "taskModel"
    ) {
      await this.send(this.tr("bot.imageTaskNameOnly"));
      return;
    }
    if (this.pending?.kind === "prompt") {
      return this.sendPrompt(
        this.pending.sessionID,
        text || this.tr("bot.imageTaskFallback"),
        media,
      );
    }
    if (this.pending?.kind === "formText") {
      await this.send(this.tr("bot.imageNotForForm"));
      return;
    }
    await this.send(this.tr("bot.imageNeedsFlow"));
  }

  async downloadAttachments(media) {
    const files = [];
    for (const item of media) {
      if (Number(item.size) > MAX_ATTACHMENT_BYTES) {
        throw new Error(this.tr("bot.imageTooLarge"));
      }
      const file = await this.tg.getFile(item.fileId);
      if (!file?.file_path) {
        throw new Error(
          this.tr("bot.imageDownloadError", { error: "missing file_path" }),
        );
      }
      if (Number(file.file_size) > MAX_ATTACHMENT_BYTES) {
        throw new Error(this.tr("bot.imageTooLarge"));
      }
      const data = await this.tg.downloadFile(file.file_path);
      if (data.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new Error(this.tr("bot.imageTooLarge"));
      }
      files.push({
        uri: `data:${item.mime || "image/jpeg"};base64,${data.toString(
          "base64",
        )}`,
        name: item.name,
        description: this.tr("bot.imageDescription"),
      });
    }
    return files;
  }

  async onCallback(callback) {
    const data = String(callback.data ?? "");
    const [action, ...rest] = data.split(":");
    const argument = rest.join(":");

    switch (action) {
      case "home":
        await this.safeAnswer(callback.id);
        return this.sendMenu();
      case "projects":
        await this.safeAnswer(callback.id);
        return this.showProjects();
      case "sessions":
        await this.safeAnswer(callback.id);
        return this.showRecentSessions();
      case "status":
        await this.safeAnswer(callback.id);
        return this.showStatus();
      case "settings":
        await this.safeAnswer(callback.id);
        return this.showSettings();
      case "notifications":
        await this.safeAnswer(callback.id);
        return this.showNotificationSettings(callback);
      case "notif":
        return this.handleNotificationCallback(callback, argument);
      case "format":
        await this.safeAnswer(callback.id);
        return this.showFormatSettings(callback);
      case "fmt":
        return this.handleFormatCallback(callback, argument);
      case "attach":
        await this.safeAnswer(callback.id);
        return this.showAttachSettings(callback);
      case "att":
        return this.handleAttachCallback(callback, argument);
      case "lang":
        return this.changeLanguage(callback, argument);
      case "proj":
        await this.safeAnswer(callback.id);
        return argument ? this.showProjectSessions(argument) : this.showProjects();
      case "ses":
        await this.safeAnswer(callback.id);
        if (argument?.startsWith("draft_")) {
          return this.showNewTaskModelStep(
            argument.slice("draft_".length),
            callback,
          );
        }
        return argument ? this.showSession(argument) : this.showRecentSessions();
      case "refresh":
        await this.safeAnswer(callback.id);
        return argument ? this.showSession(argument) : this.showRecentSessions();
      case "new":
        await this.safeAnswer(callback.id);
        return this.startNewTask(argument);
      case "newtitle":
        await this.safeAnswer(callback.id);
        return this.startNewTaskTitle(argument, callback);
      case "cont":
        await this.safeAnswer(callback.id);
        return this.startPrompt(argument);
      case "favs":
        await this.safeAnswer(callback.id);
        return this.showRecentSessions("favorites", Number(argument) || 0);
      case "alls":
        await this.safeAnswer(callback.id);
        return this.showRecentSessions("all", Number(argument) || 0);
      case "favp": {
        await this.safeAnswer(callback.id);
        const [sessionProjectID, sessionPage] = argument.split(":");
        return this.showProjectSessions(
          sessionProjectID,
          "favorites",
          Number(sessionPage) || 0,
        );
      }
      case "allp": {
        await this.safeAnswer(callback.id);
        const [sessionProjectID, sessionPage] = argument.split(":");
        return this.showProjectSessions(
          sessionProjectID,
          "all",
          Number(sessionPage) || 0,
        );
      }
      case "fav":
        return this.toggleFavorite(callback, argument);
      case "model":
        await this.safeAnswer(callback.id);
        return this.showModelProviders(argument, callback);
      case "modelprov": {
        await this.safeAnswer(callback.id);
        const [sessionID, providerIndex] = argument.split(":");
        return this.showProviderModels(
          sessionID,
          providerIndex,
          0,
          callback,
        );
      }
      case "modelp": {
        await this.safeAnswer(callback.id);
        const [sessionID, page] = argument.split(":");
        return this.showProviderModels(
          sessionID,
          this.modelViews.get(sessionID)?.providerIndex || 0,
          page,
          callback,
        );
      }
      case "modelprovs":
        await this.safeAnswer(callback.id);
        return this.showModelProviders(argument, callback);
      case "mc":
        return this.onModelChoice(callback, argument);
      case "mv": {
        const [token, variant] = argument.split(":");
        return this.onVariantChoice(callback, token, variant);
      }
      case "q":
        return this.onFormCallback(callback, rest);
      case "perm":
        return this.onPermissionCallback(callback, rest);
      default:
        return this.safeAnswer(callback.id, this.tr("bot.unknownButton"));
    }
  }

  async sendMenu() {
    this.pending = null;
    await this.send(helpMessage(this.language), null, {
      replyKeyboard: replyKeyboard(this.language),
    });
  }

  async showMenuKeyboard() {
    try {
      await this.send("⌨️", null, {
        replyKeyboard: replyKeyboard(this.language),
        disableNotification: true,
      });
    } catch (error) {
      this.log.warn?.(`Cannot refresh menu keyboard: ${error.message}`);
    }
  }

  async showSettings() {
    this.pending = null;
    await this.send(
      settingsMessage(
        this.language,
        this.notifications,
        this.responseFormat,
        this.attachFullResult,
      ),
      settingsKeyboard(this.language),
    );
  }

  async showFormatSettings(callback) {
    await this.editOrSend(
      callback,
      formatSettingsMessage(this.language),
      formatSettingsKeyboard(this.language, this.responseFormat),
    );
  }

  async handleFormatCallback(callback, value) {
    if (!RESPONSE_FORMATS.includes(value)) {
      await this.safeAnswer(callback.id, this.tr("bot.unknownButton"));
      return;
    }
    this.responseFormat = value;
    this.state.responseFormat = value;
    await this.safeAnswer(callback.id, this.tr("settings.saved"));
    await this.showFormatSettings(callback);
  }

  async showAttachSettings(callback) {
    await this.editOrSend(
      callback,
      attachSettingsMessage(this.language),
      attachSettingsKeyboard(this.language, this.attachFullResult),
    );
  }

  async handleAttachCallback(callback, value) {
    if (!ATTACH_MODES.includes(value)) {
      await this.safeAnswer(callback.id, this.tr("bot.unknownButton"));
      return;
    }
    this.attachFullResult = value;
    this.state.attachFullResult = value;
    await this.safeAnswer(callback.id, this.tr("settings.saved"));
    await this.showAttachSettings(callback);
  }

  async showNotificationSettings(callback) {
    const text = notificationSettingsMessage(
      this.language,
      this.notifications,
    );
    const keyboard = notificationSettingsKeyboard(
      this.language,
      this.notifications,
    );
    const messageID = callback?.message?.message_id;
    if (messageID) {
      try {
        await this.tg.editMessageText(
          this.chat(),
          messageID,
          text,
          { keyboard },
        );
        return;
      } catch {
        // fall through to a new message when the old one cannot be edited
      }
    }
    await this.send(text, keyboard);
  }

  async handleNotificationCallback(callback, argument) {
    if (argument === "all" || argument === "none") {
      for (const type of NOTIFICATION_TYPES) {
        this.notifications[type] = argument === "all";
      }
    } else if (NOTIFICATION_TYPES.includes(argument)) {
      this.notifications[argument] = !this.notifications[argument];
    } else {
      await this.safeAnswer(callback.id, this.tr("bot.unknownButton"));
      return;
    }
    this.state.notifications = { ...this.notifications };
    await this.safeAnswer(callback.id, this.tr("settings.saved"));
    await this.showNotificationSettings(callback);
  }

  async changeLanguage(callback, code) {
    const next = normalizeLanguage(code);
    this.language = next;
    this.state.language = next;
    await this.safeAnswer(
      callback.id,
      this.tr("settings.changed", {
        language: next === "ru" ? "Русский" : "English",
      }),
    );
    await this.send(
      this.tr("settings.changed", {
        language: next === "ru" ? "Русский" : "English",
      }),
      null,
      {
        replyKeyboard: replyKeyboard(this.language),
      },
    );
    await this.showSettings();
  }

  async installMenus() {
    if (typeof this.tg.setMyCommands !== "function") return;
    await this.tg.setMyCommands(commandList("en"), "en");
    await this.tg.setMyCommands(commandList("ru"), "ru");
    await this.tg.setMyCommands(commandList("en"));
    if (typeof this.tg.setChatMenuButton === "function") {
      await this.tg.setChatMenuButton();
    }
  }

  async handleReplyAction(action, message) {
    switch (action) {
      case "projects":
        return this.showProjects();
      case "sessions":
        return this.showRecentSessions();
      case "new":
        return this.startNewTask("");
      case "status":
        return this.showStatus();
      case "settings":
        return this.showSettings();
      case "help":
        return this.sendMenu();
      case "id":
        return this.send(
          this.tr("bot.yourTelegramId", { id: message.from?.id }),
        );
      case "cancel":
        this.pending = null;
        return this.send(this.tr("bot.cancelled"));
      case "lock":
        return this.handleLock();
      default:
        return undefined;
    }
  }

  async handleLock() {
    if (!this.config.pin) {
      await this.send(this.tr("bot.pinNotSet"));
      return;
    }
    this.auth.lock();
    await this.send(this.tr("bot.lockedAction"));
  }

  async handleUnlock(message, argument = "") {
    if (!this.config.pin) {
      await this.send(this.tr("bot.pinNotSet"));
      return;
    }
    if (this.auth.isUnlocked()) {
      await this.send(this.tr("bot.alreadyUnlocked"));
      return;
    }
    let candidate = argument;
    if (!candidate) {
      const text = String(message?.text ?? "").trim();
      const parts = text.split(/\s+/);
      candidate = parts.length > 1 ? parts.slice(1).join(" ") : "";
    }
    if (!candidate) {
      await this.send(this.tr("bot.enterPin"));
      return;
    }
    const result = this.auth.unlock(candidate);
    if (result.ok) {
      const minutes = Math.round(this.config.unlockMs / 60000);
      await this.send(this.tr("bot.unlockedFor", { minutes }));
      return;
    }
    if (result.reason === "too-many") {
      await this.send(
        this.tr("bot.tooManyAttempts", {
          time: formatDate(result.retryAt, this.language),
        }),
      );
      return;
    }
    if (result.reason === "locked") {
      await this.send(
        this.tr("bot.pinInputLocked", {
          time: formatDate(result.retryAt, this.language),
        }),
      );
      return;
    }
    await this.send(
      this.tr("bot.wrongPin", { count: result.attemptsLeft }),
    );
  }

  async getProjects(force = false) {
    const now = Date.now();
    if (
      !force &&
      this.projectCache.items.length > 0 &&
      now - this.projectCache.at < 60_000
    ) {
      return this.projectCache.items;
    }
    const items = await this.oc.projects();
    this.projectCache = { at: now, items };
    return items;
  }

  async getProject(projectID) {
    let projects = await this.getProjects();
    let project = projects.find((item) => item.id === projectID);
    if (!project) {
      projects = await this.getProjects(true);
      project = projects.find((item) => item.id === projectID);
    }
    if (!project) throw new Error(this.tr("bot.projectNotFound"));
    return project;
  }

  async getSession(sessionID, force = false) {
    const cached = this.sessionCache.get(sessionID);
    if (!force && cached && Date.now() - cached.at < 30_000) {
      return cached.session;
    }
    const session = await this.oc.session(sessionID);
    if (!session) throw new Error(this.tr("bot.sessionNotFound"));
    this.sessionCache.set(sessionID, { at: Date.now(), session });
    return session;
  }

  async contextFor(sessionID) {
    const session = await this.getSession(sessionID);
    let project = null;
    try {
      project = await this.getProject(session.projectID);
    } catch {
      // the session may outlive a project or the project list may be stale
    }
    return {
      session,
      project,
      projectName: project
        ? projectLabel(project, this.aliases, this.language)
        : session.location?.directory || "—",
    };
  }

  async countActiveDescendants(sessionID, activeMap = {}) {
    const waiting = new Set();
    for (const activeID of Object.keys(activeMap || {})) {
      if (activeID === sessionID) continue;
      let current;
      try {
        current = await this.getSession(activeID);
      } catch {
        continue;
      }
      let guard = 0;
      while (current?.parentID && guard < 20) {
        if (current.parentID === sessionID) {
          waiting.add(activeID);
          break;
        }
        try {
          current = await this.getSession(current.parentID);
        } catch {
          current = null;
        }
        guard += 1;
      }
    }
    return waiting.size;
  }

  async activityFor(sessionID) {
    let activeMap = {};
    try {
      activeMap = await this.oc.activeSessions();
    } catch {
      // fall back to no activity
    }
    return {
      active: Boolean(activeMap?.[sessionID]),
      waitingChildren: await this.countActiveDescendants(sessionID, activeMap),
    };
  }

  async sessionStatus(session, activeMap = null) {
    let map = activeMap;
    if (!map) {
      try {
        map = await this.oc.activeSessions();
      } catch {
        map = {};
      }
    }

    let forms = [];
    let permissions = [];
    if (this.oc.forms) {
      try {
        forms = await this.oc.forms(session.id);
      } catch {
        // status falls back to the remaining signals
      }
    }
    if (this.oc.pendingPermissions) {
      try {
        permissions = await this.oc.pendingPermissions(session.id);
      } catch {
        // status falls back to the remaining signals
      }
    }

    const waitingChildren = await this.countActiveDescendants(
      session.id,
      map,
    );
    let key = "idle";
    if (forms.length > 0) key = "waiting_answers";
    else if (permissions.length > 0) key = "waiting_permission";
    else if (map?.[session.id]) key = "running";
    else if (waitingChildren > 0) key = "waiting_subagents";
    else if (session.outcome === "failed") key = "failed";
    else if (session.outcome === "interrupted") key = "interrupted";
    else if (session.outcome === "succeeded") key = "completed";

    let label = this.tr(`sessions.status.${key}`);
    if (key === "waiting_subagents" && waitingChildren > 1) {
      label += ` (${waitingChildren})`;
    }
    return {
      key,
      icon: SESSION_STATUS_ICONS[key] || "⚪",
      label,
      active: Boolean(map?.[session.id]),
      waitingChildren,
    };
  }

  async sessionStatuses(sessions) {
    let activeMap = {};
    try {
      activeMap = await this.oc.activeSessions();
    } catch {
      // statuses still use forms, permissions and outcome
    }
    return Promise.all(
      sessions.map(async (session) => ({
        ...session,
        status: await this.sessionStatus(session, activeMap),
      })),
    );
  }

  async editOrSend(callback, text, keyboard) {
    const messageID = callback?.message?.message_id;
    if (messageID) {
      try {
        await this.tg.editMessageText(
          this.chat(),
          messageID,
          text,
          { keyboard },
        );
        return;
      } catch {
        // fall through to a new message
      }
    }
    await this.send(text, keyboard);
  }

  matchModel(model, ref) {
    if (!model || !ref) return false;
    return (
      model.providerID === ref.providerID &&
      (model.modelID === ref.id || model.id === ref.id)
    );
  }

  modelDisplayName(session, models) {
    const ref = session?.model;
    if (!ref?.id) return this.tr("model.none");
    const matched = (models || []).find((model) =>
      this.matchModel(model, ref),
    );
    const name = matched?.name || ref.id;
    const variant = ref.variant ? `, ${ref.variant}` : "";
    return `${name} (${ref.providerID}${variant})`;
  }

  modelRefFromInfo(model) {
    if (!model) return null;
    const id = model.modelID || model.id;
    if (!id || !model.providerID) return null;
    const ref = { id, providerID: model.providerID };
    if (model.variant) ref.variant = model.variant;
    return ref;
  }

  async loadModelView(target) {
    let session;
    let project;
    let directory;
    if (target.startsWith("draft_")) {
      const projectID = target.slice("draft_".length);
      project = await this.getProject(projectID);
      directory = project?.canonical || "";
      session = {
        id: target,
        projectID,
        title: this.tr("bot.newTaskDraftSession"),
        model:
          this.pending?.kind === "taskModel"
            ? this.pending.model
            : null,
      };
    } else {
      session = await this.getSession(target, true);
      project = await this.getProject(session.projectID).catch(() => null);
      directory = session.location?.directory || project?.canonical || "";
    }
    const all = await this.oc.models({ directory });
    const filtered = all.filter(
      (model) =>
        (model.type === undefined || model.type === "chat") &&
        model.enabled !== false &&
        model.status !== "deprecated",
    );
    const groups = new Map();
    for (const model of filtered) {
      if (!groups.has(model.providerID)) {
        groups.set(model.providerID, []);
      }
      groups.get(model.providerID).push(model);
    }
    const currentProvider = session.model?.providerID || "";
    const providers = [...groups.entries()]
      .map(([id, models]) => ({
        id,
        count: models.length,
        models: [...models].sort((a, b) =>
          String(a.name).localeCompare(String(b.name)),
        ),
      }))
      .sort((a, b) => {
        if (a.id === currentProvider) return -1;
        if (b.id === currentProvider) return 1;
        return a.id.localeCompare(b.id);
      });
    const view = {
      session,
      project,
      projectName: project
        ? projectLabel(project, this.aliases, this.language)
        : directory || "—",
      models: filtered,
      providers,
      providerIndex: 0,
      page: 0,
    };
    this.modelViews.set(target, view);
    return view;
  }

  async showModelProviders(sessionID, callback) {
    try {
      const view = await this.loadModelView(sessionID);
      if (!view.providers.length) {
        await this.send(this.tr("model.noModels"));
        return;
      }
      const keyboard = modelProvidersKeyboard({
        sessionID,
        providers: view.providers,
        currentProvider: view.session.model?.providerID || "",
        lang: this.language,
      });
      await this.editOrSend(
        callback,
        modelProvidersMessage({
          project: view.projectName,
          session: sessionLabel(view.session, this.language),
          current: this.modelDisplayName(view.session, view.models),
          lang: this.language,
        }),
        keyboard,
      );
    } catch (error) {
      await this.send(
        this.tr("model.loadError", { error: error.message }),
      );
    }
  }

  async showProviderModels(sessionID, providerIndex, page = 0, callback) {
    try {
      let view = this.modelViews.get(sessionID);
      if (!view) view = await this.loadModelView(sessionID);
      const index = Math.max(
        0,
        Math.min(Number(providerIndex) || 0, view.providers.length - 1),
      );
      const provider = view.providers[index];
      if (!provider) {
        await this.showModelProviders(sessionID, callback);
        return;
      }
      const pages = Math.max(
        1,
        Math.ceil(provider.models.length / MODEL_PAGE_SIZE),
      );
      const currentPage = Math.max(
        0,
        Math.min(Number(page) || 0, pages - 1),
      );
      const pageModels = provider.models
        .slice(
          currentPage * MODEL_PAGE_SIZE,
          currentPage * MODEL_PAGE_SIZE + MODEL_PAGE_SIZE,
        )
        .map((model) => {
          const token = randomToken("m");
          this.modelChoices.set(token, {
            sessionID,
            model,
            providerIndex: index,
            page: currentPage,
          });
          return {
            ...model,
            token,
            current: this.matchModel(model, view.session.model),
          };
        });
      view.providerIndex = index;
      view.page = currentPage;
      await this.editOrSend(
        callback,
        modelsMessage({
          project: view.projectName,
          session: sessionLabel(view.session, this.language),
          current: this.modelDisplayName(view.session, view.models),
          provider: provider.id,
          page: currentPage,
          pages,
          lang: this.language,
        }),
        modelsKeyboard({
          sessionID,
          providerIndex: index,
          page: currentPage,
          pages,
          models: pageModels,
          lang: this.language,
        }),
      );
    } catch (error) {
      await this.send(
        this.tr("model.loadError", { error: error.message }),
      );
    }
  }

  async showModelVariants(sessionID, token, callback) {
    const choice = this.modelChoices.get(token);
    if (!choice) {
      await this.safeAnswer(callback.id, this.tr("model.stale"));
      return;
    }
    const view =
      this.modelViews.get(sessionID) ||
      (await this.loadModelView(sessionID));
    const variants = (choice.model.variants || [])
      .map((variant) => variant.id)
      .filter(Boolean);
    const currentVariant = this.matchModel(
      choice.model,
      view.session.model,
    )
      ? view.session.model.variant || ""
      : "";
    await this.editOrSend(
      callback,
      modelVariantsMessage({
        project: view.projectName,
        session: sessionLabel(view.session, this.language),
        model: `${choice.model.name} (${choice.model.providerID})`,
        currentVariant,
        lang: this.language,
      }),
      modelVariantsKeyboard({
        token,
        variants,
        currentVariant,
        sessionID,
        lang: this.language,
      }),
    );
  }

  async applySessionModel(callback, sessionID, model, variant) {
    try {
      const ref = {
        id: model.modelID || model.id,
        providerID: model.providerID,
      };
      if (variant) ref.variant = variant;
      if (sessionID.startsWith("draft_")) {
        const projectID = sessionID.slice("draft_".length);
        if (
          !this.pending ||
          this.pending.kind !== "taskModel" ||
          this.pending.projectID !== projectID
        ) {
          await this.safeAnswer(callback.id, this.tr("model.stale"));
          await this.startNewTask(projectID);
          return;
        }
        const view = this.modelViews.get(sessionID);
        this.pending = {
          ...this.pending,
          model: ref,
          modelDisplay: this.modelDisplayName(
            { model: ref },
            view?.models || [],
          ),
          isDefault: false,
        };
        this.modelViews.delete(sessionID);
        await this.safeAnswer(callback.id, this.tr("model.changedShort"));
        await this.showNewTaskModelStep(projectID, callback);
        return;
      }
      await this.oc.switchModel(sessionID, ref);
      this.sessionCache.delete(sessionID);
      this.modelViews.delete(sessionID);
      await this.safeAnswer(callback.id, this.tr("model.changedShort"));
      await this.showSession(sessionID);
    } catch (error) {
      await this.safeAnswer(callback.id);
      await this.send(this.tr("model.error", { error: error.message }));
    }
  }

  async onModelChoice(callback, token) {
    const choice = this.modelChoices.get(token);
    if (!choice) {
      await this.safeAnswer(callback.id, this.tr("model.stale"));
      return;
    }
    const variants = (choice.model.variants || [])
      .map((variant) => variant.id)
      .filter(Boolean);
    if (variants.length) {
      await this.safeAnswer(callback.id);
      await this.showModelVariants(choice.sessionID, token, callback);
      return;
    }
    await this.applySessionModel(
      callback,
      choice.sessionID,
      choice.model,
      "",
    );
  }

  async onVariantChoice(callback, token, variantArg) {
    const choice = this.modelChoices.get(token);
    if (!choice) {
      await this.safeAnswer(callback.id, this.tr("model.stale"));
      return;
    }
    const variants = (choice.model.variants || [])
      .map((variant) => variant.id)
      .filter(Boolean);
    let variant = "";
    if (variantArg !== "d") {
      variant = variants[Number(variantArg)] || "";
      if (!variant) {
        await this.safeAnswer(callback.id, this.tr("model.stale"));
        return;
      }
    }
    await this.applySessionModel(
      callback,
      choice.sessionID,
      choice.model,
      variant,
    );
  }

  async showProjects() {
    this.pending = null;
    try {
      const projects = sortProjects(dedupeProjects(await this.getProjects(true)));
      if (!projects.length) {
        await this.send(this.tr("bot.noProjectsRefresh"));
        return;
      }
      await this.send(
        projectsMessage(projects, this.aliases, this.language),
        projectsKeyboard(projects, this.aliases, "proj", this.language),
      );
    } catch (error) {
      await this.send(this.tr("bot.projectsError", { error: error.message }));
    }
  }

  async loadSessionList({ projectID = "", directory = "" } = {}) {
    const raw = projectID
      ? directory
        ? await this.oc.sessions({ directory, limit: 100 })
        : await this.oc.sessions({ project: projectID, limit: 100 })
      : await this.oc.sessions({ limit: 100 });
    const seen = new Set(raw.map((session) => session.id));
    const missing = [...this.favoriteSessions].filter(
      (sessionID) => !seen.has(sessionID),
    );
    if (missing.length) {
      const extras = await Promise.all(
        missing.map(async (sessionID) => {
          try {
            return await this.getSession(sessionID);
          } catch {
            return null;
          }
        }),
      );
      for (const session of extras) {
        if (!session || session.parentID) continue;
        if (projectID) {
          const sameProject = session.projectID === projectID;
          const sameDirectory =
            directory && session.location?.directory === directory;
          if (!sameProject && !sameDirectory) continue;
        }
        if (seen.has(session.id)) continue;
        raw.push(session);
        seen.add(session.id);
      }
    }
    return raw.sort(
      (a, b) => Number(b.time?.updated || 0) - Number(a.time?.updated || 0),
    );
  }

  async renderSessionList({
    items,
    projectID = "",
    projectName = "",
    projectNames = {},
    mode = "favorites",
    page = 0,
  }) {
    const filtered =
      mode === "favorites"
        ? items.filter((session) =>
            this.favoriteSessions.has(session.id),
          )
        : items;
    const pages = Math.max(
      1,
      Math.ceil(filtered.length / SESSION_PAGE_SIZE),
    );
    const currentPage = Math.max(
      0,
      Math.min(Number(page) || 0, pages - 1),
    );
    const pageSessions = filtered.slice(
      currentPage * SESSION_PAGE_SIZE,
      currentPage * SESSION_PAGE_SIZE + SESSION_PAGE_SIZE,
    );
    const sessions = await this.sessionStatuses(pageSessions);
    const favorites = [...this.favoriteSessions];
    const projectScoped = Boolean(projectID);
    const route = (nextPage) =>
      projectScoped
        ? `${
            mode === "favorites" ? "favp" : "allp"
          }:${projectID}:${nextPage}`
        : `${mode === "favorites" ? "favs" : "alls"}:${nextPage}`;
    await this.send(
      sessionsMessage({
        project: projectName,
        sessions,
        projectNames,
        favoriteIDs: favorites,
        mode,
        page: currentPage,
        pages,
        lang: this.language,
      }),
      sessionsKeyboard({
        sessions,
        projectID,
        lang: this.language,
        mode,
        page: currentPage,
        pages,
        favoriteIDs: favorites,
        prevData: currentPage > 0 ? route(currentPage - 1) : "",
        nextData:
          currentPage < pages - 1 ? route(currentPage + 1) : "",
        switchData:
          mode === "favorites"
            ? projectScoped
              ? `allp:${projectID}:0`
              : "alls:0"
            : projectScoped
              ? `favp:${projectID}:0`
              : "favs:0",
        backData: "projects",
      }),
    );
  }

  async showProjectSessions(projectID, mode = "favorites", page = 0) {
    this.pending = null;
    try {
      const project = await this.getProject(projectID);
      const projectName = projectLabel(
        project,
        this.aliases,
        this.language,
      );
      const items = await this.loadSessionList({
        projectID,
        directory: project.canonical,
      });
      await this.renderSessionList({
        items,
        projectID,
        projectName,
        mode,
        page,
      });
    } catch (error) {
      await this.send(this.tr("bot.sessionsError", { error: error.message }));
    }
  }

  async showRecentSessions(mode = "favorites", page = 0) {
    this.pending = null;
    try {
      const [items, projects] = await Promise.all([
        this.loadSessionList(),
        this.getProjects(),
      ]);
      const projectNames = Object.fromEntries(
        projects.map((project) => [
          project.id,
          projectLabel(project, this.aliases, this.language),
        ]),
      );
      await this.renderSessionList({
        items,
        projectNames,
        mode,
        page,
      });
    } catch (error) {
      await this.send(this.tr("bot.sessionsError", { error: error.message }));
    }
  }

  async toggleFavorite(callback, sessionID) {
    const wasFavorite = this.favoriteSessions.has(sessionID);
    if (wasFavorite) this.favoriteSessions.delete(sessionID);
    else this.favoriteSessions.add(sessionID);
    this.state.favoriteSessions = [...this.favoriteSessions];
    await this.safeAnswer(
      callback.id,
      this.tr(
        wasFavorite
          ? "sessions.favoriteRemoved"
          : "sessions.favoriteAdded",
      ),
    );
    await this.showSession(sessionID);
  }

  async showSession(sessionID) {
    try {
      const keepPending =
        this.pending?.kind === "prompt" &&
        this.pending.sessionID === sessionID;
      if (!keepPending) this.pending = null;
      const session = await this.getSession(sessionID, true);
      const project = await this.getProject(session.projectID).catch(() => null);
      const projectName = project
        ? projectLabel(project, this.aliases, this.language)
        : session.location?.directory || "—";
      let lastText = "";
      try {
        const messages = await this.oc.messages(sessionID, { limit: 12 });
        lastText = extractAssistantTextAfterUser(messages);
      } catch {
        // the card is still useful without the last message
      }
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const since = dayStart.getTime();
      const [status, tree] = await Promise.all([
        this.sessionStatus(session),
        this.oc.sessionTree(sessionID, session, { since }).catch(() => null),
      ]);
      let dailyUsage = null;
      if (tree) {
        dailyUsage = tree.activeIDs.length
          ? await this.oc
              .sessionUsageSince(tree.activeIDs, since)
              .catch(() => null)
          : { cost: 0, tokens: { input: 0, output: 0 } };
      }
      const displaySession = tree
        ? { ...session, cost: tree.cost, tokens: tree.tokens }
        : session;
      this.activeSessionID = session.id;
      this.state.activeSessionID = session.id;
      await this.sendFormatted(
        sessionCard({
          project: projectName,
          session: displaySession,
          lastText,
          active: status.active,
          waitingChildren: status.waitingChildren,
          status,
          dailyCost: dailyUsage?.cost,
          dailyTokens: dailyUsage?.tokens,
          lang: this.language,
          format: this.responseFormat,
        }),
        sessionKeyboard(
          session,
          session.projectID,
          this.language,
          this.favoriteSessions.has(session.id),
        ),
      );
    } catch (error) {
      await this.send(this.tr("bot.openSessionError", { error: error.message }));
    }
  }

  async startNewTask(projectID) {
    this.pending = null;
    try {
      if (!projectID) {
        const projects = sortProjects(
          dedupeProjects(await this.getProjects(true)),
        );
        if (!projects.length) {
          await this.send(this.tr("bot.noProjects"));
          return;
        }
        await this.send(
          this.tr("bot.chooseProjectForTask"),
          projectsKeyboard(projects, this.aliases, "new", this.language),
        );
        return;
      }
      const project = await this.getProject(projectID);
      const defaultModel = await this.oc
        .defaultModel({ directory: project.canonical })
        .catch(() => null);
      const model = this.modelRefFromInfo(defaultModel);
      const modelDisplay = model
        ? this.modelDisplayName({ model }, defaultModel ? [defaultModel] : [])
        : this.tr("model.none");
      this.pending = {
        kind: "taskModel",
        projectID,
        model,
        modelDisplay,
        isDefault: Boolean(model),
      };
      await this.showNewTaskModelStep(projectID);
    } catch (error) {
      this.pending = null;
      await this.send(this.tr("bot.startTaskError", { error: error.message }));
    }
  }

  async showNewTaskModelStep(projectID, callback = null) {
    if (
      !this.pending ||
      this.pending.kind !== "taskModel" ||
      this.pending.projectID !== projectID
    ) {
      return this.startNewTask(projectID);
    }
    let projectName = projectID;
    try {
      const project = await this.getProject(projectID);
      projectName = projectLabel(project, this.aliases, this.language);
    } catch {
      // keep the project id as a fallback label
    }
    const lines = [
      this.tr("bot.newTaskTitle"),
      this.tr("bot.newTaskProject", { project: projectName }),
      this.tr("bot.newTaskModel", {
        model: this.pending.modelDisplay || this.tr("model.none"),
      }),
    ];
    if (this.pending.isDefault) {
      lines.push(this.tr("bot.newTaskDefaultModel"));
    }
    lines.push("", this.tr("bot.newTaskModelHint"));
    await this.editOrSend(
      callback,
      lines.join("\n"),
      newTaskModelKeyboard(projectID, this.language),
    );
  }

  async startNewTaskTitle(projectID, callback = null) {
    if (
      !this.pending ||
      this.pending.kind !== "taskModel" ||
      this.pending.projectID !== projectID
    ) {
      return this.startNewTask(projectID);
    }
    const state = { ...this.pending, kind: "taskTitle" };
    this.pending = state;
    let projectName = projectID;
    try {
      const project = await this.getProject(projectID);
      projectName = projectLabel(project, this.aliases, this.language);
    } catch {
      // keep the project id as a fallback label
    }
    const sent = await this.send(
      [
        this.tr("bot.newTaskTitle"),
        this.tr("bot.newTaskProject", { project: projectName }),
        this.tr("bot.newTaskModel", {
          model: state.modelDisplay || this.tr("model.none"),
        }),
        "",
        this.tr("bot.newTaskSessionPrompt"),
      ].join("\n"),
      null,
      { forceReply: this.tr("bot.newTaskSessionPlaceholder") },
    );
    if (sent?.message_id) this.pending.promptID = sent.message_id;
  }

  async startNewTaskText(title) {
    const name = String(title ?? "").trim();
    if (!name || this.pending?.kind !== "taskTitle") return;
    const state = { ...this.pending, kind: "taskText", title: name };
    this.pending = state;
    let projectName = state.projectID;
    try {
      const project = await this.getProject(state.projectID);
      projectName = projectLabel(project, this.aliases, this.language);
    } catch {
      // keep the project id as a fallback label
    }
    const sent = await this.send(
      [
        this.tr("bot.newTaskTitle"),
        this.tr("bot.newTaskProject", { project: projectName }),
        this.tr("bot.newTaskSessionName", { name }),
        this.tr("bot.newTaskModel", {
          model: state.modelDisplay || this.tr("model.none"),
        }),
        "",
        this.tr("bot.describeTask"),
      ].join("\n"),
      null,
      { forceReply: this.tr("bot.formTaskPlaceholder") },
    );
    if (sent?.message_id) this.pending.promptID = sent.message_id;
  }

  async createTask(
    text,
    { projectID, title, model, media = [] } = {},
  ) {
    const task = String(text).trim();
    if (!task) return;
    let project;
    try {
      project = await this.getProject(projectID);
    } catch (error) {
      await this.send(`⚠️ ${error.message}`);
      return;
    }

    let files = [];
    try {
      files = await this.downloadAttachments(media);
    } catch (error) {
      await this.send(
        this.tr("bot.imageDownloadError", { error: error.message }),
      );
      return;
    }
    this.pending = null;

    let session;
    try {
      session = await this.oc.createSession({
        directory: project.canonical,
        title: String(title ?? "").trim() || makeTitle(task, this.language),
      });
    } catch (error) {
      await this.send(this.tr("bot.createSessionError", { error: error.message }));
      return;
    }
    if (!session) {
      await this.send(this.tr("bot.noSessionReturned"));
      return;
    }

    this.activeSessionID = session.id;
    this.state.activeSessionID = session.id;

    try {
      if (model) await this.oc.switchModel(session.id, model);
      await this.oc.prompt(session.id, task, files);
    } catch (error) {
      await this.send(
        this.tr("bot.promptError", { error: error.message, id: session.id }),
        sessionKeyboard(
          session,
          session.projectID || project.id,
          this.language,
          this.favoriteSessions.has(session.id),
        ),
      );
      return;
    }

    let confirmation = this.tr("bot.taskCreated", {
      project: projectLabel(project, this.aliases, this.language),
      session: sessionLabel(session, this.language),
    });
    if (files.length) {
      confirmation += `\n${this.tr("bot.imagesCount", {
        count: files.length,
      })}`;
    }
    await this.send(
      confirmation,
      sessionKeyboard(
        session,
        session.projectID || project.id,
        this.language,
        this.favoriteSessions.has(session.id),
      ),
    );
  }

  async startPrompt(sessionID) {
    try {
      const id = sessionID || this.activeSessionID;
      if (!id) {
        await this.send(this.tr("bot.chooseSession"));
        return;
      }
      const session = await this.getSession(id, true);
      this.activeSessionID = session.id;
      this.state.activeSessionID = session.id;
      this.pending = { kind: "prompt", sessionID: session.id };
      const project = await this.getProject(session.projectID).catch(() => null);
      const projectName = project
        ? projectLabel(project, this.aliases, this.language)
        : session.location?.directory || "—";
      const sent = await this.send(
        `${this.tr("bot.continueHeader")}\n${this.tr("bot.continueProject", {
          project: projectName,
        })}\n${this.tr("bot.continueSession", {
          session: sessionLabel(session, this.language),
        })}\n\n${this.tr("bot.enterMessage")}`,
        null,
        { forceReply: this.tr("bot.formMessagePlaceholder") },
      );
      if (sent?.message_id) this.pending.promptID = sent.message_id;
    } catch (error) {
      this.pending = null;
      await this.send(this.tr("bot.openSessionError", { error: error.message }));
    }
  }

  async sendPrompt(sessionID, text, media = []) {
    const message = String(text).trim();
    if (!message) return;
    let files = [];
    try {
      files = await this.downloadAttachments(media);
    } catch (error) {
      await this.send(
        this.tr("bot.imageDownloadError", { error: error.message }),
      );
      return;
    }
    this.pending = null;
    try {
      await this.oc.prompt(sessionID, message, files);
      await this.send(this.tr("bot.sentToSession"));
    } catch (error) {
      await this.send(this.tr("bot.sendMessageError", { error: error.message }));
    }
  }

  async showStatus() {
    let info = null;
    let projects = [];
    try {
      info = await this.oc.info();
      projects = dedupeProjects(await this.getProjects(true));
    } catch {
      // report the degraded state below
    }
    let active = null;
    if (this.activeSessionID) {
      try {
        active = await this.getSession(this.activeSessionID, true);
      } catch {
        // the saved session may have been deleted
      }
    }
    await this.send(
      statusMessage({
        info,
        url: this.oc.url,
        projectCount: projects.length,
        activeSession: active
          ? `${sessionLabel(active, this.language)} (${active.id})`
          : this.activeSessionID || "",
        pinEnabled: Boolean(this.config.pin),
        unlocked: this.auth.isUnlocked(),
        envFile: this.config.envFile,
        lang: this.language,
      }),
    );
  }

  async handleStart(sessionID) {
    const now = Date.now();
    const last = this.startTimes.get(sessionID);
    if (last && now - last < 3000) return;
    this.startTimes.set(sessionID, now);
    this.finishedAt.delete(sessionID);
    if (
      !this.isNotificationEnabled("start") &&
      !this.isNotificationEnabled("continuation")
    ) {
      return;
    }

    let context;
    try {
      context = await this.contextFor(sessionID);
    } catch (error) {
      this.startTimes.delete(sessionID);
      this.log.warn?.(`start event for ${sessionID}: ${error.message}`);
      return;
    }
    if (context.session.parentID && !this.config.notifySubagents) {
      this.startTimes.delete(sessionID);
      return;
    }

    let history = [];
    try {
      history = await this.oc.messages(sessionID, { limit: 20 });
    } catch {
      // the notification is still useful without history
    }

    const newest = history[0];
    const latestAssistant = extractLatestAssistantText(history);
    const latestUser = extractLatestUserText(history);
    const userInitiated = newest?.type === "user";
    const continuation = Boolean(latestAssistant) && !userInitiated;
    const notificationType = continuation ? "continuation" : "start";
    if (!this.isNotificationEnabled(notificationType)) return;
    const task = userInitiated
      ? latestUser || latestAssistant
      : latestAssistant || latestUser;
    const asUpdate = continuation && !userInitiated;

    const sessionTitle =
      String(context.session.title ?? "").trim() ||
      makeTitle(task, this.language) ||
      sessionLabel(context.session, this.language);
    await this.sendNotification(
      ({ format, attached, full }) =>
        startMessage({
          project: context.projectName,
          session: sessionTitle,
          task,
          subagent: Boolean(context.session.parentID),
          continuation,
          asUpdate,
          lang: this.language,
          format,
          attached,
          full,
        }),
      {
        project: context.projectName,
        session: sessionTitle,
        title: this.tr(
          continuation ? "start.continueTitle" : "start.title",
        ),
        keyboard: startKeyboard(context.session, this.language),
      },
    );
  }

  async handleFinish(sessionID, outcome, error) {
    const now = Date.now();
    const last = this.finishedAt.get(sessionID);
    if (last && now - last < 3000) return;
    this.finishedAt.set(sessionID, now);
    if (
      !this.isNotificationEnabled("completion") &&
      !this.isNotificationEnabled("subagents")
    ) {
      this.startTimes.delete(sessionID);
      return;
    }

    let context;
    try {
      context = await this.contextFor(sessionID);
    } catch (problem) {
      this.log.warn?.(`finish event for ${sessionID}: ${problem.message}`);
      return;
    }
    if (context.session.parentID && !this.config.notifySubagents) {
      this.startTimes.delete(sessionID);
      return;
    }

    const startedAt = this.startTimes.get(sessionID);
    this.startTimes.delete(sessionID);

    let summary = "";
    try {
      const messages = await this.oc.messages(sessionID, { limit: 12 });
      summary = extractAssistantTextAfterUser(messages);
    } catch {
      // fall back to a generic completion message
    }

    let taskCost = context.session.cost;
    let taskTokens = context.session.tokens;
    let taskSince = null;
    try {
      taskSince = (await this.oc.latestUserTime(sessionID)) || null;
      const since = taskSince || startedAt || null;
      if (since) {
        const tree = await this.oc.sessionTree(sessionID, context.session, {
          since,
        });
        const usage = tree?.activeIDs?.length
          ? await this.oc.sessionUsageSince(tree.activeIDs, since)
          : null;
        if (usage?.messages > 0) {
          taskCost = usage.cost;
          taskTokens = usage.tokens;
        }
      }
    } catch {
      // fall back to the session totals when task usage cannot be read
    }

    const busyAt = Number(context.session.time?.busy) || null;
    const durationStart = startedAt || busyAt || taskSince || null;
    const durationMs = durationStart
      ? Math.max(0, now - durationStart)
      : undefined;

    const activity = await this.activityFor(sessionID);
    const waitingForSubagents =
      outcome === "succeeded" ? activity.waitingChildren : 0;
    const notificationType =
      waitingForSubagents > 0 ? "subagents" : "completion";
    if (!this.isNotificationEnabled(notificationType)) return;
    const maybeQuestion =
      outcome === "succeeded" &&
      waitingForSubagents === 0 &&
      looksLikeQuestion(summary);
    const errorText =
      typeof error === "string"
        ? error
        : error?.message || error?._tag || (error ? JSON.stringify(error) : "");
    const safeSummary = redact(summary, this.secrets);
    const documentBody =
      safeSummary || (outcome === "failed" ? errorText : "");
    const sessionTitle = sessionLabel(context.session, this.language);
    const previewOverhead = completionMessage({
      project: context.projectName,
      session: sessionTitle,
      summary: "",
      outcome,
      error: errorText,
      durationMs,
      cost: taskCost,
      tokens: taskTokens,
      maybeQuestion,
      waitingForSubagents,
      lang: this.language,
      format: this.responseFormat,
      attached: false,
    }).length;
    const fits =
      !documentBody || previewOverhead + documentBody.length <= 3700;
    const attach =
      Boolean(documentBody) &&
      (this.attachFullResult === "always" ||
        (this.attachFullResult === "auto" && !fits));

    const preview = await this.send(
      completionMessage({
        project: context.projectName,
        session: sessionTitle,
        summary: safeSummary,
        outcome,
        error: errorText,
        durationMs,
        cost: taskCost,
        tokens: taskTokens,
        maybeQuestion,
        waitingForSubagents,
        lang: this.language,
        format: this.responseFormat,
        attached: attach,
      }),
      completionKeyboard(
        context.session,
        context.session.projectID,
        maybeQuestion,
        this.language,
      ),
      this.responseFormat === "plain" ? {} : { parseMode: "HTML" },
    );

    if (attach) {
      const document = completionDocument({
        project: context.projectName,
        session: context.session,
        summary: documentBody,
        outcome,
        lang: this.language,
      });
      try {
        await this.tg.sendDocument(
          this.chat(),
          document.filename,
          document.content,
          {
            caption: truncate(
              this.tr("completion.fileCaption", {
                session: sessionLabel(context.session, this.language),
              }),
              900,
            ),
            replyTo: preview?.message_id,
          },
        );
      } catch (error) {
        this.log.warn?.(`Cannot attach result document: ${error.message}`);
        await this.send(
          this.tr("completion.fileError", { error: error.message }),
        ).catch(() => {});
      }
    }
  }

  async onForm(form) {
    if (!form?.id || !form.sessionID) return;
    if (!Array.isArray(form.fields) || form.fields.length === 0) return;
    if (this.formTokens.has(form.id)) return;
    if (!this.isNotificationEnabled("questions")) return;
    let context;
    try {
      context = await this.contextFor(form.sessionID);
    } catch {
      context = {
        session: { id: form.sessionID, projectID: "", title: "" },
        project: null,
        projectName: "—",
      };
    }
    const token = randomToken("f");
    const state = {
      token,
      form,
      context,
      answers: {},
      cursor: 0,
      currentField: null,
      currentFieldIndex: -1,
      selected: new Set(),
      selectedField: null,
      messageID: null,
      settled: false,
    };
    this.forms.set(token, state);
    this.formTokens.set(form.id, token);
    await this.sendNextField(state, { notify: true });
  }

  activeFields(state) {
    return state.form.fields.filter((field) =>
      shouldShowField(field, state.answers),
    );
  }

  nextField(state) {
    while (state.cursor < state.form.fields.length) {
      const field = state.form.fields[state.cursor];
      state.cursor += 1;
      if (shouldShowField(field, state.answers)) return field;
    }
    return null;
  }

  async sendNextField(state, { notify = false } = {}) {
    const field = this.nextField(state);
    if (!field) {
      await this.submitForm(state);
      return;
    }
    state.currentField = field;
    state.currentFieldIndex = state.form.fields.indexOf(field);
    if (field.type === "multiselect" && state.selectedField !== field.key) {
      state.selected = new Set(field.default || []);
      state.selectedField = field.key;
    }

    const active = this.activeFields(state);
    const index = Math.max(0, active.indexOf(field));
    const hasButtons =
      field.type === "boolean" ||
      field.type === "multiselect" ||
      field.type === "external" ||
      (field.type === "string" &&
        Array.isArray(field.options) &&
        field.options.length > 0);
    const needsText = !hasButtons;
    const suffix = needsText
      ? field.required
        ? this.tr("bot.formReplyText")
        : this.tr("bot.formReplyTextOrSkip")
      : "";
    const render = ({ format, attached, full }) =>
      questionMessage({
        project: state.context.projectName,
        session: sessionLabel(state.context.session, this.language),
        form: state.form,
        field,
        index,
        total: active.length,
        lang: this.language,
        format,
        attached,
        full,
        footer: suffix,
      });

    if (needsText) {
      const sent = await this.sendNotification(render, {
        project: state.context.projectName,
        session: sessionLabel(state.context.session, this.language),
        title: this.tr("question.title"),
        forceReply: this.tr("bot.formAnswerPlaceholder"),
        attach: notify,
      });
      state.messageID = sent?.message_id || state.messageID;
      this.pending = {
        kind: "formText",
        token: state.token,
        fieldKey: field.key,
        promptID: sent?.message_id,
      };
      return;
    }

    const keyboard = questionKeyboard(
      state.token,
      field,
      [...state.selected],
      state.currentFieldIndex,
      this.language,
    );
    const sent = await this.sendNotification(render, {
      project: state.context.projectName,
      session: sessionLabel(state.context.session, this.language),
      title: this.tr("question.title"),
      keyboard,
      attach: notify,
    });
    state.messageID = sent?.message_id || state.messageID;
  }

  async onFormCallback(callback, parts) {
    const [token, fieldIndexRaw, action, argument] = parts;
    const state = this.forms.get(token);
    if (!state) {
      await this.safeAnswer(callback.id, this.tr("bot.formAlreadyClosed"));
      return;
    }
    const field = state.currentField;
    if (!field || Number(fieldIndexRaw) !== state.currentFieldIndex) {
      await this.safeAnswer(callback.id, this.tr("bot.formStale"));
      return;
    }

    if (action === "o") {
      const option = field.options?.[Number(argument)];
      if (!option) {
        await this.safeAnswer(callback.id, this.tr("bot.formOptionStale"));
        return;
      }
      await this.safeAnswer(callback.id, this.tr("bot.formAccepted"));
      const checked = validateAnswer(field, option.value, {
        lang: this.language,
      });
      if (!checked.ok) {
        await this.send(`⚠️ ${checked.error}`);
        return;
      }
      await this.applyAnswer(state, field, checked.value);
      return;
    }

    if (action === "b") {
      await this.safeAnswer(callback.id, this.tr("bot.formAccepted"));
      const checked = validateAnswer(field, argument === "1", {
        lang: this.language,
      });
      if (!checked.ok) {
        await this.send(`⚠️ ${checked.error}`);
        return;
      }
      await this.applyAnswer(state, field, checked.value);
      return;
    }

    if (action === "m") {
      const option = field.options?.[Number(argument)];
      if (!option) {
        await this.safeAnswer(callback.id, this.tr("bot.formOptionStale"));
        return;
      }
      if (state.selected.has(option.value)) state.selected.delete(option.value);
      else state.selected.add(option.value);
      await this.safeAnswer(callback.id, this.tr("bot.formUpdated"));
      await this.refreshFieldKeyboard(state, field, state.currentFieldIndex);
      return;
    }

    if (action === "d") {
      const checked = validateAnswer(field, [...state.selected], {
        lang: this.language,
      });
      if (!checked.ok) {
        await this.safeAnswer(callback.id, checked.error);
        return;
      }
      await this.safeAnswer(callback.id, this.tr("bot.formAccepted"));
      await this.applyAnswer(state, field, checked.value);
      return;
    }

    if (action === "x") {
      await this.safeAnswer(callback.id, this.tr("bot.formWriteAnswer"));
      const sent = await this.send(
        this.tr("bot.formCustomPrompt", {
          title: field.title || this.tr("question.generic"),
        }),
        null,
        { forceReply: this.tr("bot.formAnswerPlaceholder") },
      );
      state.messageID = sent?.message_id || state.messageID;
      this.pending = {
        kind: "formText",
        token: state.token,
        fieldKey: field.key,
        promptID: sent?.message_id,
      };
      return;
    }

    if (action === "s") {
      if (field.required) {
        await this.safeAnswer(callback.id, this.tr("bot.formRequiredField"));
        return;
      }
      await this.safeAnswer(callback.id, this.tr("bot.formSkipped"));
      await this.applyAnswer(state, field, undefined);
      return;
    }

    await this.safeAnswer(callback.id, this.tr("bot.formUnknownAction"));
  }

  async refreshFieldKeyboard(state, field, fieldIndex) {
    if (!state.messageID) return;
    try {
      await this.tg.editMessageReplyMarkup(
        this.chat(),
        state.messageID,
        questionKeyboard(
          state.token,
          field,
          [...state.selected],
          fieldIndex,
          this.language,
        ),
      );
    } catch (error) {
      this.log.debug?.(`editMessageReplyMarkup failed: ${error.message}`);
    }
  }

  async answerFormText(text) {
    const pending = this.pending;
    if (!pending || pending.kind !== "formText") return;
    const state = this.forms.get(pending.token);
    if (!state) {
      this.pending = null;
      await this.send(this.tr("bot.formClosedInOpenCode"));
      return;
    }
    const field = state.form.fields.find(
      (item) => item.key === pending.fieldKey,
    );
    if (!field) {
      this.pending = null;
      await this.send(this.tr("bot.formClosedInOpenCode"));
      return;
    }

    if (/^\/(skip|пропустить)$/i.test(text.trim())) {
      if (field.required) {
        await this.send(this.tr("bot.formRequiredField"));
        return;
      }
      this.pending = null;
      await this.applyAnswer(state, field, undefined);
      return;
    }

    const checked = validateAnswer(field, text, {
      allowFreeText: true,
      lang: this.language,
    });
    if (!checked.ok) {
      await this.send(`⚠️ ${checked.error}`);
      return;
    }
    this.pending = null;
    await this.applyAnswer(state, field, checked.value);
  }

  async applyAnswer(state, field, value) {
    if (value !== undefined) state.answers[field.key] = value;
    state.currentField = null;
    state.selected = new Set();
    state.selectedField = null;
    await this.sendNextField(state);
  }

  async submitForm(state) {
    if (state.settled) return;
    state.settled = true;
    try {
      await this.oc.replyForm(state.form.sessionID, state.form.id, state.answers);
      this.cleanupForm(state);
      const lines = Object.entries(state.answers).map(([key, value]) => {
        const field = state.form.fields.find((item) => item.key === key);
        return this.tr("bot.formAnswerLine", {
          field: field?.title || key,
          value: truncate(
            formatFieldAnswer(field, value, this.language),
            200,
          ),
        });
      });
      await this.send(
        lines.length
          ? `${this.tr("bot.formAnswersSent")}\n${lines.join("\n")}`
          : this.tr("bot.formAllSkipped"),
        sessionKeyboard(
          state.context.session,
          state.context.project?.id || state.context.session.projectID || "",
          this.language,
          this.favoriteSessions.has(state.context.session.id),
        ),
      );
    } catch (error) {
      if (error.status === 404 || error.status === 409) {
        this.cleanupForm(state);
        await this.send(this.tr("bot.formClosedInOpenCode"));
        return;
      }
      state.settled = false;
      throw error;
    }
  }

  cleanupForm(state) {
    this.forms.delete(state.token);
    this.formTokens.delete(state.form.id);
    if (this.pending?.kind === "formText" && this.pending.token === state.token) {
      this.pending = null;
    }
  }

  async onFormReplied(data, message = "") {
    const token = this.formTokens.get(data?.id);
    if (!token) return;
    const state = this.forms.get(token);
    const context = state?.context;
    if (state) {
      const settling = state.settled;
      this.cleanupForm(state);
      if (settling) return;
    }
    if (!this.isNotificationEnabled("questions")) return;
    await this.sendNotification(
      ({ format, attached }) =>
        formatNotificationText(
          message || this.tr("bot.formClosedInOpenCode"),
          {
            format,
            lang: this.language,
            attached,
          },
        ),
      {
        project: context?.projectName || "",
        session: context
          ? sessionLabel(context.session, this.language)
          : "",
        title: this.tr("question.title"),
      },
    );
  }

  async onPermission(data) {
    if (!data?.id || !data.sessionID) return;
    if (this.permissionTokens.has(data.id)) return;
    if (!this.isNotificationEnabled("permissions")) return;
    let context;
    try {
      context = await this.contextFor(data.sessionID);
    } catch {
      context = {
        session: { id: data.sessionID, projectID: "", title: "" },
        project: null,
        projectName: "—",
      };
    }
    const token = randomToken("p");
    this.permissions.set(token, {
      request: data,
      context,
    });
    this.permissionTokens.set(data.id, token);
    await this.sendNotification(
      ({ format, attached, full }) =>
        permissionMessage({
          project: context.projectName,
          session: sessionLabel(context.session, this.language),
          request: data,
          subagent: Boolean(context.session.parentID),
          lang: this.language,
          format,
          attached,
          full,
        }),
      {
        project: context.projectName,
        session: sessionLabel(context.session, this.language),
        title: this.tr("permission.title"),
        keyboard: permissionKeyboard(token, this.language),
      },
    );
  }

  async onPermissionCallback(callback, parts) {
    const [token, decision] = parts;
    if (!["once", "always", "reject"].includes(decision)) {
      await this.safeAnswer(callback.id, this.tr("bot.formUnknownAction"));
      return;
    }
    const entry = this.permissions.get(token);
    if (!entry) {
      await this.safeAnswer(callback.id, this.tr("bot.permissionStale"));
      return;
    }
    await this.safeAnswer(callback.id, this.tr("bot.permissionSent"));
    try {
      await this.oc.replyPermission(
        entry.request.sessionID,
        entry.request.id,
        decision,
      );
      this.permissions.delete(token);
      this.permissionTokens.delete(entry.request.id);
      if (callback.message?.message_id) {
        await this.tg
          .editMessageReplyMarkup(
            this.chat(),
            callback.message.message_id,
            emptyKeyboard(),
          )
          .catch(() => {});
      }
    } catch (error) {
      if (error.status === 404 || error.status === 409) {
        this.permissions.delete(token);
        this.permissionTokens.delete(entry.request.id);
        await this.send(this.tr("bot.permissionInactive"));
        return;
      }
      await this.send(
        this.tr("bot.permissionSendError", { error: error.message }),
      );
    }
  }

  async handleEvent(event) {
    try {
      switch (event.type) {
        case "session.execution.started":
          await this.handleStart(event.data?.sessionID);
          break;
        case "session.execution.succeeded":
          await this.handleFinish(event.data?.sessionID, "succeeded");
          break;
        case "session.execution.failed":
          await this.handleFinish(
            event.data?.sessionID,
            "failed",
            event.data?.error,
          );
          break;
        case "session.execution.interrupted":
          await this.handleFinish(event.data?.sessionID, "interrupted");
          break;
        case "form.created":
          await this.onForm(event.data?.form);
          break;
        case "form.replied":
          await this.onFormReplied(event.data);
          break;
        case "form.cancelled":
          await this.onFormReplied(
            event.data,
            this.tr("bot.formCancelledInOpenCode"),
          );
          break;
        case "permission.asked":
          await this.onPermission(event.data);
          break;
        case "permission.replied": {
          const requestID = event.data?.id || event.data?.requestID;
          const token = this.permissionTokens.get(requestID);
          if (token) this.permissions.delete(token);
          this.permissionTokens.delete(requestID);
          break;
        }
        case "session.renamed": {
          const cached = this.sessionCache.get(event.data?.sessionID);
          if (cached && event.data?.title) {
            cached.session = { ...cached.session, title: event.data.title };
          }
          break;
        }
        case "session.deleted": {
          const sessionID = event.data?.sessionID;
          if (!sessionID) break;
          this.sessionCache.delete(sessionID);
          for (const state of [...this.forms.values()]) {
            if (state.form.sessionID === sessionID) this.cleanupForm(state);
          }
          for (const [token, entry] of [...this.permissions.entries()]) {
            if (entry.request.sessionID === sessionID) {
              this.permissions.delete(token);
              this.permissionTokens.delete(entry.request.id);
            }
          }
          break;
        }
        default:
          break;
      }
    } catch (error) {
      this.log.error?.(
        `Event ${event.type} failed: ${redact(error.message, this.secrets)}`,
      );
    }
  }
}

function messageMedia(message) {
  if (Array.isArray(message.photo) && message.photo.length) {
    const photo = message.photo[message.photo.length - 1];
    return [
      {
        fileId: photo.file_id,
        mime: "image/jpeg",
        name: `telegram-${message.message_id}.jpg`,
        size: photo.file_size,
      },
    ];
  }
  if (
    message.document?.file_id &&
    String(message.document.mime_type ?? "").startsWith("image/")
  ) {
    return [
      {
        fileId: message.document.file_id,
        mime: message.document.mime_type,
        name:
          message.document.file_name ||
          `telegram-${message.message_id}`,
        size: message.document.file_size,
      },
    ];
  }
  return [];
}

function extractMessageText(message) {
  if (!message) return "";
  const parts = Array.isArray(message.content)
    ? message.content
        .filter((part) => part?.type === "text" && part.text)
        .map((part) => String(part.text).trim())
        .filter(Boolean)
    : [];
  const text = parts.join("\n").trim();
  if (text) return text;
  if (typeof message.text === "string" && message.text.trim()) {
    return message.text.trim();
  }
  if (typeof message.metadata?.displayText === "string") {
    return message.metadata.displayText.trim();
  }
  return "";
}

function extractUserText(message) {
  if (!message) return "";
  return (
    String(message.text ?? "").trim() ||
    String(message.metadata?.displayText ?? "").trim() ||
    extractMessageText(message)
  );
}

function extractLatestUserText(messages) {
  for (const message of messages || []) {
    if (message?.type !== "user") continue;
    const text = extractUserText(message);
    if (text) return text;
  }
  return "";
}

function extractLatestAssistantText(messages) {
  for (const message of messages || []) {
    if (message?.type !== "assistant") continue;
    const text = extractMessageText(message);
    if (text) return text;
  }
  return "";
}

function extractAssistantTextAfterUser(messages) {
  for (const message of messages || []) {
    if (message?.type === "user") break;
    if (message?.type !== "assistant") continue;
    const text = extractMessageText(message);
    if (text) return text;
  }
  return "";
}


