import { inlineKeyboard } from "./telegram.js";
import {
  LANGUAGES,
  languageLabel,
  localeFor,
  normalizeLanguage,
  t,
} from "./i18n.js";

const DEFAULT_MESSAGE_LIMIT = 3800;

export function oneLine(text, max = 80) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

export function truncate(text, max) {
  const value = String(text ?? "").trim();
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

export function projectLabel(project, aliases = {}, lang = "en") {
  if (!project) return "—";
  const canonical = String(project.canonical ?? "");
  const pathAlias = canonical
    ? Object.keys(aliases).find(
        (key) => normalizePathKey(key) === normalizePathKey(canonical),
      )
    : undefined;
  return (
    aliases[project.id] ||
    aliases[canonical] ||
    (pathAlias ? aliases[pathAlias] : "") ||
    project.name ||
    baseName(canonical) ||
    t(lang, "projects.untitled")
  );
}

function baseName(directory) {
  const value = String(directory ?? "").replace(/[\\/]+$/, "");
  if (!value) return "";
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] || value;
}

export function sessionLabel(session, lang = "en") {
  if (!session) return "—";
  const title = String(session.title ?? "").trim();
  if (title) return title;
  const id = String(session.id ?? "");
  return id
    ? t(lang, "session.fallback", { id: id.slice(0, 10) })
    : t(lang, "session.generic");
}

export function sessionModelLabel(session, lang = "en") {
  const model = session?.model;
  if (!model?.id) return t(lang, "model.none");
  const variant = model.variant ? `, ${model.variant}` : "";
  return `${model.id} (${model.providerID || "—"}${variant})`;
}

export function formatDate(timestamp, lang = "en") {
  if (!timestamp) return "—";
  return new Date(timestamp).toLocaleString(localeFor(lang), {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDuration(ms, lang = "en") {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return t(lang, "duration.hours", { hours, minutes });
  if (minutes) return t(lang, "duration.minutes", { minutes, seconds });
  return t(lang, "duration.seconds", { seconds });
}

export function formatCost(value) {
  if (value == null || !Number.isFinite(Number(value))) return "";
  return `$${Number(value).toFixed(4)}`;
}

export function formatTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function makeTitle(text, lang = "en") {
  const first = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return t(lang, "task.fallback");
  return (
    truncate(first.replace(/^#+\s*/, ""), 70) || t(lang, "task.fallback")
  );
}

export function startMessage({
  project,
  session,
  task,
  subagent = false,
  continuation = false,
  asUpdate = false,
  lang = "en",
  format = "plain",
  attached = false,
  full = false,
}) {
  const title = continuation
    ? t(lang, "start.continueTitle")
    : t(lang, "start.title");
  const limit = full ? Infinity : 1200;
  const lines = [
    messageLine(title + (subagent ? t(lang, "start.subagent") : ""), format),
    messageLine(t(lang, "start.project", { project }), format),
    messageLine(t(lang, "start.session", { session }), format),
  ];
  if (continuation && asUpdate) {
    if (task) {
      lines.push(
        messageLine(t(lang, "start.update", { text: "" }).trimEnd(), format),
        renderMessageBody(task, { format, lang, limit, attached }),
      );
    } else {
      lines.push(messageLine(t(lang, "start.noUpdate"), format));
    }
  } else if (task) {
    lines.push(
      messageLine(t(lang, "start.task", { task: "" }).trimEnd(), format),
      renderMessageBody(task, { format, lang, limit, attached }),
    );
  } else {
    lines.push(messageLine(t(lang, "start.noTask"), format));
  }
  return joinMessageLines(lines, format);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

export function formatMarkdownForTelegram(
  markdown,
  { limit = 2000, lang = "en", attached = true } = {},
) {
  let source = String(markdown ?? "").replace(/\r\n/g, "\n").trim();
  let truncated = false;
  if (source.length > limit) {
    let cut = source.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit * 0.5)) cut = limit;
    source = source.slice(0, cut).trimEnd();
    truncated = true;
  }
  const fenceCount = (source.match(/^```/gm) || []).length;
  if (fenceCount % 2 === 1) source += "\n```";

  const blocks = [];
  source = source.replace(
    /```([^\n`]*)\n([\s\S]*?)```/g,
    (_, language, code) => {
      const languageClass = String(language || "")
        .trim()
        .split(/\s+/)[0]
        .replace(/[^A-Za-z0-9_+-]/g, "");
      const className = languageClass
        ? ` class="language-${languageClass}"`
        : "";
      const token = `\u0000B${blocks.length}\u0000`;
      blocks.push(
        `<pre><code${className}>${escapeHtml(code)}</code></pre>`,
      );
      return token;
    },
  );

  let html = escapeHtml(source);
  const inline = [];
  html = html.replace(/`([^`\n]+)`/g, (_, code) => {
    const token = `\u0000I${inline.length}\u0000`;
    inline.push(`<code>${code}</code>`);
    return token;
  });

  html = html.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  html = html.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  html = html.replace(/__([^_\n]+)__/g, "<b>$1</b>");
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
  html = html.replace(/(^|[^_])_([^_\n]+)_/g, "$1<i>$2</i>");
  html = html.replace(/^&gt;\s?(.*)$/gm, "▎ $1");
  html = html.replace(/^[-*]\s+/gm, "• ");
  html = html.replace(/^---+$/gm, "────────");
  html = html.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label, url) =>
      `<a href="${escapeAttr(url)}">${label}</a>`,
  );

  html = html.replace(/\u0000I(\d+)\u0000/g, (_, index) => {
    return inline[Number(index)] || "";
  });
  html = html.replace(/\u0000B(\d+)\u0000/g, (_, index) => {
    return blocks[Number(index)] || "";
  });
  html = html.replace(/\n{3,}/g, "\n\n");

  if (truncated) {
    html += `\n\n<i>${escapeHtml(
      t(
        lang,
        attached
          ? "completion.previewCut"
          : "completion.previewCutNoFile",
      ),
    )}</i>`;
  }
  return html.trim();
}

function messageLine(text, format) {
  return format === "html" ? escapeHtml(text) : text;
}

function renderMessageBody(
  text,
  { format, lang, limit, attached = false },
) {
  const source = truncate(text, limit);
  if (format === "html") {
    return formatMarkdownForTelegram(source, {
      limit,
      lang,
      attached,
    });
  }
  return source;
}

function joinMessageLines(lines, format) {
  if (format === "code") {
    return `<pre><code class="language-markdown">${escapeHtml(
      lines.join("\n"),
    )}</code></pre>`;
  }
  return lines.join("\n");
}

function sanitizeFilenamePart(value, fallback, maxLength) {
  const text = String(value ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/-\s+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s-]+$/g, "")
    .replace(/^[.\s-]+/g, "");
  return (text || fallback).slice(0, maxLength).trim();
}

function filenameTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
      date.getDate(),
    )}`,
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(
      date.getSeconds(),
    )}`,
  ].join(" ");
}

