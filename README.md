# OpenCode Telegram Bridge

**Russian version:** [README.ru.md](README.ru.md)

An always-on, zero-dependency Node.js sidecar that mirrors OpenCode sessions into
Telegram and lets the owner drive them from chat. It is a standalone service: it
only needs a running OpenCode background service and a Telegram bot.

**Status:** v0.1.0, tested against OpenCode 2.3.2 on Windows.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

```text
OpenCode service  ⇄  Node.js bridge  ⇄  Telegram Bot API
```

## Contents

- [Why this exists](#why-this-exists)
- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running](#running)
- [Commands and UI](#commands-and-ui)
- [Task workflows](#task-workflows)
- [Response formatting and attachments](#response-formatting-and-attachments)
- [Favorite sessions](#favorite-sessions)
- [Session statuses](#session-statuses)
- [Notifications](#notifications)
- [Model selection](#model-selection)
- [Files and images](#files-and-images)
- [Security](#security)
- [How events are handled](#how-events-are-handled)
- [Project and session filtering](#project-and-session-filtering)
- [State and files](#state-and-files)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [File layout](#file-layout)
- [Contributing](#contributing)
- [License](#license)

## Why this exists

OpenCode is a local agent runtime with a rich desktop UI and an HTTP/SSE API.
This bridge adds a Telegram control room on top of that API:

- you get a message when a task starts, asks a question, needs a permission, or
  finishes;
- you can answer questions and approve permissions directly from Telegram;
- you can browse projects and sessions, start new sessions, continue an existing
  session with a follow-up, and switch the model;
- you can attach images to a task;
- you can choose how responses are formatted and whether a full `.md` file is
  attached.

The bridge uses Telegram **long polling**, so it never opens an inbound HTTP
port. It uses only Node.js built-ins and has **no npm runtime dependencies**.

## Features

- Session lifecycle notifications: start, automatic continuation, completion,
  failure, interruption, and optional subagent start/finish events.
- Actionable forms: single choice, multi-select, boolean, text, custom answer,
  skip, and external links.
- Actionable tool permissions: allow once, always allow, or reject.
- Project and session browser with favorites, pagination, status icons, and
  session cards.
- Create a new session in a project or continue the currently selected session.
- Per-session model picker with provider, model, and variant selection.
- Telegram image and document attachments, including photo albums, passed to
  OpenCode as base64 `files`.
- Three response formats: formatted HTML, whole-message Markdown code block, or
  plain text.
- Optional full-result `.md` attachments for every notification type.
- Bilingual UI: English by default, Russian available in settings.
- Six independently switchable notification types.
- Owner allowlist, private-chat-only access, optional PIN, and outbound text
  redaction.

## Architecture

```text
Telegram Bot API
   ⇅  long polling (no inbound ports)
bridge.js  (Node.js 18.16+, no runtime dependencies)
   ├── config.js    env loading, paths, AuthGate, state persistence
   ├── opencode.js  OpenCode HTTP and SSE client
   ├── telegram.js  Telegram Bot API client
   ├── ui.js        messages, keyboards, formatting, validation
   ├── i18n.js      English/Russian strings
   └── bot.js       commands, forms, permissions, notifications
   ⇅  HTTP + SSE, Basic auth from service.json
OpenCode background service
   GET  /api/event
   GET  /api/info
   GET  /api/project
   GET  /api/model
   GET  /api/session
   GET  /api/session/active
   GET  /api/session/{id}
   GET  /api/session/{id}/message
   GET  /api/session/{id}/form
   GET  /api/session/{id}/permission
   POST /api/session
   POST /api/session/{id}/prompt
   POST /api/session/{id}/model
   POST /api/session/{id}/form/{formID}/reply
   POST /api/session/{id}/permission/{requestID}/reply
```

The OpenCode URL and password are discovered from
`~/.local/state/opencode/service.json` (on Windows:
`%USERPROFILE%\.local\state\opencode\service.json`). If OpenCode restarts and
changes its port or password, the bridge re-reads the file when it reconnects.
`OPENCODE_URL` and `OPENCODE_PASSWORD` can override discovery.

## Requirements

- Node.js **18.16 or newer** (`fetch`, `FormData`, `Blob`, and `AbortSignal`).
- A running OpenCode service (tested with 2.3.2).
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- Your numeric Telegram ID from [@userinfobot](https://t.me/userinfobot).
- The same local user account that runs OpenCode, so the bridge can read the
  OpenCode service file and state.

## Installation

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Get your numeric Telegram ID from [@userinfobot](https://t.me/userinfobot).
3. Open the bot and press **Start**. A bot cannot message a user first.
4. Create the environment file:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode" | Out-Null
Copy-Item .env.example "$env:USERPROFILE\.config\opencode\telegram.env"
notepad "$env:USERPROFILE\.config\opencode\telegram.env"
```

Minimum contents:

```dotenv
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_OWNER_ID=123456789
TELEGRAM_PIN=1234
TELEGRAM_PROJECT_ALIASES={"my-project-id":"My Project"}
```

`TELEGRAM_PIN` is optional. If it is omitted, access is limited to the owner
ID.

5. Check connectivity without starting the bot:

```powershell
node bridge.js --check
```

Expected output when both sides are reachable:

```text
OpenCode: 2.3.2 at http://127.0.0.1:28894
Projects: 6 (4 unique paths)
Recent sessions: 5
Result: OpenCode OK · Telegram OK
```

6. Start the bridge:

```powershell
node bridge.js
```

or, from the repository root:

```powershell
npm start
```

7. Send `/start` to the bot.

### Autostart on Windows

Create a Task Scheduler task:

- Trigger: **At log on**.
- Action: the full path to `node.exe` (find it with `where.exe node`) with the
  full path to this repository's `bridge.js` as the argument, for example
  `C:\Tools\OpenCodeTelegramBridge\bridge.js`.
- Start in: the repository root, for example
  `C:\Tools\OpenCodeTelegramBridge`.
- Run only for the same Windows user that runs OpenCode.

Do not run two bridges with the same bot token. Telegram returns
`409 Conflict` from `getUpdates`.

## Configuration

The bridge reads process environment variables first, then the env file. The
default env file is `~/.config/opencode/telegram.env`; override it with
`TELEGRAM_ENV_FILE`.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | — | Bot token from BotFather. |
| `TELEGRAM_OWNER_ID` | yes | — | Numeric Telegram ID of the only allowed user. |
| `TELEGRAM_PIN` | no | empty | Optional second factor for actions. Empty means owner-ID-only access. |
| `TELEGRAM_UNLOCK_MINUTES` | no | `720` | How long `/unlock` stays valid. |
| `TELEGRAM_PROJECT_ALIASES` | no | `{}` | JSON object mapping project IDs or canonical paths to display names. |
| `TELEGRAM_API_BASE` | no | `https://api.telegram.org` | Telegram Bot API base URL. |
| `TELEGRAM_LOG_LEVEL` | no | `info` | `error`, `warn`, `info`, or `debug`. |
| `TELEGRAM_STATE_FILE` | no | `~/.local/state/opencode-telegram-bridge/state.json` | Persistent state file. |
| `TELEGRAM_ENV_FILE` | no | `~/.config/opencode/telegram.env` | Env file location. |
| `OPENCODE_URL` | no | auto | OpenCode service URL override. |
| `OPENCODE_PASSWORD` | no | auto | OpenCode Basic-auth password override. |
| `OPENCODE_STATE_FILE` | no | `~/.local/state/opencode/service.json` | OpenCode service discovery file. |
| `NOTIFY_SUBAGENTS` | no | `false` | Send start/finish notifications for subagent sessions too. |

Paths honor `XDG_STATE_HOME` and `XDG_CONFIG_HOME` when they are set.

## Running

```text
Usage: node bridge.js [--check] [--help]

  --check   check OpenCode connectivity and Telegram configuration, do not poll
  --help    show this help
```

`--check` verifies the env file, OpenCode service, Telegram token, owner ID, and
PIN presence. It exits with code `1` when OpenCode or Telegram is not ready and
`2` on a configuration error.

The bridge handles `SIGINT` and `SIGTERM` and closes both the Telegram poll loop
and the OpenCode SSE stream cleanly.

## Commands and UI

| Command | Purpose |
| --- | --- |
| `/menu` | Show the persistent three-button keyboard. Sends a short `⌨️` service message. |
| `/projects` | List OpenCode projects. |
| `/sessions` | Favorite sessions; all other sessions live under **All sessions**. |
| `/new` | Start a new session: choose a project, review or change the model, enter a session name, then the task text. |
| `/status` | Show the OpenCode version, selected session, PIN state, and language. |
| `/settings` | Language, response format, attachments, and notification types. |
| `/lock` | Lock actions immediately. |
| `/unlock <PIN>` | Unlock actions for `TELEGRAM_UNLOCK_MINUTES`. |
| `/cancel` | Cancel the current input flow. |
| `/id` | Show your Telegram ID. |
| `/help` | Show help and the persistent keyboard. |
| `/start` | Menu, help, and the persistent keyboard (last in the native menu). |

The persistent keyboard has three buttons:

```text
📁 Projects     🕘 Sessions     ➕ New session
```

- The buttons send normal text; the bridge recognizes the localized labels and
  performs the action.
- The keyboard is localized. Changing the language in `/settings` replaces it.
- Other actions (`status`, `settings`, `help`, `id`, `cancel`, `lock`, `unlock`)
  are available through commands and the native Telegram command menu.
- Native command menus are installed for English and Russian with
  `setMyCommands`; the Menu button opens the command list.
- Telegram cannot combine a reply keyboard and inline buttons in one message.
  `/start` therefore sends the reply keyboard, while inline buttons are used for
  choices: projects, sessions, session cards, settings, and form options.

A session card shows the project, session name, ID, update time, current model,
last text, and cost. The first cost figure is the total for that session and all
of its subagent sessions. The **Today** line below it shows today's cost and
tokens for the same session tree, calculated from assistant-message usage since
local midnight.

`/menu` needs a non-empty message to install the reply keyboard. Telegram rejects
empty or invisible text, so the bridge sends a small `⌨️` message and keeps it.
Deleting that message also removes the keyboard.

## Task workflows

### Start and continuation

When a session starts (`session.execution.started`) the bridge sends the project,
session title, and task text. If the session is continuing automatically after
subagents, the message is **Continuing the task** and shows the latest assistant
text instead of repeating the original task.

### New session vs. continue

- **New session** creates a separate session in the selected project. The flow is:
  choose a project → review the project's default model and optionally change it
  → enter the session name → send the task text. The chosen model is applied
  before the first prompt.
- **Continue** in a session card sends a follow-up to the same session.
- The completion card has **Open session** and **Continue**: Continue selects
  that session and immediately asks for the next message.
- The selected session is persisted. Plain text with no pending flow is sent to
  the selected session; start/finish notifications from other sessions do not
  reset it.

### Questions

`form.created` produces a Telegram message with:

- the project and session;
- the form title and field title;
- numbered options and descriptions;
- a custom-answer option when the field allows it;
- Skip for optional fields.

Supported field types include `string`, boolean, single choice, multi-select,
custom text, and external links. Multi-select buttons toggle and then a **Done**
button submits the set. Answers are sent back with
`POST /api/session/{id}/form/{formID}/reply`.

Form state lives in memory. After a bridge restart, old form buttons report that
the question is stale; answer it in OpenCode or wait for a new event.

### Permissions

`permission.asked` produces a message with **Allow once**, **Always**, and
**Reject** buttons. The decision is sent to
`POST /api/session/{id}/permission/{requestID}/reply`. If OpenCode reports that
the request is already gone, the keyboard is removed and the bot reports it as
inactive.

## Response formatting and attachments

Open `/settings` to configure both:

**🎨 Format**

1. **Formatted (HTML)** — headings, bold/italic text, inline code, fenced code
   blocks, lists, quotes, and links. User and agent text is escaped, so raw HTML
   cannot break the message. Service labels and session IDs are escaped too.
2. **Markdown code block** — the whole message in one `<pre><code>` block.
3. **Plain text** — the original text without HTML.

**📄 Full result**

1. **Always** — attach a `.md` file to every notification.
2. **Only if it does not fit** — attach when the notification text was truncated
   or exceeds the Telegram message budget.
3. **Never** — send only the message.

The defaults are **Formatted (HTML)** and **Always**. Both settings are stored in
`state.responseFormat` and `state.attachFullResult`.

The format applies to all notifications and to the **Last:** block in a session
card. The attachment setting applies to all notification types. A session card is
not a notification, so it never attaches a file.

What the file contains:

- completion: the full assistant answer;
- failed completion: the error text;
- start, continuation, subagents, questions, permissions, and form-closed
  notices: the full notification text without truncation;
- the file is sent as a reply to the chat message;
- the filename is `Project_Session_YYYY-MM-DD HH-MM-SS.md` in local time, with
  Windows-forbidden characters replaced by `-`.

The chat preview is length-limited. When it is cut, the message says that the
full text is in the attached file, or simply that it was truncated when
attachments are disabled. Markdown tables remain plain text in the preview and
are preserved as Markdown in the `.md` file.

The first question of a form can attach a file; later field prompts are formatted
but do not attach a new file.

## Favorite sessions

- A session card has **☆ Favorite** / **⭐ In favorites**. Pressing it adds or
  removes the session.
- Favorites are stored in `state.favoriteSessions` and survive restarts.
- `/sessions` shows only favorites across all projects.
- A project session list shows favorites first.
- **📚 All sessions** opens the full list with favorites marked `⭐`.
- Lists are paginated, 10 sessions per page, both globally and per project.
- If there are no favorites yet, the bot shows a hint and an **All sessions**
  button.

## Session statuses

Session lists show the last known state:

| Icon | Status |
| --- | --- |
| ✅ | completed (`succeeded`) |
| ❌ | failed |
| ⏹ | interrupted |
| ❓ | waiting for a form answer |
| 🔐 | waiting for a tool permission |
| 🔄 | running |
| ⏳ | waiting for subagents |
| ⚪ | no data / idle |

Priority: form question → permission → running → waiting for subagents → session
outcome. Status is read from `GET /api/session/active`,
`GET /api/session/{id}/form`, and `GET /api/session/{id}/permission`. A short
legend is shown under the list in the selected language.

## Notifications

`/settings` → **🔔 Notifications** has six independent toggles:

| Toggle | What it controls |
| --- | --- |
| Started working | First start of a task. |
| Continuing the task | Automatic continuation after subagents, not a new user prompt. |
| Waiting for subagents | Parent session finished its step but children are still running. |
| Questions | Forms and form-closed notices. |
| Permissions | Tool permission requests. |
| Completion | Final success, failure, or interruption. |

All six are enabled by default. **Enable all** and **Disable all** shortcuts are
available. Settings are stored in `state.notifications`.

Disabling a type stops chat messages but does not hide the state: session cards
and lists still show `❓`, `🔐`, `⏳`, `🔄`, `✅`, `❌`, or `⏹`.

Subagent start/finish notifications are controlled separately by
`NOTIFY_SUBAGENTS=false`. Subagent questions and permissions are still delivered
because they can block work; their messages include a **subagent** marker.

## Model selection

A session card has **🧠 Model**:

1. choose a provider (`commandcode`, `opencode`, `routerai`, ...);
2. choose a model, 10 per page;
3. if the model has variants, choose one or **Default**.

The current model is marked `✅`. The selection is applied to subsequent turns
with `POST /api/session/{id}/model` and stored by OpenCode. Models come from
`GET /api/model` for the project directory.

A new session starts on OpenCode's default model. After it is created, the model
can be changed from the card and subsequent tasks use the new model.

> **OpenCode Desktop 2.3.2 note:** after a model is changed from Telegram while
> the session is open in Desktop, the composer selector at the bottom can keep
> showing the previous model until the session is reopened. The session itself
> uses the new model; the Telegram session card shows the authoritative value.
> Reopen the session to refresh the composer. In Desktop's steer mode, the client
> may switch the session back to the model selected in its composer, so refresh
> the session before steering from Desktop.

## Files and images

Files and images are accepted in two flows:

- after **New session**, together with the task text;
- after **Continue**, together with the follow-up.

Behavior:

- a Telegram photo or document caption becomes the task text; without a caption
  the bridge sends a default instruction to analyze the image or review the
  file;
- Telegram photos, image documents, and arbitrary document files are accepted;
- photo albums are buffered into one task/message; documents are attached
  individually;
- the limit is 20 MB per attachment (Telegram Bot API download and OpenCode
  prompt limits);
- attachments are sent as `files` with
  `data:<mime>;base64,...` to `POST /api/session/{id}/prompt`;
- without an active New session/Continue flow, a file is rejected with a hint.

Images are native multimodal input when the selected model supports them. Other
files are delivered to OpenCode as attachments; whether the agent can interpret
the content depends on the file type, the model, and OpenCode's extraction
support. Plain text, Markdown, code, and PDFs are the most useful formats;
arbitrary binary files may be stored but not understood by the model.

## Security

- **One owner.** Updates and callbacks from any other `from.id` are silently
  ignored. Group chats are ignored even if the owner is a member.
- **Private chats only.** The owner ID alone is not enough; the chat type must be
  `private`.
- **Optional PIN.** If `TELEGRAM_PIN` is set, actions require `/unlock` first.
  Five wrong attempts lock PIN input for 15 minutes. The unlock state is in
  memory and resets when the bridge restarts. Notifications still arrive in the
  owner's private chat.
- **Long polling.** No inbound HTTP port is opened. Only outbound traffic to
  `api.telegram.org` and the local OpenCode service is used.
- **Secrets outside the repository.** The bot token and OpenCode password live
  in `~/.config/opencode/telegram.env`, not in git. Restrict the file ACL:

```powershell
icacls "$env:USERPROFILE\.config\opencode\telegram.env" /inheritance:r /grant:r "$env:USERNAME:(R,W)"
```

- **Outbound redaction.** The configured bot token, OpenCode password, PIN, and
  common token patterns (`sk-…`, `ghp_…`, `xox…`, `Bearer …`) are replaced with
  `***` in outgoing text and logs.
- **Trust boundary.** The bridge has full access to OpenCode sessions. Run it as
  the same unprivileged Windows user as OpenCode and do not expose the OpenCode
  API to the network. A compromised Telegram account can read notifications; the
  PIN protects actions. If the token leaks, revoke it in BotFather.

## How events are handled

| Scenario | OpenCode event | Bridge behavior |
| --- | --- | --- |
| Task started | `session.execution.started` | Reads the session and the latest user message. |
| Form question | `form.created` | Renders fields, options, and answer controls. |
| Permission request | `permission.asked` | Sends allow-once / always / reject buttons. |
| Completion | `session.execution.succeeded` | Shows the latest assistant text and stats for the current task: the latest user message and its subagents, not the session lifetime. |
| Failure | `session.execution.failed` | Shows the error and stats. |
| Interruption | `session.execution.interrupted` | Marks the session as interrupted. |
| Question closed in OpenCode | `form.replied`, `form.cancelled` | Marks the Telegram flow as closed; old buttons report stale. |
| Permission answered elsewhere | `permission.replied` | Removes the in-memory request. |
| Session renamed | `session.renamed` | Updates the cached title. |
| Session deleted | `session.deleted` | Cleans cached sessions, forms, and permissions. |

`waiting sub agents` is determined from `GET /api/session/active` and the
`parentID` chain. A subagent can be a grandchild, not only a direct child.

## Project and session filtering

OpenCode can keep several project records with the same `canonical` path (a
legacy `global` record, old IDs after upgrades). The bridge groups such records
by path and shows the newest one, so the list contains one
`C:\Projects\Demo` instead of several duplicates.

Project sessions are requested by `directory`, not by a specific `projectID`,
with `parentID=null`. This merges sessions from duplicate project records and
hides subagent sessions, matching the OpenCode session tree. Subagent questions
and permissions are still delivered.

## State and files

Default state file:

```text
%USERPROFILE%\.local\state\opencode-telegram-bridge\state.json
```

| Key | Meaning |
| --- | --- |
| `offset` | Last processed Telegram update offset. |
| `language` | `en` or `ru`. |
| `notifications` | Per-type notification toggles. |
| `favoriteSessions` | Array of favorite session IDs. |
| `activeSessionID` | Currently selected session. |
| `responseFormat` | `html`, `code`, or `plain`. |
| `attachFullResult` | `always`, `auto`, or `never`. |

The file is written after each Telegram update using a temporary file and
rename. Do not delete it unless you want Telegram to replay recent commands.

`--check` prints the env file and OpenCode service file paths. The bridge never
stores the bot token or OpenCode password in the state file.

## Testing

The test suite uses fake Telegram and OpenCode clients and never touches the
network. It currently contains 115 tests.

```powershell
npm test
```

Equivalent:

```powershell
node --test test
```

Current coverage includes authentication, PIN lockout, message formatting,
HTML/code/plain rendering, all notification types and attachments, forms,
permissions, task creation, image attachments, favorites, model selection, and
old assistant-message filtering.

Connectivity check:

```powershell
npm run check
```

or:

```powershell
node bridge.js --check
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `--check` says `OpenCode: ERROR` | Is OpenCode running? Does `~/.local/state/opencode/service.json` exist? |
| `--check` says `Telegram NOT CONFIGURED` | Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_ID`. |
| Bot is silent | Press Start in the bot, verify the owner ID, and make sure only one bridge is running. |
| `409 Conflict` from Telegram | Another process polls the same token. Stop the duplicate bridge. |
| `401 Unauthorized` from OpenCode | The password in `service.json` changed. Restart the bridge so it re-reads the file. |
| Form buttons say "stale" after restart | Form state is in memory. Answer the form in OpenCode or wait for a new one. |
| Model selector in Desktop shows the old model | Reopen the session. The session model and Telegram prompts use the new value. |
| Need to reset the Telegram offset | Stop the bridge and remove `state.json`; old commands may be replayed. |

Logs are written to stdout/stderr. `TELEGRAM_LOG_LEVEL=debug` adds more detail.
The bridge redacts configured secrets before logging.

## Known limitations

- Events are not replayed. If the bridge was offline, it will not send the start
  and finish messages for that run.
- Forms and permissions live in memory. After a restart, old inline buttons
  cannot be answered.
- Text, images, and Telegram document files are supported. Voice, video, audio,
  and stickers are not forwarded. Whether a document is useful depends on its
  type, the model, and OpenCode's extraction support.
- One owner only; there are no roles or multi-user access controls.
- The completion summary is the latest assistant text, not a separate
  summarization pass. The chat preview can be truncated; the `.md` attachment
  contains the full text.
- The PIN is stored in plaintext in the local env file; the file ACL is the
  protection boundary.
- OpenCode Desktop 2.3.2 may keep a stale model label in its composer after an
  external model switch until the session is reopened (see
  [Model selection](#model-selection)).

## File layout

```text
OpenCodeTelegramBridge/
  bridge.js          entry point, Telegram polling, OpenCode SSE, shutdown
  package.json       scripts and Node engine requirement
  .env.example       environment template
  README.md          English documentation
  README.ru.md       Russian documentation
  LICENSE            MIT license
  .gitignore         local env, logs, dependencies
  lib/config.js      env loading, paths, AuthGate, state persistence
  lib/opencode.js    OpenCode HTTP and SSE client
  lib/telegram.js    Telegram Bot API client
  lib/ui.js          messages, keyboards, formatting, validation
  lib/i18n.js        English and Russian strings
  lib/bot.js         commands, forms, permissions, notifications
  test/*.test.js     offline unit and integration tests
```

## Contributing

- Keep the bridge dependency-free and compatible with Node.js 18.16+.
- Add or update an offline test for every behavior change under `test/`.
- Never commit `.env` files, tokens, state files, or OpenCode passwords.
- Keep Telegram and OpenCode messages localized in both English and Russian.
- Run `npm test` and `npm run check` before opening a pull request.

## License

Released under the [MIT License](LICENSE).

Copyright (c) 2026 finkar911.
