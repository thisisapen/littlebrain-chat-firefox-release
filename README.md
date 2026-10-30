# Littlebrain Chat

A chat sidebar for Firefox that talks to local or cloud models. Point it at any model, and it can read the page in front of you, search the web, open links, export page data, and — only with your explicit consent — edit the live page. There is no telemetry.

## Setup

No build step — load the unpacked extension directly.

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-On** and select `manifest.json` from this folder.

The add-on is temporary: it unloads when Firefox fully quits, so reload it after a restart.

Configure it: open the side panel, click ⚙, choose a backend, enter its connection details, press **Test connection**, then **Save**. A green status dot means connected.

## Backends

Littlebrain talks to three kinds of model server. Pick one in ⚙; each has its own fields, so switching backends keeps the others' settings.

- **Ollama** — local. Enter the host and port. Localhost works; a network name or IP works too, for example a Tailscale address like `littlebrain:11434`. Leave the API key empty unless your Ollama requires one.
- **vLLM** — local, OpenAI-compatible. Same host-and-port form as Ollama. Point it at a running vLLM server; requests go to its `/v1` endpoint.
- **OpenRouter** — cloud. Enter your OpenRouter API key; it connects to `https://openrouter.ai/api/v1`. Requests are forwarded to the chosen model provider, and usage may incur charges.

## Model setup

The wrench (🔧) opens Model setup. Everything there applies immediately — there is no Save button.

- **Model** — any model the backend lists. The refresh button re-reads the list; switching models keeps the conversation.
- **Temperature** — 0 to 2. Lower is more predictable.
- **Extra sampling parameters** — optional per-model key/value pairs, sent to the backend as-is (for example `top_k`, `top_p`, `frequency_penalty`, `seed`). Keys the backend doesn't recognise are ignored.
- **Context limit** — optional, per model. Leave it empty and the real window is read from the server when possible.
- **Enforce limit** — Ollama only. Sends `num_ctx` so the server caps the window per request. Hidden for the other backends, whose window is fixed by the server.
- **Auto-compact** — when the context window runs low, older messages are summarised automatically. The last 10 always stay word-for-word.
- **Max tool calls per reply** — how many tool calls Littlebrain may make in one reply before it must stop and answer. Defaults to 3, range 1–99.
- **Vision model?** — marks a model as able to see images. Auto-filled where the backend reports it; set it by hand for backends that don't (vLLM). The screenshot tool only appears for vision models.
- **Show model thinking** — show or hide the reasoning stream, for models that produce one.
- **Tool permissions** — one toggle per tool (listed below). Off means the model never even sees the tool.

## Tools

| Tool | What it does |
|---|---|
| Read active page | Answer questions from the page you are looking at. Table data is preserved. |
| Read DOM | A deeper look at a page's live structure, for technical questions. |
| Capture page screenshot | Screenshots the visible part of the page and answers from it. Vision models only; a single frame, not a recording. |
| Web search | Searches with your browser's default engine and opens the results in a new tab. |
| Open URL | Opens any link in a new tab, or in its own window if you ask. |
| Export table to CSV | Saves the page's tabular data as a CSV file through your normal download prompt. |
| List open tabs | See what else you have open. |
| Switch to an open tab | Jump between your tabs. |
| Current time | The date and time on your machine, on request. |
| Edit page DOM | Changes the live page directly — text, styles, elements, even running JavaScript. Off by default; see Permissions and safety. |

Chain them in one request, for example: "search for X, open the first result, and tell me what it says".

## Reading a page

Type **scan this page** (or "scan this tab / window / site") and Littlebrain reads the visible page before answering. The read is stored and shown as a `📄 SCANNED` line. How much is read is capped by the page-read limit in ⚙.

## Sessions and everyday use

- The top bar holds your sessions: a picker, **+** for a new chat, and a bin to delete one. Sessions survive restarts.
- 📤 exports the active session as a Markdown file (Save As). If a model is available it adds a short summary on top; otherwise the file is transcript-only.
- 🗜 compresses a long conversation by hand; auto-compact does the same thing on its own when needed.
- The small strip above the input shows real token usage for the conversation.
- While Littlebrain is streaming, ■ stops it mid-sentence. The partial answer is kept.
- In ⚙ you can rename the assistant (the default is Littlebrain) and set an optional system prompt.

## Permissions and safety

The extension asks for broad site access so it can read, screenshot, and open pages. What it actually *does* is controlled by you:

- Every tool has a toggle in Model setup. Off means the model never sees the tool.
- **Edit page DOM is off by default.** Enable it in the list (it carries a warning line), and every edit then asks you for confirmation with the exact change shown. Decline and nothing happens.
- Page edits last until the tab reloads.
- Failed tool calls are reported as failures.

## Privacy

Model requests go to your configured Ollama or vLLM host, or to `https://openrouter.ai` when that backend is selected (OpenRouter forwards requests to the model provider). Browser tools can also open websites and run searches. Chat history, API keys, and per-model settings live in Firefox's local storage on your machine. There is no analytics or update phone-home.

## Tests

Run `node --test tests/openrouter.test.cjs` to check OpenRouter streaming and message conversion with mocked responses.