export function completionDocument({
  project,
  session,
  summary,
  outcome,
  lang = "en",
}) {
  const title = sessionLabel(session, lang);
  const projectPart = sanitizeFilenamePart(project, "Project", 30);
  const sessionPart = sanitizeFilenamePart(title, "Session", 50);
  const filename = `${projectPart}_${sessionPart}_${filenameTimestamp()}.md`;
  const content = [
    `# ${title}`,
    "",
    `- Project: ${project || "—"}`,
    `- Session: ${session?.id || "—"}`,
    `- Outcome: ${outcome || "—"}`,
    `- Finished: ${new Date().toISOString()}`,
    "",
    "---",
    "",
    String(summary || ""),
  ].join("\n");
  return { filename, content };
}

export function notificationDocument({ project, session, title, body }) {
  const projectPart = sanitizeFilenamePart(project, "Project", 30);
  const sessionPart = sanitizeFilenamePart(session, "Session", 50);
  const filename = `${projectPart}_${sessionPart}_${filenameTimestamp()}.md`;
  const content = [
    `# ${title || "Notification"}`,
    "",
    `- Project: ${project || "—"}`,
    `- Session: ${session || "—"}`,
    `- Type: ${title || "—"}`,
    `- Created: ${new Date().toISOString()}`,
    "",
    "---",
    "",
    String(body || ""),
  ].join("\n");
  return { filename, content };
}

export function formatNotificationText(
  text,
  { format = "plain", lang = "en", attached = false } = {},
) {
  const source = String(text ?? "");
  if (format === "html") {
    return formatMarkdownForTelegram(source, {
      limit: DEFAULT_MESSAGE_LIMIT,
      lang,
      attached,
    });
  }
  if (format === "code") {
    return `<pre><code class="language-markdown">${escapeHtml(
      source,
    )}</code></pre>`;
  }
  return source;
}

export function completionMessage({
  project,
  session,
  summary,
  outcome = "succeeded",
  error = "",
  durationMs,
  cost,
  tokens,
  maybeQuestion = false,
  waitingForSubagents = 0,
  lang = "en",
  format = "html",
  attached = true,
}) {
  const waitingCount = Number(waitingForSubagents) || 0;
  const waiting = outcome === "succeeded" && waitingCount > 0;
  const header =
    outcome === "failed"
      ? t(lang, "completion.failed")
      : outcome === "interrupted"
        ? t(lang, "completion.interrupted")
        : waiting
          ? t(lang, "completion.waiting")
          : t(lang, "completion.succeeded");
  const outcomeLabel = waiting
    ? `${t(lang, "completion.waitingOutcome")}${
        waitingCount > 1 ? ` (${waitingCount})` : ""
      }`
    : outcome;
  const meta = [];
  if (durationMs != null) {
    meta.push(`⏱ ${formatDuration(durationMs, lang)}`);
  }
  if (cost != null) {
    const text = formatCost(cost);
    if (text) meta.push(text);
  }
  const input = Number(tokens?.input ?? 0);
  const output = Number(tokens?.output ?? 0);
  if (input + output > 0) {
    meta.push(
      t(lang, "completion.tokens", {
        tokens: formatTokens(input + output),
      }),
    );
  }

  const failed = outcome === "failed" && Boolean(error);
  const summaryLimit = attached ? 3000 : 3800;
  const bodyLabel = failed
    ? t(lang, "completion.errorLabel")
    : summary
      ? t(lang, "completion.summaryLabel")
      : "";
  const bodyText = failed
    ? truncate(error, 1200)
    : summary
      ? String(summary)
      : t(lang, "completion.noSummary");
  const bodyTextShown = truncate(bodyText, summaryLimit);
  const bodyCut = bodyText.length > bodyTextShown.length;
  const cutNote = t(
    lang,
    attached ? "completion.previewCut" : "completion.previewCutNoFile",
  );

  const plainLines = [
    header,
    t(lang, "completion.project", { project }),
    t(lang, "completion.session", { session }),
    t(lang, "completion.outcome", { outcome: outcomeLabel }),
    "",
  ];
  if (bodyLabel) plainLines.push(bodyLabel);
  plainLines.push(bodyTextShown);
  if (bodyCut) {
    plainLines.push("", cutNote);
  } else if (summary && attached) {
    plainLines.push("", t(lang, "completion.attached"));
  }
  if (meta.length) plainLines.push("", meta.join(" · "));
  if (maybeQuestion && !waiting) {
    plainLines.push("", t(lang, "completion.askHint"));
  }

  if (format === "plain") return plainLines.join("\n");
  if (format === "code") {
    return `<pre><code class="language-markdown">${escapeHtml(
      plainLines.join("\n"),
    )}</code></pre>`;
  }

  const lines = [
    `<b>${escapeHtml(header)}</b>`,
    t(lang, "completion.project", {
      project: escapeHtml(project),
    }),
    t(lang, "completion.session", {
      session: escapeHtml(session),
    }),
    t(lang, "completion.outcome", {
      outcome: escapeHtml(outcomeLabel),
    }),
  ];

  if (failed) {
    lines.push(
      `<b>${escapeHtml(bodyLabel)}</b>\n${escapeHtml(bodyTextShown)}`,
    );
  } else if (summary) {
    const preview = formatMarkdownForTelegram(summary, {
      limit: summaryLimit,
      lang,
      attached,
    });
    lines.push(`<b>${escapeHtml(bodyLabel)}</b>\n${preview}`);
    if (!bodyCut && attached) {
      lines.push("", `<i>${escapeHtml(t(lang, "completion.attached"))}</i>`);
    }
  } else {
    lines.push(escapeHtml(bodyText));
  }

  if (meta.length) lines.push("", escapeHtml(meta.join(" · ")));

  if (maybeQuestion && !waiting) {
    lines.push("", escapeHtml(t(lang, "completion.askHint")));
  }
  return lines.join("\n");
}

export function questionMessage({
  project,
  session,
  form,
  field,
  index,
  total,
  lang = "en",
  format = "plain",
  attached = false,
  full = false,
  footer = "",
}) {
  const title = field?.title || field?.key || t(lang, "question.generic");
  const required = field?.required ? " *" : "";
  const progress = total > 1 ? ` (${index + 1}/${total})` : "";
  const formTitle = String(form?.title ?? "").trim();
  const genericTitle =
    !formTitle || /^(questions?|вопрос(ы)?)$/i.test(formTitle);
  const heading = genericTitle ? title : formTitle;
  const descriptionLimit = full ? Infinity : 1200;
  const optionLimit = full ? Infinity : 240;
  const lines = [
    messageLine(t(lang, "question.title"), format),
    messageLine(t(lang, "question.project", { project }), format),
    messageLine(t(lang, "question.session", { session }), format),
    `${messageLine(
      t(lang, "question.heading", { title: "" }).trimEnd(),
      format,
    )} ${renderMessageBody(`${heading}${required}${progress}`, {
      format,
      lang,
      limit: Infinity,
      attached,
    })}`,
  ];
  if (!genericTitle) {
    lines.push(
      "",
      renderMessageBody(`${title}${required}${progress}`, {
        format,
        lang,
        limit: Infinity,
        attached,
      }),
    );
  }
  if (field?.description) {
    lines.push(
      renderMessageBody(field.description, {
        format,
        lang,
        limit: descriptionLimit,
        attached,
      }),
    );
  }

  const options = Array.isArray(field?.options) ? field.options : [];
  if (options.length) {
    const shown = full ? options : options.slice(0, 8);
    lines.push(
      "",
      messageLine(
        field.type === "multiselect"
          ? t(lang, "question.chooseMany")
          : t(lang, "question.chooseOne"),
        format,
      ),
    );
    shown.forEach((option, optionIndex) => {
      lines.push(
        `${optionIndex + 1}. ${renderMessageBody(
          option.label || option.value,
          {
            format,
            lang,
            limit: Infinity,
            attached,
          },
        )}`,
      );
      if (option.description) {
        lines.push(
          `   ${renderMessageBody(oneLine(option.description, optionLimit), {
            format,
            lang,
            limit: optionLimit,
            attached,
          })}`,
        );
      }
    });
    if (options.length > shown.length) {
      lines.push(
        messageLine(
          t(lang, "question.more", {
            count: options.length - shown.length,
          }),
          format,
        ),
      );
    }
    if (field.type === "string" && field.custom) {
      lines.push(
        messageLine(
          t(lang, "question.custom", { number: shown.length + 1 }),
          format,
        ),
      );
    }
  }

  if (field?.type === "external" && field.url) {
    lines.push(
      messageLine(
        t(lang, "question.link", {
          url: truncate(field.url, full ? Infinity : 500),
        }),
        format,
      ),
    );
  }
  if (footer) {
    const text = String(footer);
    if (text.startsWith("\n\n")) lines.push("");
    lines.push(messageLine(text.replace(/^\n+/, ""), format));
  }
  return joinMessageLines(lines, format);
}

export function permissionMessage({
  project,
  session,
  request,
  subagent = false,
  lang = "en",
  format = "plain",
  attached = false,
  full = false,
}) {
  const resourceLimit = full ? Infinity : 180;
  const resources = (request.resources || [])
    .slice(0, full ? undefined : 5)
    .map((item) => `• ${truncate(oneLine(item, resourceLimit), resourceLimit)}`);
  const lines = [
    messageLine(
      t(lang, "permission.title") +
        (subagent ? t(lang, "permission.subagent") : ""),
      format,
    ),
    messageLine(t(lang, "permission.project", { project }), format),
    messageLine(t(lang, "permission.session", { session }), format),
    messageLine(
      t(lang, "permission.action", { action: request.action || "—" }),
      format,
    ),
  ];
  if (resources.length) {
    lines.push(
      messageLine(t(lang, "permission.resources"), format),
      ...resources.map((resource) => messageLine(resource, format)),
    );
  }
  if (request.message) {
    lines.push(
      "",
      renderMessageBody(request.message, {
        format,
        lang,
        limit: full ? Infinity : 600,
        attached,
      }),
    );
  }
  return joinMessageLines(lines, format);
}

export function sessionCard({
  project,
  session,
  lastText = "",
  active = false,
  waitingChildren = 0,
  status = null,
  lang = "en",
  format = "plain",
}) {
  const tokens = session?.tokens || {};
  const totalTokens = Number(tokens.input ?? 0) + Number(tokens.output ?? 0);
  const childCount = Number(waitingChildren) || 0;
  const outcomeLabel = status
    ? `${status.icon} ${status.label}`
    : childCount > 0
      ? active
        ? t(lang, "session.runningChildren", { count: childCount })
        : `${t(lang, "session.waiting")}${
            childCount > 1 ? ` (${childCount})` : ""
          }`
      : active
        ? t(lang, "session.running")
        : session?.outcome || "";
  const lines = [
    messageLine(t(lang, "session.title"), format),
    messageLine(t(lang, "session.project", { project }), format),
    messageLine(
      t(lang, "session.name", { name: sessionLabel(session, lang) }),
      format,
    ),
    messageLine(t(lang, "session.id", { id: session?.id || "—" }), format),
    messageLine(
      t(lang, "session.updated", {
        date: formatDate(session?.time?.updated, lang),
      }),
      format,
    ),
    messageLine(
      t(lang, "session.model", {
        model: sessionModelLabel(session, lang),
      }),
      format,
    ),
    messageLine(
      t(lang, "session.cost", {
        cost: formatCost(session?.cost) || t(lang, "session.unknown"),
        tokens: formatTokens(totalTokens) || t(lang, "session.unknown"),
      }),
      format,
    ),
  ];
  if (outcomeLabel) {
    lines.push(
      messageLine(t(lang, "session.outcome", { outcome: outcomeLabel }), format),
    );
  }
  if (lastText) {
    lines.push(
      messageLine(t(lang, "session.last", { text: "" }).trimEnd(), format),
      renderMessageBody(lastText, {
        format,
        lang,
        limit: 900,
        attached: false,
      }),
    );
  }
  return joinMessageLines(lines, format);
}

export function projectsMessage(projects, aliases = {}, lang = "en") {
  const shown = projects.slice(0, 10);
  const lines = [t(lang, "projects.title"), t(lang, "projects.choose")];
  for (const project of shown) {
    lines.push(
      `• ${projectLabel(project, aliases, lang)} — ${project.canonical || "—"}`,
    );
  }
  if (projects.length > shown.length) {
    lines.push(
      "",
      t(lang, "projects.shown", {
        shown: shown.length,
        total: projects.length,
      }),
    );
  }
  return lines.join("\n");
}

export function sessionsMessage({
  project = "",
  sessions = [],
  projectNames = {},
  favoriteIDs = [],
  mode = "all",
  page = 0,
  pages = 1,
  lang = "en",
}) {
  const favorites = new Set(favoriteIDs);
  const title =
    mode === "favorites"
      ? t(lang, "sessions.favoritesTitle")
      : t(lang, "sessions.allTitle");
  const lines = [
    title + (project ? t(lang, "sessions.projectSuffix", { project }) : ""),
  ];
  if (!sessions.length) {
    lines.push(
      "",
      mode === "favorites"
        ? t(lang, "sessions.noFavorites")
        : t(lang, "sessions.empty"),
    );
  } else {
    for (const session of sessions) {
      const name = projectNames[session.projectID] || "";
      const suffix = name ? ` — ${name}` : "";
      const icon = session.status?.icon || "⚪";
      const star = favorites.has(session.id) ? "⭐ " : "";
      lines.push(
        `${icon} ${star}${sessionLabel(session, lang)}${suffix} (${formatDate(
          session.time?.updated,
          lang,
        )})`,
      );
    }
    if (pages > 1) {
      lines.push(
        "",
        t(lang, "sessions.page", { page: page + 1, pages }),
      );
    }
    lines.push("", t(lang, "sessions.legend1"), t(lang, "sessions.legend2"));
  }
  return lines.join("\n");
}

export function statusMessage({
  info,
  url,
  projectCount,
  activeSession,
  pinEnabled,
  unlocked,
  envFile,
  lang = "en",
}) {
  const pinStatus = pinEnabled
    ? unlocked
      ? t(lang, "status.pinUnlocked")
      : t(lang, "status.pinLocked")
    : t(lang, "status.pinNotSet");
  return [
    t(lang, "status.title"),
    info
      ? t(lang, "status.connected", { version: info.version || "—" })
      : t(lang, "status.disconnected"),
    t(lang, "status.server", { url: url || "—" }),
    t(lang, "status.projects", { count: projectCount ?? "—" }),
    t(lang, "status.active", {
      session: activeSession || t(lang, "status.none"),
    }),
    t(lang, "status.pin", { status: pinStatus }),
    t(lang, "status.language", { language: languageLabel(lang) }),
    t(lang, "status.env", { path: envFile }),
  ].join("\n");
}

export function helpMessage(lang = "en") {
  return [
    t(lang, "help.title"),
    "",
    t(lang, "help.commands"),
    t(lang, "help.menu"),
    t(lang, "help.projects"),
    t(lang, "help.sessions"),
    t(lang, "help.new"),
    t(lang, "help.status"),
    t(lang, "help.settings"),
    t(lang, "help.lock"),
    t(lang, "help.cancel"),
    t(lang, "help.help"),
    t(lang, "help.start"),
    "",
    t(lang, "help.pickProject"),
    "",
    t(lang, "help.continue"),
    t(lang, "help.newTask"),
  ].join("\n");
}

const NOTIFICATION_TYPES = [
  "start",
  "continuation",
  "subagents",
  "questions",
  "permissions",
  "completion",
];

export function notificationEnabled(notifications, type) {
  return notifications?.[type] !== false;
}

function notificationSummary(lang, notifications) {
  return NOTIFICATION_TYPES.map(
    (type) =>
      `${notificationEnabled(notifications, type) ? "✅" : "⬜"} ${t(
        lang,
        `settings.notif.${type}`,
      )}`,
  ).join(" · ");
}

export function settingsMessage(
  lang = "en",
  notifications = {},
  responseFormat = "html",
  attachMode = "always",
) {
  return [
    t(lang, "settings.title"),
    "",
    t(lang, "settings.language", { language: languageLabel(lang) }),
    t(lang, "settings.formatLine", {
      format: t(lang, `format.${responseFormat}`),
    }),
    t(lang, "settings.attachLine", {
      mode: t(lang, `attach.${attachMode}`),
    }),
    t(lang, "settings.notificationsSummary", {
      summary: notificationSummary(lang, notifications),
    }),
    "",
    t(lang, "settings.choose"),
  ].join("\n");
}

export function settingsKeyboard(lang = "en") {
  const current = normalizeLanguage(lang);
  return inlineKeyboard([
    LANGUAGES.map((language) => ({
      text: `${language.code === current ? "✅ " : ""}${language.label}`,
      data: `lang:${language.code}`,
    })),
    [
      {
        text: t(lang, "settings.formatButton"),
        data: "format",
      },
      {
        text: t(lang, "settings.notificationsButton"),
        data: "notifications",
      },
    ],
    [
      {
        text: t(lang, "settings.attachButton"),
        data: "attach",
      },
    ],
  ]);
}

export function formatSettingsMessage(lang = "en") {
  return [
    t(lang, "format.title"),
    "",
    t(lang, "format.choose"),
  ].join("\n");
}

export function formatSettingsKeyboard(
  lang = "en",
  responseFormat = "html",
) {
  const rows = ["html", "code", "plain"].map((format) => [
    {
      text: `${format === responseFormat ? "✅ " : ""}${t(
        lang,
        `format.${format}`,
      )}`,
      data: `fmt:${format}`,
    },
  ]);
  rows.push([{ text: t(lang, "format.back"), data: "settings" }]);
  return inlineKeyboard(rows);
}

export function attachSettingsMessage(lang = "en") {
  return [
    t(lang, "attach.title"),
    "",
    t(lang, "attach.choose"),
  ].join("\n");
}

export function attachSettingsKeyboard(lang = "en", attachMode = "always") {
  const rows = ["always", "auto", "never"].map((mode) => [
    {
      text: `${mode === attachMode ? "✅ " : ""}${t(
        lang,
        `attach.${mode}`,
      )}`,
      data: `att:${mode}`,
    },
  ]);
  rows.push([{ text: t(lang, "attach.back"), data: "settings" }]);
  return inlineKeyboard(rows);
}

export function notificationSettingsMessage(lang = "en", notifications = {}) {
  const lines = [t(lang, "settings.notificationsTitle"), ""];
  for (const type of NOTIFICATION_TYPES) {
    lines.push(
      `${notificationEnabled(notifications, type) ? "✅" : "⬜"} ${t(
        lang,
        `settings.notif.${type}`,
      )}`,
    );
  }
  lines.push("", t(lang, "settings.notificationsHint"));
  return lines.join("\n");
}

export function notificationSettingsKeyboard(lang = "en", notifications = {}) {
  const rows = NOTIFICATION_TYPES.map((type) => [
    {
      text: `${notificationEnabled(notifications, type) ? "✅" : "⬜"} ${t(
        lang,
        `settings.notif.${type}`,
      )}`,
      data: `notif:${type}`,
    },
  ]);
  rows.push([
    { text: t(lang, "settings.notifAll"), data: "notif:all" },
    { text: t(lang, "settings.notifNone"), data: "notif:none" },
  ]);
  rows.push([{ text: t(lang, "settings.back"), data: "settings" }]);
  return inlineKeyboard(rows);
}

export function replyKeyboard(lang = "en") {
  return {
    keyboard: [
      [
        { text: t(lang, "keyboard.projects") },
        { text: t(lang, "keyboard.sessions") },
        { text: t(lang, "keyboard.newTask") },
      ],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: t(lang, "keyboard.placeholder"),
  };
}

export function commandList(lang = "en") {
  return [
    ["menu", "commands.menu"],
    ["projects", "commands.projects"],
    ["sessions", "commands.sessions"],
    ["new", "commands.new"],
    ["status", "commands.status"],
    ["settings", "commands.settings"],
    ["help", "commands.help"],
    ["id", "commands.id"],
    ["cancel", "commands.cancel"],
    ["lock", "commands.lock"],
    ["unlock", "commands.unlock"],
    ["start", "commands.start"],
  ].map(([command, key]) => ({
    command,
    description: t(lang, key),
  }));
}

export function projectsKeyboard(
  projects,
  aliases = {},
  action = "proj",
  lang = "en",
) {
  const shown = projects.slice(0, 10);
  const rows = shown.map((project) => [
    {
      text: `📁 ${oneLine(projectLabel(project, aliases, lang), 40)}`,
      data: `${action}:${project.id}`,
    },
  ]);
  rows.push([
    { text: t(lang, "projects.refresh"), data: "projects" },
    { text: t(lang, "projects.menu"), data: "home" },
  ]);
  return inlineKeyboard(rows);
}

export function sessionsKeyboard({
  sessions = [],
  projectID = "",
  lang = "en",
  mode = "all",
  page = 0,
  pages = 1,
  favoriteIDs = [],
  prevData = "",
  nextData = "",
  switchData = "",
  backData = "projects",
}) {
  const favorites = new Set(favoriteIDs);
  const rows = sessions.map((session) => [
    {
      text: `${session.status?.icon || "⚪"} ${
        favorites.has(session.id) ? "⭐ " : ""
      }${oneLine(sessionLabel(session, lang), 45)}`,
      data: `ses:${session.id}`,
    },
  ]);
  const navigation = [];
  if (prevData) {
    navigation.push({ text: t(lang, "sessions.prevPage"), data: prevData });
  }
  if (nextData) {
    navigation.push({ text: t(lang, "sessions.nextPage"), data: nextData });
  }
  if (navigation.length) rows.push(navigation);
  if (switchData) {
    rows.push([
      {
        text:
          mode === "favorites"
            ? t(lang, "sessions.allButton")
            : t(lang, "sessions.favoritesButton"),
        data: switchData,
      },
    ]);
  }
  rows.push([
    {
      text: t(lang, "sessions.newTask"),
      data: projectID ? `new:${projectID}` : "new",
    },
    { text: t(lang, "sessions.projects"), data: backData },
  ]);
  return inlineKeyboard(rows);
}

export function sessionKeyboard(
  session,
  projectID,
  lang = "en",
  isFavorite = false,
) {
  const rows = [
    [
      {
        text: t(lang, "session.continueButton"),
        data: `cont:${session.id}`,
      },
      {
        text: t(lang, "session.newTaskButton"),
        data: `new:${projectID}`,
      },
    ],
    [
      {
        text: t(lang, "session.modelButton"),
        data: `model:${session.id}`,
      },
      {
        text: t(lang, "session.refreshButton"),
        data: `refresh:${session.id}`,
      },
    ],
    [
      {
        text: t(
          lang,
          isFavorite
            ? "sessions.favoriteRemove"
            : "sessions.favoriteAdd",
        ),
        data: `fav:${session.id}`,
      },
      {
        text: t(lang, "session.projectsButton"),
        data: "projects",
      },
    ],
  ];
  return inlineKeyboard(rows);
}

export function modelProvidersMessage({
  project,
  session,
  current,
  lang = "en",
}) {
  return [
    t(lang, "model.title"),
    t(lang, "model.project", { project }),
    t(lang, "model.session", { session }),
    t(lang, "model.current", { model: current }),
    "",
    t(lang, "model.chooseProvider"),
  ].join("\n");
}

export function modelProvidersKeyboard({
  sessionID,
  providers,
  currentProvider,
  lang = "en",
}) {
  const rows = providers.map((provider, index) => [
    {
      text: `${provider.id === currentProvider ? "✅ " : ""}${
        provider.id
      } (${provider.count})`,
      data: `modelprov:${sessionID}:${index}`,
    },
  ]);
  rows.push([
    { text: t(lang, "model.backToSession"), data: `ses:${sessionID}` },
  ]);
  return inlineKeyboard(rows);
}

export function modelsMessage({
  project,
  session,
  current,
  provider,
  page,
  pages,
  lang = "en",
}) {
  return [
    t(lang, "model.title"),
    t(lang, "model.project", { project }),
    t(lang, "model.session", { session }),
    t(lang, "model.current", { model: current }),
    "",
    t(lang, "model.chooseModel", { provider }),
    t(lang, "model.page", { page: page + 1, pages }),
  ].join("\n");
}

export function modelsKeyboard({
  sessionID,
  providerIndex,
  page,
  pages,
  models,
  lang = "en",
}) {
  const rows = models.map((model) => [
    {
      text: `${model.current ? "✅ " : ""}${oneLine(model.name, 50)}`,
      data: `mc:${model.token}`,
    },
  ]);
  const navigation = [];
  if (page > 0) {
    navigation.push({
      text: t(lang, "model.prev"),
      data: `modelp:${sessionID}:${page - 1}`,
    });
  }
  if (page < pages - 1) {
    navigation.push({
      text: t(lang, "model.next"),
      data: `modelp:${sessionID}:${page + 1}`,
    });
  }
  if (navigation.length) rows.push(navigation);
  rows.push([
    {
      text: t(lang, "model.backToProviders"),
      data: `modelprovs:${sessionID}`,
    },
  ]);
  rows.push([
    { text: t(lang, "model.backToSession"), data: `ses:${sessionID}` },
  ]);
  return inlineKeyboard(rows);
}

export function modelVariantsMessage({
  project,
  session,
  model,
  currentVariant,
  lang = "en",
}) {
  const lines = [
    t(lang, "model.variantsTitle"),
    t(lang, "model.project", { project }),
    t(lang, "model.session", { session }),
    t(lang, "model.variantsModel", { model }),
  ];
  if (currentVariant) {
    lines.push(
      t(lang, "model.currentVariant", { variant: currentVariant }),
    );
  }
  lines.push("", t(lang, "model.chooseVariant"));
  return lines.join("\n");
}

export function modelVariantsKeyboard({
  token,
  variants,
  currentVariant,
  sessionID,
  lang = "en",
}) {
  const rows = variants.map((variant, index) => [
    {
      text: `${variant === currentVariant ? "✅ " : ""}${variant}`,
      data: `mv:${token}:${index}`,
    },
  ]);
  rows.push([
    { text: t(lang, "model.defaultVariant"), data: `mv:${token}:d` },
  ]);
  rows.push([
    { text: t(lang, "model.backToSession"), data: `ses:${sessionID}` },
  ]);
  return inlineKeyboard(rows);
}

export function startKeyboard(session, lang = "en") {
  return inlineKeyboard([
    [{ text: t(lang, "start.openButton"), data: `ses:${session.id}` }],
  ]);
}

export function completionKeyboard(
  session,
  projectID,
  maybeQuestion = false,
  lang = "en",
) {
  const rows = [];
  if (maybeQuestion) {
    rows.push([
      { text: t(lang, "completion.answerButton"), data: `cont:${session.id}` },
    ]);
    rows.push([
      { text: t(lang, "completion.openButton"), data: `ses:${session.id}` },
    ]);
    return inlineKeyboard(rows);
  }
  rows.push([
    { text: t(lang, "completion.openButton"), data: `ses:${session.id}` },
    {
      text: t(lang, "completion.continueButton"),
      data: `cont:${session.id}`,
    },
  ]);
  return inlineKeyboard(rows);
}

export function questionKeyboard(
  token,
  field,
  selected = [],
  fieldIndex = 0,
  lang = "en",
) {
  if (!field) return null;
  const prefix = `q:${token}:${fieldIndex}`;
  const rows = [];
  if (field.type === "boolean") {
    rows.push([
      { text: t(lang, "question.yes"), data: `${prefix}:b:1` },
      { text: t(lang, "question.no"), data: `${prefix}:b:0` },
    ]);
  } else if (field.type === "multiselect") {
    const options = (field.options || []).slice(0, 8);
    for (let index = 0; index < options.length; index += 1) {
      const option = options[index];
      const checked = selected.includes(option.value);
      rows.push([
        {
          text: `${checked ? "✅" : "⬜"} ${index + 1}. ${oneLine(
            option.label || option.value,
            52,
          )}`,
          data: `${prefix}:m:${index}`,
        },
      ]);
    }
    rows.push([{ text: t(lang, "question.done"), data: `${prefix}:d` }]);
  } else if (field.type === "string" && Array.isArray(field.options) && field.options.length) {
    const options = field.options.slice(0, 8);
    for (let index = 0; index < options.length; index += 1) {
      const option = options[index];
      rows.push([
        {
          text: `${index + 1}. ${oneLine(option.label || option.value, 52)}`,
          data: `${prefix}:o:${index}`,
        },
      ]);
    }
    if (field.custom) {
      rows.push([
        {
          text: `${options.length + 1}. ${t(lang, "question.customButton")}`,
          data: `${prefix}:x`,
        },
      ]);
    }
  } else if (field.type === "external") {
    rows.push([
      { text: t(lang, "question.continueButton"), data: `${prefix}:s` },
    ]);
    return inlineKeyboard(rows);
  } else {
    return null;
  }

  if (!field.required && field.type !== "multiselect") {
    rows.push([{ text: t(lang, "question.skip"), data: `${prefix}:s` }]);
  }
  return inlineKeyboard(rows);
}

export function permissionKeyboard(requestID, lang = "en") {
  return inlineKeyboard([
    [
      { text: t(lang, "permission.allow"), data: `perm:${requestID}:once` },
      { text: t(lang, "permission.always"), data: `perm:${requestID}:always` },
    ],
    [{ text: t(lang, "permission.reject"), data: `perm:${requestID}:reject` }],
  ]);
}

export function validateAnswer(
  field,
  raw,
  { allowFreeText = false, lang = "en" } = {},
) {
  if (!field) return { ok: false, error: t(lang, "validation.stale") };
  const required = Boolean(field.required);

  if (field.type === "multiselect") {
    const values = Array.isArray(raw)
      ? raw
      : String(raw ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
    if (required && values.length === 0) {
      return { ok: false, error: t(lang, "validation.selectAtLeastOne") };
    }
    const minimum = Number(field.minItems);
    const maximum = Number(field.maxItems);
    if (Number.isFinite(minimum) && values.length < minimum) {
      return {
        ok: false,
        error: t(lang, "validation.selectAtLeast", { count: minimum }),
      };
    }
    if (Number.isFinite(maximum) && values.length > maximum) {
      return {
        ok: false,
        error: t(lang, "validation.selectAtMost", { count: maximum }),
      };
    }
    return { ok: true, value: values };
  }

  if (field.type === "boolean") {
    if (typeof raw === "boolean") return { ok: true, value: raw };
    const value = String(raw ?? "").trim().toLowerCase();
    if (["да", "yes", "true", "1", "✅"].includes(value)) {
      return { ok: true, value: true };
    }
    if (["нет", "no", "false", "0", "❌"].includes(value)) {
      return { ok: true, value: false };
    }
    return { ok: false, error: t(lang, "validation.yesNo") };
  }

  if (field.type === "number" || field.type === "integer") {
    const text = String(raw ?? "").trim().replace(",", ".");
    if (!text) {
      return required
        ? { ok: false, error: t(lang, "validation.number") }
        : { ok: true, value: undefined };
    }
    const value = Number(text);
    if (!Number.isFinite(value)) {
      return { ok: false, error: t(lang, "validation.number") };
    }
    if (field.type === "integer" && !Number.isInteger(value)) {
      return { ok: false, error: t(lang, "validation.integer") };
    }
    const minimum = Number(field.minimum);
    const maximum = Number(field.maximum);
    if (Number.isFinite(minimum) && value < minimum) {
      return {
        ok: false,
        error: t(lang, "validation.min", { value: minimum }),
      };
    }
    if (Number.isFinite(maximum) && value > maximum) {
      return {
        ok: false,
        error: t(lang, "validation.max", { value: maximum }),
      };
    }
    return { ok: true, value };
  }

  const value = String(raw ?? "").trim();
  if (!value) {
    return required
      ? { ok: false, error: t(lang, "validation.answerRequired") }
      : { ok: true, value: undefined };
  }
  if (
    Number.isFinite(Number(field.minLength)) &&
    value.length < Number(field.minLength)
  ) {
    return {
      ok: false,
      error: t(lang, "validation.minLength", { count: field.minLength }),
    };
  }
  if (
    Number.isFinite(Number(field.maxLength)) &&
    value.length > Number(field.maxLength)
  ) {
    return {
      ok: false,
      error: t(lang, "validation.maxLength", { count: field.maxLength }),
    };
  }
  if (field.pattern) {
    try {
      if (!new RegExp(field.pattern).test(value)) {
        return { ok: false, error: t(lang, "validation.format") };
      }
    } catch {
      // an invalid pattern is the server's problem, not the answer's
    }
  }
  if (
    !allowFreeText &&
    Array.isArray(field.options) &&
    field.options.length > 0 &&
    !field.options.some((option) => option.value === value)
  ) {
    return { ok: false, error: t(lang, "validation.chooseOption") };
  }
  return { ok: true, value };
}

export function shouldShowField(field, answers = {}) {
  if (!field || field.hidden) return false;
  if (!Array.isArray(field.when) || field.when.length === 0) return true;
  return field.when.every((condition) => {
    const actual = answers[condition.key];
    const equal = Array.isArray(actual)
      ? actual.includes(condition.value)
      : actual === condition.value;
    return condition.op === "neq" ? !equal : equal;
  });
}

export function formatAnswerValue(value, lang = "en") {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") {
    return value ? t(lang, "answer.yes") : t(lang, "answer.no");
  }
  if (value == null) return "—";
  return String(value);
}

export function formatFieldAnswer(field, value, lang = "en") {
  const options = Array.isArray(field?.options) ? field.options : [];
  if (!options.length) return formatAnswerValue(value, lang);
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((item) => {
      const index = options.findIndex((option) => option.value === item);
      return index >= 0
        ? `${index + 1}. ${options[index].label || item}`
        : formatAnswerValue(item, lang);
    })
    .join(", ");
}

export function looksLikeQuestion(text) {
  const value = String(text ?? "").trim();
  if (!value) return false;
  const tail = value.slice(-500).trimEnd().replace(/[`"')\]]+$/, "").trimEnd();
  return /\?$/.test(tail);
}

export function redact(text, secrets = []) {
  let value = String(text ?? "");
  const ordered = [...new Set(secrets.filter((secret) => secret && String(secret).length >= 4))].sort(
    (a, b) => String(b).length - String(a).length,
  );
  for (const secret of ordered) {
    value = value.split(String(secret)).join("***");
  }
  value = value.replace(/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, "***");
  value = value.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "***");
  value = value.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "***");
  value = value.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "***");
  value = value.replace(/(authorization:\s*bearer\s+)\S+/gi, "$1***");
  return value;
}

export function splitMessage(text, limit = DEFAULT_MESSAGE_LIMIT) {
  let rest = String(text ?? "");
  const chunks = [];
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit * 0.4)) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks.length ? chunks : [""];
}

export function dedupeProjects(projects) {
  const byPath = new Map();
  for (const project of projects) {
    const canonical = String(project?.canonical ?? "").trim();
    const key = canonical
      ? normalizePathKey(canonical)
      : `id:${project?.id ?? "unknown"}`;
    const current = byPath.get(key);
    if (!current || projectTimestamp(project) > projectTimestamp(current)) {
      byPath.set(key, project);
    }
  }
  return [...byPath.values()];
}

function normalizePathKey(value) {
  const text = String(value ?? "").trim();
  return process.platform === "win32" ? text.toLowerCase() : text;
}

function projectTimestamp(project) {
  return Number(project?.time?.updated ?? project?.time?.created ?? 0);
}

export function sortProjects(projects) {
  return [...projects].sort((a, b) => {
    return projectTimestamp(b) - projectTimestamp(a);
  });
}
