/**
 * Littlebrain Chat — sidebar entry (settings + connection + streaming chat).
 *
 * All backend knowledge stays in ollama.js; this file only orchestrates UI.
 * Client-side message model:
 *   { role: "system" | "user" | "assistant", content: string, images?: string[] }
 */

"use strict";

const SETTINGS_KEY = "settings"; // {host, port, apiKey, temperature, systemPrompt}
const MODEL_KEY = "lastModel";

/* ---------------------------------------------------------------------------
 * Backend indirection
 *
 * The UI talks ONLY to `backend`, never to a concrete adapter. To add a
 * backend, implement the interface below and register it in BACKENDS.
 * Interface (all adapters, no exceptions):
 *   listModels(config) -> Promise<string[]>            // picker names
 *   chatStream(config, {model, messages, options, tools?},
 *              {signal, onToken}) -> Promise<{text, toolCalls}>
 *   explainError(err) -> string                        // human-readable cause
 * `config` is the stored endpoint settings object; `messages` uses the
 * client-side message model. The ⚙ picker switches backends at runtime.
 * ------------------------------------------------------------------------- */
const BACKENDS = { ollama: OllamaBackend, vllm: VllmBackend, openrouter: OpenRouterBackend };
let backend = BACKENDS.ollama;

/** Select the active adapter by id; unknown ids fall back to Ollama. */
function applyBackend(id) {
  backend = BACKENDS[id] || BACKENDS.ollama;
}

/**
 * Assemble the sampling params for one turn. The per-model bag is
 * the base; the global temperature slider fills in when the bag has no
 * temperature; the Ollama enforce gate adds num_ctx (the vLLM adapter drops it).
 */
async function buildSamplingParams(model, settings, forcedWindow) {
  const bag = await ModelParams.get(model);
  const params = { ...bag };
  params.temperature =
    typeof params.temperature === "number" ? params.temperature : settings.temperature;
  if (forcedWindow) params.num_ctx = forcedWindow;
  return params;
}

const ui = {
  statusDot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
  modelPicker: document.getElementById("model-picker"),
  sessionPicker: document.getElementById("session-picker"),
  messages: document.getElementById("messages"),
  input: document.getElementById("input"),
  sendBtn: document.getElementById("send-btn"),
  stopBtn: document.getElementById("stop-btn"),
  refreshBtn: document.getElementById("refresh-btn"),
  newBtn: document.getElementById("new-btn"),
  deleteBtn: document.getElementById("delete-btn"),
  exportBtn: document.getElementById("export-btn"),
  compactBtn: document.getElementById("compact-btn"),
  settingsBtn: document.getElementById("settings-btn"),
  settingsDialog: document.getElementById("settings-dialog"),
  modelSetupBtn: document.getElementById("model-setup-btn"),
  modelDialog: document.getElementById("model-dialog"),
  toolPermsList: document.getElementById("tool-perms-list"),
  testResult: document.getElementById("test-result"),
  ctxEndpoint: document.getElementById("ctx-endpoint"),
  ctxUsage: document.getElementById("ctx-usage"),
};

/* ---------------- persona ---------------- */

/** Composed persona block, loaded silently ONCE per panel session.
 *  Never re-read on send (no drifting state yet). On load failure chat
 *  simply continues without a soul: identity must never break conversation. */
let soulBlock = "";

async function loadPersona() {
  try {
    const grab = async (p) => (await fetch(browser.runtime.getURL(p))).text();
    const [identify, soul, user] = await Promise.all([
      grab("persona/IDENTIFY.md"),
      grab("persona/SOUL.md"),
      grab("persona/USER.md"),
    ]);
    // IDENTIFY may carry a --- frontmatter header (engine-compatible);
    // strip it for plain injection, keep the readable body.
    const stripFm = (t) => t.replace(/^---\n[\s\S]*?\n---\s*\n/, "");
    soulBlock =
      `## Your Soul\n${stripFm(identify).trim()}\n\n` +
      `${soul.trim()}\n\n` +
      `## The One You Serve\n${user.trim()}`;
    console.debug("[littlebrain-chat] persona loaded", soulBlock.length, "chars");
  } catch (err) {
    soulBlock = "";
    console.warn("[littlebrain-chat] persona unavailable — continuing without it", err);
  }
}

/* ---------------- validation ---------------- */

// Hostname or IPv4/IPv6-ish literal; no scheme, no path.
function validHost(h) {
  return h.length <= 253 && /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(h);
}

function validPort(p) {
  return /^\d+$/.test(p) && p >= 1 && p <= 65535;
}

/* ---------------- storage ---------------- */

async function loadSettings() {
  const data = await browser.storage.local.get([SETTINGS_KEY, MODEL_KEY]);
  return {
    host: "",
    port: "",
    backend: "ollama",
    openrouterApiKey: "",
    apiKey: "",
    temperature: 0.7,
    systemPrompt: "",
    pageReadLimit: 6000, // default page-read length in chars
    ...(data[SETTINGS_KEY] || {}),
    lastModel: data[MODEL_KEY] || "",
  };
}

async function saveSettings(settings) {
  const { lastModel, ...stored } = settings;
  await browser.storage.local.set({ [SETTINGS_KEY]: stored });
  if (lastModel) await browser.storage.local.set({ [MODEL_KEY]: lastModel });
}

/** The session holds its own model; the global key remains the seed for
 *  brand-new sessions. */
async function rememberModel(model) {
  await SessionStore.setLastModel(activeSessionId, model);
  await browser.storage.local.set({ [MODEL_KEY]: model });
}

/* ---------------- permissions (runtime request, typed origin only) ---
 *
 * Firefox law: browser.permissions.request() MUST be invoked synchronously
 * inside a user-input handler — no await before it. contains() has no such
 * restriction, so the non-gesture paths (startup) only *check*.
 */

let grantedPattern = null; // "host:port" pattern confirmed granted this session

function patternFor(host, port) {
  return `http://${host}:${port}/*`;
}

/**
 * Authorize the host for fetch. Call as the FIRST async step of a
 * click/submit handler (only synchronous work may precede it).
 *
 * Note (FF153 quirk): the promise payload from request() was empty even
 * when the user allowed the prompt, so we verify real state via contains()
 * afterwards instead of trusting the returned value.
 */
async function authorizeHost(host, port) {
  const pattern = patternFor(host, port);
  if (grantedPattern === pattern) return;
  let promptError = null;
  try {
    const res = await browser.permissions.request({ origins: [pattern] });
    console.log("[littlebrain-chat] permissions.request resolved with:", res);
  } catch (err) {
    promptError = err; // cancelled or gesture violation — verify state below either way
  }
  const ok = await isHostGranted(host, port);
  if (!ok) {
    throw new Error(
      promptError && promptError.message !== "User cancelled the permission prompt"
        ? `Permission request failed: ${promptError.message}`
        : `Host permission denied for ${host}:${port}`
    );
  }
}

/** Non-gesture check only (safe at startup / on dialog open). */
async function isHostGranted(host, port) {
  const pattern = patternFor(host, port);
  if (grantedPattern === pattern) return true;
  const ok = await browser.permissions.contains({ origins: [pattern] });
  if (ok) grantedPattern = pattern;
  return ok;
}

/* ---------------- connection ---------------- */

/**
 * @param {{state: "ok"|"connecting"|"error", text: string}} s
 */
function setStatus({ state, text }) {
  ui.statusDot.className = `dot dot-${state === "connecting" ? "connecting" : state === "ok" ? "ok" : "error"}`;
  ui.statusText.textContent = text;
  ui.statusText.title = text;
}

function populatePicker(models, preferred) {
  ui.modelPicker.replaceChildren();
  for (const name of models) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name; // exact name the backend reports — nothing hardcoded
    ui.modelPicker.appendChild(opt);
  }
  ui.modelPicker.value = models.includes(preferred) ? preferred : models[0];
  ui.modelPicker.disabled = false;
}

async function doConnect(settings) {
  applyBackend(settings.backend); // select the active adapter (Ollama/vLLM/OpenRouter)
  connected = false;
  lastContext = null;
  visionModels = new Set();
  setStatus({ state: "connecting", text: `Connecting to ${endpointLabel(settings)}…` });
  try {
    const models = await backend.listModels(settings);
    if (!models.length) {
      throw new Error("Backend reports zero models");
    }
    // Restore the session's own model; fall back to the global seed.
    const sess = await SessionStore.get(activeSessionId);
    const preferred = (sess && sess.lastModel) || settings.lastModel;
    settings.lastModel = preferred && models.includes(preferred) ? preferred : models[0];
    populatePicker(models, settings.lastModel);
    await rememberModel(settings.lastModel);
    syncModelMetadata(settings).then(() => updateCtxStrip());
    setStatus({
      state: "ok",
      // Model count hidden here — endpoint moved to the context strip;
      // error states still carry full detail.
      text: "Connected",
    });
    connected = true;
  } catch (err) {
    setStatus({ state: "error", text: backend.explainError(err) });
    connected = false;
  } finally {
    updateComposer();
    updateCtxStrip();
  }
}

/* ---------------- chat ---------------- */

let connected = false;
let streaming = false;
let refreshing = false;
let currentAbort = null;
/** In-memory session history. Client-side message model; `images` is
 *  optional and flows through untouched. */
let conversation = [];
/** Id of the SessionStore session this sidebar view belongs to. */
let activeSessionId = null;
/** REAL token counts from the most recent completed request.
 *  Within a turn later hops read bigger prompts, so the last reported value
 *  wins. Null until the first response round-trips. */
let lastContext = null;
/** True while an export is mid-flight (double-export guard). */
let exportingSession = false;
/** Reactive compaction half: the failed turn's message, queued for exactly ONE
 *  automatic resend after an overflow compaction. Consumed at sendMessage top. */
let compactionRetry = null;
/** True while the current turn chain has already spent its one retry. */
let autoRetriedLastTurn = false;

function updateComposer() {
  const ready = connected && !!ui.modelPicker.value && !streaming;
  ui.input.disabled = !ready;
  ui.sendBtn.disabled = !ready;
  ui.stopBtn.disabled = !streaming;
  ui.refreshBtn.disabled = !connected || refreshing;
  ui.compactBtn.disabled = !connected || streaming || conversation.length - COMPACT_TAIL < 2;
  ui.exportBtn.disabled = !activeSessionId || streaming || exportingSession;
}

/** Learn the server-reported per-model maxima (“meta” source) AND which
 *  models can see images. Fail-soft by design:
 *  missing metadata is a gap in knowledge, not an error. */
let visionModels = new Set(); // model names whose capabilities include "vision"
let showThinkingOff = new Set(); // models the user turned "show thinking" off for
async function syncModelMetadata(settings) {
  try {
    const details = await backend.modelDetails(settings);
    if (!details) return;
    if (Object.keys(details.contexts).length) await ContextLimits.recordMeta(details.contexts);
    // Auto-detected (Ollama capabilities) UNION the user's per-model
    // "Vision Model?" flags (the only source for backends that
    // don't report capabilities, e.g. vLLM).
    const auto = Object.entries(details.capabilities || {})
      .filter(([, caps]) => caps.includes("vision"))
      .map(([name]) => name);
    const manual = await ModelCapabilities.visionSet();
    visionModels = new Set([...auto, ...manual]);
  } catch (err) {
    console.warn("[littlebrain-chat] model metadata unavailable", err.message);
  }
}

const LIMIT_SOURCE_TITLES = {
  manual: "window: set by you in Model setup",
  manual_enforced: "window: set by you — enforced (sent to Ollama as num_ctx; total window incl. reply)",
  observed: "window: learned from the server's own overflow error",
  meta: "window: server-reported model MAXIMUM — the active window can be smaller",
};

/* ---------------- context readout ---------------- */

/** 1234 to "1.2k", 678 to "678". Display-only shorthand. */
function fmtTok(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

/** Endpoint left, usage right. Real Ollama counters when the CURRENT model
 *  has answered this panel session; a labelled estimate until then. The
 *  denominator appears only when the limit is genuinely known (observed or
 *  user-set), never invented. */
async function updateCtxStrip() {
  const s = await loadSettings();
  ui.ctxEndpoint.textContent = connected ? endpointLabel(s) : "not connected";
  const el = ui.ctxUsage;
  el.classList.remove("ctx-warn", "ctx-over");
  el.title = ""; // provenance tooltip is re-earned on every render
  if (!connected) { el.textContent = ""; return; }
  const live = lastContext && lastContext.model === ui.modelPicker.value ? lastContext : null;
  if (live && typeof live.promptTokens === "number") {
    let t = `${fmtTok(live.promptTokens)} tok`;
    const inf = await ContextLimits.info(ui.modelPicker.value);
    if (inf.limit) {
      const pct = Math.round((live.promptTokens / inf.limit) * 100);
      t += ` / ${fmtTok(inf.limit)} · ${pct}%`;
      if (pct > 90) el.classList.add("ctx-over");
      else if (pct > 75) el.classList.add("ctx-warn");
      // Honest provenance: the same % means different things depending on
      // where the denominator came from — say so on hover. An enforcing
      // value flips to its own wording.
      el.title = LIMIT_SOURCE_TITLES[
        inf.source === "manual" && inf.enforced ? "manual_enforced" : inf.source
      ];
    }
    el.textContent = `\u{1F9EE} ${t}`;
  } else {
    // Pre-first-response: chars of what the next request would carry, /4.
    const chars = soulBlock.length + conversation.reduce((n, m) => n + m.content.length, 0);
    el.textContent = `\u{1F9EE} ~${fmtTok(Math.ceil(chars / 4))} tok (est.)`;
  }
}

/* ---------------- compression ---------------- */

/** Auto-compact acts when at most this % of a KNOWN window would remain. */
const AUTO_COMPACT_HEADROOM_PCT = 20;
/** Tail always kept verbatim. */
const COMPACT_TAIL = 10;
/** Model-setup toggle over both automatic halves; missing key = ON,
 *  same semantics as the tool gate. */
const AUTO_COMPACT_KEY = "auto_compact";

const COMPACTION_SYSTEM_PROMPT =
  "You are compressing a chat transcript so the conversation can continue with less context. Write dense, factual continuation notes: decisions made, established facts and preferences, tasks started or still open, and anything the assistant must not forget. Note any page scans (📄 entries) by what was scanned and what mattered from it. No pleasantries.";

/** Is auto-compaction enabled? (missing key = ON) */
async function autoCompactEnabled() {
  const v = await browser.storage.local.get(AUTO_COMPACT_KEY);
  return v[AUTO_COMPACT_KEY] !== false;
}

/** One compaction pass over the ACTIVE view. All-or-nothing: storage only
 *  receives [marker]+tail once the summary has succeeded; on ANY failure the
 *  session stays byte-identical. Returns true iff it actually compacted. */
async function runCompaction(sid, reason) {
  const keepFrom = Math.max(0, conversation.length - COMPACT_TAIL);
  const head = conversation.slice(0, keepFrom);
  if (head.length < 2) {
    // Never fail silently — someone pressed something or a trigger fired.
    appendMessage(
      "assistant",
      `⚠ nothing to compress yet — ${conversation.length} message${conversation.length === 1 ? "" : "s"} total, and the last ${COMPACT_TAIL} are always kept verbatim`
    );
    return false;
  }
  const s = await loadSettings();
  const model = ui.modelPicker.value;
  const prevStatus = { dot: ui.statusDot.className, text: ui.statusText.textContent };
  streaming = true;
  updateComposer();
  setStatus({ state: "connecting", text: `🗜 compacting (${reason})…` });
  let summary = "";
  try {
    const res = await backend.chatStream(
      s,
      {
        model,
        messages: [
          { role: "system", content: COMPACTION_SYSTEM_PROMPT },
          {
            role: "user",
            content: head.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
          },
        ],
        options: { temperature: 0.2 },
        // tools deliberately omitted — plain summarisation request.
      },
      { signal: new AbortController().signal, onToken: () => {} }
    );
    summary = (res.text || "").trim();
  } catch (err) {
    // DOM-only note (not persisted): the history was not touched either.
    appendMessage("assistant", `⚠ compaction failed — ${backend.explainError(err)}`);
    return false;
  } finally {
    streaming = false;
    updateComposer();
    ui.statusDot.className = prevStatus.dot;
    ui.statusText.textContent = prevStatus.text;
    ui.statusText.title = prevStatus.text;
  }
  if (!summary) {
    appendMessage("assistant", "⚠ compaction produced no summary — history untouched");
    return false;
  }
  const chars = head.reduce((n, m) => n + m.content.length, 0);
  const marker = {
    role: "system",
    content: `🗜 Compressed ${head.length} older messages (~${fmtTok(chars)} chars) — ${reason}:\n${summary}`,
  };
  const next = [marker, ...conversation.slice(keepFrom)];
  await SessionStore.setMessages(sid, next); // the single write point
  conversation = next;
  lastContext = null; // counters described pre-compact history; strip re-estimates
  drawMessages(conversation);
  updateCtxStrip();
  ui.messages.scrollTop = ui.messages.scrollHeight;
  return true;
}

/** Proactive half: runs from sendMessage's finally. Fires only when
 *  the toggle is on, a real count exists for the CURRENT model, the window
 *  is genuinely known, and headroom ≤ AUTO_COMPACT_HEADROOM_PCT. At most one
 *  pass per turn (post-compact lastContext is null, so it cannot chain). */
async function maybeAutoCompact(reason) {
  if (streaming || !(await autoCompactEnabled())) return;
  if (!lastContext || lastContext.model !== ui.modelPicker.value) return;
  if (typeof lastContext.promptTokens !== "number") return;
  const lim = await ContextLimits.effective(ui.modelPicker.value);
  if (!lim) return; // unknown window → proactive half stays silent (reactive covers it later)
  const headroomPct = ((lim - lastContext.promptTokens) / lim) * 100;
  if (headroomPct > AUTO_COMPACT_HEADROOM_PCT) return;
  await runCompaction(activeSessionId, `${reason} · ${Math.max(Math.round(headroomPct), 0)}% headroom left`);
}

/**
 * Re-query /api/tags against the already-authorized host and repair
 * any stale selections (picker + lastModel in storage).
 */
async function refreshModels() {
  if (!connected || refreshing) return;
  const settings = await loadSettings();
  refreshing = true;
  updateComposer();
  try {
    const models = await backend.listModels(settings);
    if (!models.length) throw new Error("Backend reports zero models");
    const prev = ui.modelPicker.value;
    populatePicker(models, models.includes(prev) ? prev : models[0]);
    await rememberModel(ui.modelPicker.value);
    await syncModelMetadata(settings); // refresh can surface new models' maxima
    const okText = "Connected"; // endpoint lives in the strip now
    if (prev && !models.includes(prev)) {
      // Deleted-model case: flag it, then restore the calm status.
      setStatus({ state: "error", text: `\u201c${prev}\u201d no longer available \u2192 ${ui.modelPicker.value}` });
      setTimeout(() => {
        if (connected) setStatus({ state: "ok", text: okText });
      }, 4000);
    } else {
      setStatus({ state: "ok", text: okText });
    }
  } catch (err) {
    // Host down during refresh: report, leave the existing picker untouched.
    setStatus({ state: "error", text: backend.explainError(err) });
  } finally {
    refreshing = false;
    updateComposer();
    updateCtxStrip();
  }
}

/* ---------------- session export ---------------------------------------
 * Deterministic half = pure string building below (harness/console-testable
 * in isolation). Optional LLM half = a fixed-prompt summary that degrades
 * to a one-line note on failure and NEVER blocks the file. Delivery is
 * the proven download mechanism: Blob URL → downloads.download({saveAs:true}).
 * sessions.js / ollama.js gain zero lines — export consumes what they
 * already provide. Images ride embedded as data-URIs so the export
 * is one self-contained file (one Save As dialog), not a folder.
 * ========================================================================= */
const SUMMARY_MAX_MESSAGES = 40; // tunable later
const SUMMARY_MAX_CHARS = 32000;
const EXPORT_SUMMARY_SYSTEM_PROMPT =
  "You are writing a Markdown summary of a chat transcript as notes for the user's future self. Use exactly these headings, omitting any with no content:\n## Topics discussed\n## Decisions made\n## Open questions\n## Key facts & references\nDense and factual. No preamble, no greeting, never first person.";
const PROVENANCE_LINE = "Generated locally by Littlebrain Chat.";

/** Pure: session object → complete markdown document (header + summary slot
 *  + transcript + footer). `summary` is undefined (transcript-only),
 *  {unavailable: reason}, or {text, shown, total}. No DOM, no storage.
 *  Thinking blocks are deliberately NOT exported — they are scratch, not
 *  conversation. */
function buildTranscriptMarkdown(s, summary) {
  const msgs = s.messages || [];
  const title = String(s.title || "").trim() || "Untitled session";
  const f = (t) => new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const L = [`# ${title}`, ""];
  if (s.lastModel) L.push(`- **Model:** ${s.lastModel}`);
  if (s.createdAt && s.updatedAt) L.push(`- **Date range:** ${f(s.createdAt)} → ${f(s.updatedAt)}`);
  L.push(`- **Messages:** ${msgs.length}`);
  L.push(`- ${PROVENANCE_LINE}`);
  if (summary === undefined)
    L.push("- **Export mode:** transcript only (no model available to summarise)");
  if (!msgs.length) L.push("", "*(no messages yet)*");
  if (summary !== undefined) {
    if (summary.unavailable !== undefined) {
      L.push("", "## Summary", "", `> Summary unavailable: ${summary.unavailable}`);
    } else {
      L.push("", "## Summary", "", String(summary.text || "").trim());
      if (typeof summary.shown === "number" && summary.shown < summary.total)
        L.push("", `\u003e Summary covers the most recent ${summary.shown} of ${summary.total} messages.`);
    }
  }
  L.push("", "---", "", "## Transcript", "");
  for (const m of msgs) {
    const who = m.role === "user" ? "You" : m.role === "assistant" ? "Assistant" : "System";
    L.push(`### ${who}`, "", String(m.content ?? ""));
    if (Array.isArray(m.images))
      for (const b64 of m.images)
        // Stored raw (capture_screenshot hands over d.b64); markdown needs
        // the full data-URI form to render it.
        L.push(`![image](data:image/jpeg;base64,${String(b64).replace(/\s+/g, "")})`);
    L.push("");
  }
  L.push("---", "", PROVENANCE_LINE, "");
  return L.join("\n");
}
/* ---- end pure export block (harness extracts up to here) -------------- */

/** Cap walk: the newest tail up to 40 messages or ~32k chars,
 *  whichever comes first — always including at least the last message. */
function capForSummary(msgs) {
  const total = msgs.length;
  if (!total) return { messages: [], shown: 0, total: 0 };
  let start = total - 1;
  let chars = String(msgs[start].content ?? "").length;
  while (
    start > 0 &&
    total - start < SUMMARY_MAX_MESSAGES &&
    chars + String(msgs[start - 1].content ?? "").length <= SUMMARY_MAX_CHARS
  ) {
    start--;
    chars += String(msgs[start].content ?? "").length;
  }
  return { messages: msgs.slice(start), shown: total - start, total };
}

/** The fixed-prompt summary call. Mirrors compaction's exact adapter
 *  usage — plain request, no tools; response collected whole. */
async function generateSummary(messages, model, settings) {
  const res = await backend.chatStream(
    settings,
    {
      model,
      messages: [
        { role: "system", content: EXPORT_SUMMARY_SYSTEM_PROMPT },
        {
          role: "user",
          content: "Summarise this chat transcript:\n\n" +
            messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
        },
      ],
      options: { temperature: 0.2 },
      // tools deliberately omitted — plain summarisation request.
    },
    { signal: new AbortController().signal, onToken: () => {} }
  );
  return (res.text || "").trim();
}

/** 📤 button: active session only → one .md via Save As.
 *  Quiet machinery — no in-chat announcement, the file is the artifact. */
async function exportActiveSession() {
  if (exportingSession || !activeSessionId) return;
  const s = await SessionStore.get(activeSessionId);
  if (!s) return;
  exportingSession = true;
  updateComposer();
  const prevStatus = { dot: ui.statusDot.className, text: ui.statusText.textContent };
  try {
    const settings = await loadSettings();
    const model = s.lastModel || ui.modelPicker.value || "";
    const msgs = s.messages || [];
    let summary; // undefined → transcript-only note (never blocks the file)
    if (msgs.length && model) {
      setStatus({ state: "connecting", text: "📤 summarising…" });
      const cap = capForSummary(msgs);
      try {
        summary = {
          text: await generateSummary(cap.messages, model, settings),
          shown: cap.shown,
          total: cap.total,
        };
      } catch (err) {
        console.warn("[littlebrain-chat] export summary failed:", err.message);
        summary = { unavailable: err && err.message || String(err) }; // degrade, don't block
      }
    }
    const base = safeFilename(s.title || "session", "md").replace(/\.md$/i, "");
    const name = safeFilename(`${base}-${new Date().toISOString().slice(0, 10)}`, "md");
    await downloadText(name, buildTranscriptMarkdown(s, summary), "text/markdown;charset=utf-8");
  } finally {
    ui.statusDot.className = prevStatus.dot;
    ui.statusText.textContent = prevStatus.text;
    ui.statusText.title = prevStatus.text;
    exportingSession = false;
    updateComposer();
  }
}

/* ---------------- assistant identity + thinking surface ----------------
 * Display name: user-settable in Settings, blank = default. Render-time
 * only — never stored per message, so renaming re-skins history free.
 * Thinking: reasoning models stream it ahead of the answer; shown live,
 * persisted WITH the answer in a separate field (both wire boundaries map
 * explicit fields, so it can never be sent back), globally hideable. */
const DEFAULT_ASSISTANT_NAME = "Littlebrain";
let uiSettings = {}; // sync mirror of settings for render paths
async function refreshUiSettings() {
  uiSettings = await loadSettings();
}
function assistantName() {
  return (uiSettings.assistantName || "").trim() || DEFAULT_ASSISTANT_NAME;
}
/** Missing key = ON, like every other setting in this extension. */
function showThinkingEnabled() {
  return !showThinkingOff.has(ui.modelPicker.value);
}

/** Load the per-model "show thinking" cache from storage. */
async function syncShowThinking() {
  showThinkingOff = new Set(await ModelDisplay.offSet());
}

/** Prefill the per-model "Show model thinking?" checkbox. */
async function fillShowThinkingFlag() {
  document.getElementById("set-showthinking").checked =
    await ModelDisplay.showThinking(ui.modelPicker.value);
}
/** The 💭 reasoning block: full-width muted line, kin of the 🔧/⚡ lines. */
function thinkLineEl(text) {
  const el = document.createElement("div");
  el.className = "msg system-msg think-line";
  const t = document.createElement("span");
  t.textContent = `💭 ${text}`;
  el.appendChild(t);
  return el;
}

function appendMessage(role, text) {
  const el = document.createElement("div");
  el.className = `msg ${role === "system" ? "system-msg" : role}`;
  if (role === "system") {
    el.textContent = text;
    ui.messages.appendChild(el);
    return el;
  }
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = role === "user" ? "You" : `🧠 ${assistantName()}`;
  const body = document.createElement("span"); // text nodes only — never innerHTML
  body.textContent = text;
  el.append(who, body);
  ui.messages.appendChild(el);
  ui.messages.scrollTop = ui.messages.scrollHeight;
  return body; // callers mutate body.textContent for streaming
}

/** Per-call consent for side-effecting tools. Shows the model's
 *  exact intention before anything runs; declining is itself the answer
 *  the model receives, so it can adapt or stop. */
function buildConsentText(call) {
  const a = call.args || {};
  const bits = [`⚠ ${call.name} is about to modify the current page.`];
  for (const k of ["op", "selector", "name", "value", "css", "text", "find", "replace"]) {
    if (typeof a[k] === "string" && a[k])
      bits.push(`${k}: ${a[k].slice(0, 400)}${a[k].length > 400 ? "…" : ""}`);
  }
  if (typeof a.code === "string")
    bits.push(`code:\n${a.code.slice(0, 1200)}${a.code.length > 1200 ? "\n… [truncated]" : ""}`);
  bits.push("", "The change is visible immediately and disappears when you reload the tab.", "Allow?");
  return bits.join("\n");
}

/* ---------------- sessions ---------------- */

/** Rebuild the session picker: newest-updated first. textContent ONLY —
 *  titles are user-typed text, never HTML. Empty sessions read "(new)". */
async function renderSessions() {
  const map = await SessionStore.all();
  ui.sessionPicker.replaceChildren();
  const ids = Object.keys(map).sort((a, b) => map[b].updatedAt - map[a].updatedAt);
  for (const sid of ids) {
    const opt = document.createElement("option");
    opt.value = sid;
    opt.textContent = map[sid].title || "(new)";
    ui.sessionPicker.appendChild(opt);
  }
  ui.sessionPicker.value = activeSessionId;
  ui.sessionPicker.disabled = false;
  ui.deleteBtn.disabled = false; // ≥1 session exists by invariant
}

/** Redraw #messages from a message list (text nodes only). System-role
 *  entries (page scans) keep their FULL content for the model but render
 *  only their header line — the deterministic 📄 SCANNED indicator. The
 *  🗜 compaction marker gets the same treatment plus a visible pill and a
 *  hover tooltip carrying the full summary notes. */
function drawMessages(msgs) {
  ui.messages.replaceChildren();
  for (const m of msgs) {
    // Reasoning stored with an answer reappears directly above its
    // bubble on re-render — the same position it held while streaming.
    if (m.role === "assistant" && m.thinking && showThinkingEnabled()) {
      ui.messages.appendChild(thinkLineEl(m.thinking));
    }
    if (m.role === "system" && m.content.startsWith("🗜")) {
      const el = appendMessage(m.role, m.content.split("\n")[0]);
      el.classList.add("compact-msg");
      const nl = m.content.indexOf("\n");
      if (nl >= 0) el.title = m.content.slice(nl + 1);
    } else {
      appendMessage(m.role, m.role === "system" ? m.content.split("\n")[0] : m.content);
    }
  }
}

/** Persist a turn's message. A session deleted mid-turn is the one
 *  legitimate drop (the store's own "Unknown session" error, see
 *  sessions.js); anything else must stay visible — never silent loss.
 *  QuotaExceededError is the documented reject name
 *  for exhausted storage.local in Firefox. */
async function rememberMessage(sid, msg) {
  try {
    await SessionStore.appendMessage(sid, msg);
  } catch (err) {
    if (err && err.message.startsWith("Unknown session")) return;
    const text =
      err && err.name === "QuotaExceededError"
        ? "Storage full — message not saved"
        : "Session save failed — message not saved";
    console.error("[littlebrain-chat] session save failed:", err);
    setStatus({ state: "error", text });
  }
}

/** Make an already-loaded session the viewed one (storage keys are set by
 *  the caller's store call, not here). */
function showSession(id, session) {
  activeSessionId = id;
  conversation = [...session.messages];
  drawMessages(conversation);
  if (
    session.lastModel &&
    [...ui.modelPicker.options].some((o) => o.value === session.lastModel)
  ) {
    ui.modelPicker.value = session.lastModel;
  }
  updateComposer();
  updateCtxStrip();
}

/** Show another session. Any in-flight stream is stopped first; its
 *  partial lands in the ORIGINAL session (the sender captured its id at
 *  turn start), so switching mid-stream cannot cross-contaminate. */
async function switchToSession(id) {
  if (!id || id === activeSessionId) return;
  if (streaming && currentAbort) currentAbort.abort();
  const target = await SessionStore.get(id);
  if (!target) return; // stale picker entry — next renderSessions repairs it
  await SessionStore.setActive(id);
  showSession(id, target);
}

/** Delete the ACTIVE session after explicit confirmation. The store
 *  activates the next-newest survivor; if none remain, auto-create. */
async function deleteActiveSession() {
  const current = await SessionStore.get(activeSessionId);
  const label = (current && current.title) || "(new)";
  if (!confirm(`Delete '${label}'? This cannot be undone.`)) return;
  if (streaming && currentAbort) currentAbort.abort();
  const next = await SessionStore.delete(activeSessionId);
  if (next !== null) {
    showSession(next, await SessionStore.get(next));
  } else {
    const created = await SessionStore.create((await loadSettings()).backend);
    showSession(created.id, created.session);
  }
  await renderSessions();
}

async function newConversation() {
  if (streaming && currentAbort) currentAbort.abort();
  const { id } = await SessionStore.create((await loadSettings()).backend);
  activeSessionId = id;
  conversation = [];
  ui.messages.replaceChildren();
  await renderSessions();
}

async function sendMessage() {
  const retrying = !!compactionRetry;
  const text = retrying ? compactionRetry.text : ui.input.value.trim();
  compactionRetry = null;
  if (!retrying) autoRetriedLastTurn = false;
  const model = ui.modelPicker.value;
  if (!text || !model || streaming) return;

  // Pin this turn to ITS session; a mid-turn switch must not redirect saves.
  const sid = activeSessionId;

  const settings = await loadSettings();

  // Natural-language page read. Runs BEFORE the
  // input clears so a failed read leaves the message editable, and a
  // failure never sends the prompt blind.
  let pageEntry = null;
  if (PAGE_SCAN_RE.test(text)) {
    const read = await readActivePage(settings.pageReadLimit);
    if (!read.ok) {
      appendMessage("system", read.error);
      return;
    }
    pageEntry = read.entry;
  }

  ui.input.value = "";
  streaming = true;
  currentAbort = new AbortController();
  updateComposer();

  const userMsg = { role: "user", content: text };
  if (pageEntry) {
    // Stored & sent in full; UI renders just the 📄 SCANNED header line
    // (same rule as restore).
    conversation.push(pageEntry);
    await rememberMessage(sid, pageEntry);
    appendMessage("system", pageEntry.content.split("\n")[0]);
  }
  if (retrying) {
    // The failed attempt already pushed + persisted this SAME message —
    // the reactive retry must not duplicate it.
  } else {
    conversation.push(userMsg);
    appendMessage("user", text);
    // Persist the question before streaming so a crash mid-turn
    // cannot lose it.
    await rememberMessage(sid, userMsg);
  }
  const asstBody = appendMessage("assistant", "");

  // Thinking surface for this turn. The 💭 rides the name label
  // while reasoning tokens arrive and drops off when real content starts.
  const showThink = showThinkingEnabled();
  let thinkText = "";
  let thinkEl = null;
  const asstMsgEl = asstBody.parentElement;
  const asstWho = asstMsgEl.querySelector(".who");
  const baseWhoLabel = asstWho.textContent;
  let contentStarted = false;
  const setThinkingFace = (on) => {
    asstWho.textContent = on ? `${baseWhoLabel} 💭` : baseWhoLabel;
  };

  let full = "";
  try {
    // Default = send FULL history each turn.
    // Single-slot freshness: history keeps EVERY read for
    // truthfulness, but the live payload carries only the MOST RECENT one.
    // Older reads are stale premises — they confuse models into ignoring
    // the current page, which is exactly what we observed with 9B/35B.
    let lastRead = -1;
    conversation.forEach((m, i) => { if (m.role === "system") lastRead = i; });
    const freshConversation = conversation.filter(
      (m, i) => m.role !== "system" || i === lastRead
    );

    const baseMessages = [];
    // Persona is the base of the system message; the user's
    // optional System prompt (Settings) layers AFTER it — identity first,
    // mission notes second. Wire-boundary audit: only messages[0] gains this.
    const systemText = [soulBlock, settings.systemPrompt].filter(Boolean).join("\n\n");
    if (systemText) baseMessages.push({ role: "system", content: systemText });
    baseMessages.push(...freshConversation);

    // Tools loop: while the model prefers tool calls over words,
    // execute them locally and hand results back. Intermediate hops are NOT
    // persisted — history keeps the question and final answer.
    const wireMessages = [...baseMessages];
    const prevStatus = { dot: ui.statusDot.className, text: ui.statusText.textContent };
    let hops = 0;
    const hopLimit = await maxToolHops(); // user-tunable (Model setup), global across models
    // Read the enforcement gate ONCE per turn.
    // Non-null iff this model has BOTH a manual limit and the enforce flag.
    const forcedWindow = await ContextLimits.effectiveNumCtx(model);
    const samplingParams = await buildSamplingParams(model, settings, forcedWindow);
    let scanStoredThisTurn = false; // at most ONE stored scan per turn
    for (;;) {
      const res = await backend.chatStream(
        settings,
        {
          model,
          messages: wireMessages,
          options: samplingParams,
          tools: (() => {
            // Permissions gate: only user-enabled tools reach the backend.
            // Vision gate: capture_screenshot additionally needs a
            // vision-capable model (from /api/tags); a text-only model never
            // sees the tool, so it can't call it and get an image error.
            // Empty list omitted so a fully-disabled jail sends a plain
            // chat request (the pre-tools-movement wire shape).
            const s = ToolPermissions.enabledSchemas().filter(
              (sch) => sch.function.name !== "capture_screenshot" || visionModels.has(model),
            );
            return s.length ? s : undefined;
          })(),
        },
        {
          signal: currentAbort.signal,
          onToken: (tok) => {
            if (!contentStarted) {
              contentStarted = true;
              setThinkingFace(false); // the real answer has begun
            }
            asstBody.textContent += tok;
            ui.messages.scrollTop = ui.messages.scrollHeight;
          },
          // Reasoning tokens. Always accumulated (they are
          // persisted regardless of display); rendered only when shown.
          onThinking: (tok) => {
            thinkText += tok;
            if (!showThink) return;
            if (!thinkEl) {
              thinkEl = thinkLineEl("");
              ui.messages.insertBefore(thinkEl, asstMsgEl);
            }
            thinkEl.firstChild.textContent = `💭 ${thinkText}`;
            setThinkingFace(true);
            ui.messages.scrollTop = ui.messages.scrollHeight;
          },
        }
      );
      full = res.text;
      // Keep the freshest real usage — the final hop of a tool loop
      // read the largest prompt, so plain overwrite gives the true high-water.
      if (res.usage) lastContext = { model, ...res.usage };
      if (!res.toolCalls.length) break;
      if (hops >= hopLimit) {
        full += `\n\n⚠ Stopped: model kept requesting tool calls (${hopLimit}-hop limit reached).`;
        break;
      }
      hops++;
      setStatus({ state: "connecting", text: `⏳ calling ${res.toolCalls.map((c) => c.name).join(", ")}…` });
      // Echo the assistant's tool_calls back in exact wire form, then results.
      wireMessages.push({
        role: "assistant",
        content: res.text,
        ...(res.reasoningDetails?.length ? { reasoning_details: res.reasoningDetails } : {}),
        tool_calls: res.toolCalls.map((c, i) => ({
          id: c.id, // vLLM/OpenAI; absent for Ollama (dropped on serialize)
          type: "function",
          function: { index: i, name: c.name, arguments: c.args },
        })),
      });
      for (const call of res.toolCalls) {
        // Honest timeline: announce each call ABOVE the answer bubble as it
        // happens. Ephemeral on purpose — intermediate hops are never stored
        // so these lines vanish on reload by design.
        const line = document.createElement("div");
        line.className = "msg system-msg";
        line.textContent = `🔧 ${call.name}`; // raw tool names
        ui.messages.insertBefore(line, asstBody.parentElement);
        let result;
        const tool = TOOLS[call.name];
        try {
          if (!tool) {
            result = `Unknown tool: ${call.name}`;
          } else if (!ToolPermissions.isEnabled(call.name)) {
            // Second line of the permissions gate: even if a disabled tool name
            // somehow reaches us (stale model memory), it is refused, not run.
            result = `Tool '${call.name}' is disabled in Settings \u2192 Tool permissions.`;
          } else if (tool.consents && !confirm(buildConsentText(call))) {
            // The user's voice — decline changes nothing and tells
            // the model exactly that, so it can adapt rather than retry blind.
            result = `User declined this ${call.name} call — nothing was changed.`;
          } else {
            result = await tool.execute(call.args, { pageReadLimit: settings.pageReadLimit });
          }
        } catch (err) {
          result = `Tool error: ${err.message || err}`;
        }
        // Vision tools return {content, images[]} instead of a bare
        // string — carry the pixels onto the tool message; the wire mapper
        // already passes images[] through for any role (ollama.js).
        const toolImages =
          result && typeof result === "object" && Array.isArray(result.images) && result.images.length
            ? result.images
            : null;
        if (result && typeof result === "object") result = String(result.content);
        wireMessages.push({
          role: "tool",
          tool_name: call.name,
          tool_call_id: call.id, // vLLM/OpenAI; absent for Ollama (dropped on serialize)
          content: String(result),
          ...(toolImages ? { images: toolImages } : {}),
        });
        // Audit: an APPLIED edit leaves a permanent ⚡ line, the way
        // 📄 does for reads. Declined or failed calls store nothing — only
        // what actually happened to the page is recorded.
        if (
          call.name === "edit_dom" &&
          typeof result === "string" &&
          result.startsWith("Applied: ")
        ) {
          const a = call.args || {};
          const what = a.op === "run_js"
            ? `run_js: ${String(a.code).slice(0, 400)}${String(a.code).length > 400 ? "…" : ""}`
            : `${a.op} ${a.selector || ""}`.trim();
          const record = { role: "system", content: `⚡ edit_dom applied: ${what} — ${result.replace(/^Applied: /, "")}` };
          conversation.push(record);
          await rememberMessage(sid, record);
          const recLine = appendMessage("system", record.content);
          ui.messages.insertBefore(recLine, asstBody.parentElement); // live order == stored order
        }
        // Model-initiated reads persist EXACTLY like explicit `scan this …`
        // ones: same stored block, same header line in-chat, same
        // single-slot payload rule next turn. Restore and future
        // exports therefore see every read regardless of who triggered it.
        if (
          call.name === "read_active_page" &&
          typeof result === "string" &&
          result.startsWith("📄 SCANNED:") &&
          !scanStoredThisTurn
        ) {
          scanStoredThisTurn = true;
          const entry = { role: "system", content: result };
          conversation.push(entry);
          await rememberMessage(sid, entry);
          const scanLine = appendMessage("system", result.split("\n")[0]);
          ui.messages.insertBefore(scanLine, asstBody.parentElement); // live order == stored order
        }
      }
    }
    // Restore the connection status the loop temporarily replaced.
    ui.statusDot.className = prevStatus.dot;
    ui.statusText.textContent = prevStatus.text;
    ui.statusText.title = prevStatus.text;
    const asstRecord = { role: "assistant", content: full };
    // Reasoning persists with its answer (separate field — it is
    // never mapped onto the wire, see the helper's comment).
    if (thinkText) asstRecord.thinking = thinkText;
    conversation.push(asstRecord);
    // Persist the completed answer.
    await rememberMessage(sid, asstRecord);
    if (!full) asstBody.textContent = "(empty response)";
    await updateCtxStrip();
  } catch (err) {
    // An overflow error doubles as the one true source of a model's
    // window — learn it before displaying the failure. Must never throw.
    try { await ContextLimits.recordOverflow(model, err && err.message || String(err)); } catch (_) {}
    await updateCtxStrip();
    // Reactive compaction half: a REAL context overflow (documented error text —
    // the parser above is the only judge) with auto enabled and no retry
    // spent yet: compact, then let finally re-send this same message once.
    if (
      err.name !== "AbortError" &&
      !autoRetriedLastTurn &&
      (await autoCompactEnabled()) &&
      (await ContextLimits.limitFromOverflow(err && err.message || String(err)))
    ) {
      if (await runCompaction(sid, "context overflow")) {
        autoRetriedLastTurn = true;
        compactionRetry = { text };
      }
    }
    // Persist what the model actually produced (UI decorations are
    // applied below, after this capture, so stored text stays clean).
    const partial = asstBody.textContent;
    if (partial || thinkText) {
      const pRec = {
        role: "assistant",
        // Reasoning arrived but no answer did: say so rather than store an
        // empty bubble that re-renders as nothing.
        content: partial || "(no answer — interrupted after thinking)",
      };
      if (thinkText) pRec.thinking = thinkText;
      conversation.push(pRec);
      await rememberMessage(sid, pRec);
    }
    if (err.name === "AbortError") {
      asstBody.textContent = asstBody.textContent
        ? `${asstBody.textContent}  ■ stopped`
        : "■ stopped";
    } else {
      const msg = backend.explainError(err);
      asstBody.classList.add("error");
      asstBody.textContent = asstBody.textContent
        ? `${asstBody.textContent}\n⚠ ${msg}`
        : `⚠ ${msg}`;
      setStatus({ state: "error", text: msg });
    }
  } finally {
    streaming = false;
    currentAbort = null;
    updateComposer();
    updateCtxStrip();
    // A turn may have minted a title — keep the picker label honest.
    await renderSessions();
    // Step in before the wall, never after it.
    try { await maybeAutoCompact("auto"); } catch (err) { console.error("[littlebrain-chat] auto-compact failed", err); }
    // Reactive half's second step: one automatic resend of the failed turn.
    if (compactionRetry) {
      setStatus({ state: "connecting", text: "↻ retrying after compaction…" });
      await sendMessage();
      await renderSessions(); // the retried turn may have minted a title
    }
  }
}

/* ---------------- page reading ---------------- */

// Scan command vocabulary: ONLY
// these explicit forms — no incidental matches, by design old triggers
// were removed entirely to make accidental scans impossible.
const PAGE_SCAN_RE = /\bscan\s+this\s+(?:page|tab|window|site|website)\b/i;

/** Shape the raw extraction into the message that gets stored & sent.
 *  Line 1 is the deterministic UI indicator — drawMessages and
 *  the live path render exactly that line, so the proof-of-scan can never
 *  depend on model compliance (or be faked by injected page content).
 *  The directive also asks cooperative models to open their reply with the
 *  same marker; where they comply it's redundancy, where they don't the
 *  extension-drawn line still stands. */
function formatPageEntry(d) {
  const note = d.truncated
    ? `first ${d.text.length} chars — page continues beyond the limit`
    : `${d.text.length} chars total`;
  return {
    role: "system",
    content:
      `📄 SCANNED: ${d.title} · ${d.url}\n` +
      `The user explicitly commanded a scan of this web page and is viewing it right now. Begin your reply with "📄 SCANNED:" on its own first line, then answer from the page content below (${note}). Never claim you cannot see pages.\n\n${d.text}`,
  };
}

/** Ask the ACTIVE tab for its visible text. Returns {ok:true, entry} or
 *  {ok:false, error} with a plain reason (never throws). */
async function readActivePage(limit) {
  const { tab, error } = await getReadableTab();
  if (error) return { ok: false, error };
  let data;
  try {
    data = await browser.tabs.sendMessage(tab.id, { type: "littlebrain-chat/read-page", limit });
  } catch {
    // Documented case: no content script present — e.g. the page was
    // opened before the extension (re)started.
    return {
      ok: false,
      error: "⚠ No page reader here — reload this tab once (pages opened before the extension started aren't instrumented).",
    };
  }
  if (!data || data.ok !== true) {
    return { ok: false, error: "⚠ The page reader came back empty." };
  }
  return { ok: true, data, entry: formatPageEntry(data) };
}

/** Runaway guard: max tool round-trips per user turn (documented constant). */
/* ---------------- tool-loop budget (global across every model) -------- */

const HOP_LIMIT_DEFAULT = 3;
const HOP_LIMIT_MIN = 1;
const HOP_LIMIT_MAX = 99;

/** Clamp to a legal budget. A corrupt stored value must never wedge a
 *  turn with an invalid limit — fall back to the default silently, same
 *  fallback philosophy as the context counters' garbage rejection. */
function clampHopLimit(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return HOP_LIMIT_DEFAULT;
  return Math.min(HOP_LIMIT_MAX, Math.max(HOP_LIMIT_MIN, n));
}

/** The user's per-turn tool budget (Model setup dialog), read once per
 *  turn before the loop runs. */
async function maxToolHops() {
  return clampHopLimit((await loadSettings()).toolHopLimit);
}

/* ---------------- settings dialog ---------------- */

/** Page-read limit: sane clamp around the documented default. */
function clampPageLimit(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return 6000;
  return Math.min(20000, Math.max(500, n));
}

/** OpenRouter is a fixed cloud endpoint; the local backends use host:port. */
function endpointLabel(s) {
  return s.backend === "openrouter" ? "OpenRouter" : `${s.host}:${s.port}`;
}

/** Local backends (Ollama, vLLM) need Firefox host authorization; OpenRouter
 *  is a public HTTPS API and does not. */
function needsHostAuth(id) {
  return id === "ollama" || id === "vllm";
}

function validConnection(s) {
  return s.backend === "openrouter" ? !!s.openrouterApiKey : validHost(s.host) && validPort(s.port);
}

/** Show the local-endpoint fields for Ollama/vLLM, the API-key field for
 *  OpenRouter. Driven by the backend dropdown. */
function updateBackendFields() {
  const remote = document.getElementById("set-backend").value === "openrouter";
  document.getElementById("local-settings").hidden = remote;
  document.getElementById("openrouter-settings").hidden = !remote;
}

function readForm() {
  const f = ui.settingsDialog.querySelector("#settings-form");
  return {
    host: f.host.value.trim(),
    port: f.port.value.trim(),
    backend: f.backend.value,
    openrouterApiKey: f.openrouterApiKey.value.trim(),
    apiKey: f.apiKey.value.trim(),
    systemPrompt: f.systemPrompt.value.trim(),
    pageReadLimit: clampPageLimit(f.pageReadLimit.value),
    assistantName: f.assistantName.value.trim(),
  };
}

/** Model setup dialog — the model-facing half of configuration.
 *  Every control applies immediately (hot swap, temperature, permissions),
 *  so there is no Save button; Done merely closes. */
async function openModelSetup() {
  const s = await loadSettings();
  document.getElementById("set-temp").value = s.temperature;
  document.getElementById("auto-compact").checked = await autoCompactEnabled();
  document.getElementById("set-hoplimit").value = s.toolHopLimit ?? HOP_LIMIT_DEFAULT;
  fillCtxLimitField();
  applyEnforceAvailability(s.backend);
  fillVisionFlag();
  fillShowThinkingFlag();
  renderParamBag(ui.modelPicker.value);
  renderToolPerms();
  ui.modelDialog.showModal();
}

/** Prefill the per-model context-limit field and its enforce checkbox from
 *  what we genuinely know (observed or manually set; empty when unknown)
 *  for the selected model. */
async function fillCtxLimitField() {
  const el = document.getElementById("set-ctxlimit");
  const enforceEl = document.getElementById("set-enforce");
  if (!ui.modelPicker.value) { el.value = ""; enforceEl.checked = false; return; }
  const inf = await ContextLimits.info(ui.modelPicker.value);
  el.value = inf.limit ?? "";
  el.title = LIMIT_SOURCE_TITLES[
    inf.source === "manual" && inf.enforced ? "manual_enforced" : inf.source
  ] || "unknown — leave empty, or type a value to set one";
  enforceEl.checked = inf.enforced;
}

/** Prefill the per-model "Vision Model?" flag. */
async function fillVisionFlag() {
  const el = document.getElementById("set-vision");
  el.checked = await ModelCapabilities.isVision(ui.modelPicker.value);
}

/** The enforce flag sends num_ctx, which is Ollama-only. Hide the toggle for
 *  every other backend — the window is fixed by the server there, so there's
 *  nothing to cap per request. The readout and auto-compact still work. */
function applyEnforceAvailability(backendId) {
  document.getElementById("set-enforce").closest("label").hidden = backendId !== "ollama";
}

/** Clamp + persist temperature from the model-setup dialog (immediate write). */
async function saveTemperature(raw) {
  let n = parseFloat(raw);
  if (!Number.isFinite(n)) return; // untouched/blank input — ignore
  n = Math.min(2, Math.max(0, n));
  const prev = await loadSettings();
  await saveSettings({ ...prev, temperature: n });
}

/** Clamp + persist the tool-loop budget from Model setup (immediate write). */
async function saveHopLimit(raw) {
  if (String(raw).trim() === "") return; // blank input — keep the previous value
  const n = clampHopLimit(raw);
  const prev = await loadSettings();
  await saveSettings({ ...prev, toolHopLimit: n });
}

/** Coerce a param-bag value from the input to number-or-string. */
function coerceParamValue(raw) {
  const s = String(raw).trim();
  if (s === "") return "";
  const n = Number(s);
  return Number.isFinite(n) ? n : s;
}

/** Rebuild the per-model sampling-param rows from storage. */
async function renderParamBag(model) {
  const container = document.getElementById("param-rows");
  container.textContent = "";
  if (!model) return;
  const bag = await ModelParams.get(model);
  for (const [k, v] of Object.entries(bag)) container.appendChild(paramRow(k, v));
}

/** One editable key=value row with a remove button. */
function paramRow(key, value) {
  const row = document.createElement("div");
  row.className = "param-row";
  const keyInput = document.createElement("input");
  keyInput.className = "param-key";
  keyInput.placeholder = "name (e.g. top_k)";
  keyInput.value = key;
  keyInput.autocomplete = "off";
  const eq = document.createElement("span");
  eq.className = "param-eq";
  eq.textContent = "=";
  const valInput = document.createElement("input");
  valInput.className = "param-value";
  valInput.placeholder = "value";
  valInput.value = value;
  valInput.autocomplete = "off";
  const rm = document.createElement("button");
  rm.type = "button";
  rm.className = "icon-btn param-remove";
  rm.title = "Remove parameter";
  rm.textContent = "✕";
  const persist = () => persistParamBagFromRows(ui.modelPicker.value);
  keyInput.addEventListener("change", persist);
  valInput.addEventListener("change", persist);
  rm.addEventListener("click", () => {
    row.remove();
    persist();
  });
  row.append(keyInput, eq, valInput, rm);
  return row;
}

/** Persist the bag for the current model from the visible rows.
 *  The bag is always the aggregate of the rows, so add/rename/remove all reduce
 *  to one code path. Rows with a name but no value are skipped. */
async function persistParamBagFromRows(model) {
  if (!model) return;
  const bag = {};
  for (const row of document.querySelectorAll("#param-rows .param-row")) {
    const k = row.querySelector(".param-key").value.trim();
    const v = coerceParamValue(row.querySelector(".param-value").value);
    if (k && v !== "") bag[k] = v;
  }
  await ModelParams.setBag(model, bag);
}

/** Rebuild the Tool permissions section — one row per registered
 *  tool, in registry order. New tools added to tools.js appear here for
 *  free. Rows write immediately on toggle (no Save-button round-trip). */
function renderToolPerms() {
  const box = ui.toolPermsList;
  box.textContent = "";
  for (const t of Object.values(TOOLS)) {
    const name = t.schema.function.name;
    const row = document.createElement("label");
    row.className = "tool-perm";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = ToolPermissions.isEnabled(name);
    cb.addEventListener("change", () => {
      ToolPermissions.setEnabled(name, cb.checked).catch((err) =>
        console.error("[littlebrain-chat] tool toggle failed", err)
      );
    });
    const span = document.createElement("span");
    span.className = "tool-perm-body";
    const head = document.createElement("span");
    head.className = "tool-perm-head";
    const title = document.createElement("strong");
    title.textContent = name; // raw registry name, e.g. get_current_time
    head.append(title, document.createTextNode(` · ${t.label}`));
    if (t.dangerNote) {
      const warn = document.createElement("small");
      warn.className = "perm-warn";
      warn.textContent = `⚠ ${t.dangerNote}`;
      span.appendChild(warn);
    }
    const desc = document.createElement("small");
    desc.textContent = t.schema.function.description;
    span.append(head, desc);
    row.append(cb, span);
    box.append(row);
  }
}

async function openSettings() {
  const s = await loadSettings();
  const f = ui.settingsDialog.querySelector("#settings-form");
  // Fresh-install ergonomics: prefill common local defaults into
  // an EMPTY form only — they become real once the user presses Save.
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  const fresh = !stored[SETTINGS_KEY];
  f.host.value = s.host || (fresh ? "127.0.0.1" : "");
  f.port.value = s.port || (fresh ? "11434" : "");
  f.backend.value = s.backend || "ollama";
  f.openrouterApiKey.value = s.openrouterApiKey;
  updateBackendFields();
  f.apiKey.value = s.apiKey;
  f.systemPrompt.value = s.systemPrompt;
  f.pageReadLimit.value = s.pageReadLimit;
  f.assistantName.value = s.assistantName || "";
  setTestResult(null, "");
  ui.settingsDialog.showModal();
  f.host.focus();
}

function setTestResult(kind, text) {
  ui.testResult.className = kind || "";
  ui.testResult.textContent = text;
}

async function testConnection() {
  const trial = readForm();
  if (!validConnection(trial)) {
    setTestResult("err", "Enter an OpenRouter API key, or a valid host and port (1–65535).");
    return;
  }
  setTestResult(null, "Testing…");
  try {
    // Synchronous path so far — this is still inside the click gesture.
    applyBackend(trial.backend); // test the selected adapter
    if (needsHostAuth(trial.backend)) await authorizeHost(trial.host, trial.port);
    const models = await backend.listModels(trial);
    setTestResult(
      "ok",
      `Connected — ${models.length} model${models.length === 1 ? "" : "s"}: ${models.join(", ")}`
    );
  } catch (err) {
    setTestResult("err", backend.explainError(err));
  }
}

async function onFormSubmit(event) {
  event.preventDefault();
  const next = readForm(); // sync
  if (!validConnection(next)) {
    setTestResult("err", "Enter an OpenRouter API key, or a valid host and port (1–65535).");
    return;
  }
  if (streaming) { setTestResult("err", "Stop the current reply before changing backends."); return; }
  next.port = parseInt(next.port, 10) || "";
  try {
    // FIRST async step — still inside the submit gesture. No await may precede this.
    if (needsHostAuth(next.backend)) await authorizeHost(next.host, next.port);
  } catch (err) {
    setTestResult("err", err.message || String(err)); // dialog stays open for retry
    return;
  }
  const prev = await loadSettings();
  await saveSettings({ ...prev, ...next });
  await refreshUiSettings(); // name/thinking-toggle take effect now
  applyBackend(next.backend); // switch adapter before connecting
  ui.settingsDialog.close();
  doConnect(next);
}

/* ---------------- init ---------------- */

document.addEventListener("DOMContentLoaded", async () => {
  console.log("[littlebrain-chat] sidebar loaded", {
    browserAPIsAvailable: typeof browser !== "undefined",
    manifestVersion: typeof browser !== "undefined" ? browser.runtime.getManifest().manifest_version : null,
  });
  await ToolPermissions.load(); // gate state must exist before any send
  await refreshUiSettings(); // render paths read a cached settings copy
  await loadPersona(); // silent one-time persona load
  applyBackend((await loadSettings()).backend); // honour saved backend

  document.getElementById("set-backend").addEventListener("change", updateBackendFields);
  ui.settingsBtn.addEventListener("click", openSettings);
  ui.modelSetupBtn.addEventListener("click", openModelSetup);
  document.getElementById("btn-model-done").addEventListener("click", () => ui.modelDialog.close());
  document.getElementById("set-temp").addEventListener("change", (e) => {
    saveTemperature(e.target.value).catch((err) => console.error("[littlebrain-chat] temp save failed", err));
  });
  document.getElementById("set-hoplimit").addEventListener("change", (e) => {
    saveHopLimit(e.target.value).catch((err) => console.error("[littlebrain-chat] hop limit save failed", err));
  });
  document.getElementById("set-ctxlimit").addEventListener("change", async (e) => {
    const model = ui.modelPicker.value;
    if (!model) return;
    const v = parseInt(e.target.value, 10);
    try {
      await ContextLimits.setManual(model, Number.isFinite(v) && v > 0 ? v : null);
    } catch (err) {
      console.error("[littlebrain-chat] ctx limit save failed", err);
    }
    updateCtxStrip();
  });
  document.getElementById("set-enforce").addEventListener("change", async (e) => {
    const model = ui.modelPicker.value;
    if (!model) return;
    try {
      await ContextLimits.setEnforced(model, e.target.checked);
    } catch (err) {
      console.error("[littlebrain-chat] enforce flag save failed", err);
    }
    updateCtxStrip();
  });
  document.getElementById("param-add").addEventListener("click", () => {
    const model = ui.modelPicker.value;
    if (!model) return;
    document.getElementById("param-rows").appendChild(paramRow("", ""));
  });
  document.getElementById("set-vision").addEventListener("change", async (e) => {
    const model = ui.modelPicker.value;
    if (!model) return;
    await ModelCapabilities.setVision(model, e.target.checked);
    // Reflect in the gate immediately, no network round-trip.
    if (e.target.checked) visionModels.add(model);
    else visionModels.delete(model);
  });
  document.getElementById("set-showthinking").addEventListener("change", async (e) => {
    const model = ui.modelPicker.value;
    if (!model) return;
    await ModelDisplay.setShowThinking(model, e.target.checked);
    // Reflect in the gate immediately, no network round-trip.
    if (e.target.checked) showThinkingOff.delete(model);
    else showThinkingOff.add(model);
  });
  document.getElementById("auto-compact").addEventListener("change", (e) => {
    browser.storage.local
      .set({ [AUTO_COMPACT_KEY]: e.target.checked })
      .catch((err) => console.error("[littlebrain-chat] auto-compact save failed", err));
  });
  document.getElementById("btn-test").addEventListener("click", testConnection);
  document.getElementById("btn-cancel").addEventListener("click", () => ui.settingsDialog.close());
  ui.settingsDialog.querySelector("#settings-form").addEventListener("submit", onFormSubmit);
  ui.modelPicker.addEventListener("change", async () => {
    await rememberModel(ui.modelPicker.value);
    updateComposer();
    updateCtxStrip();
    if (ui.modelDialog.open) fillCtxLimitField(); // limit is per-model
    if (ui.modelDialog.open) fillVisionFlag();
    if (ui.modelDialog.open) fillShowThinkingFlag();
    if (ui.modelDialog.open) renderParamBag(ui.modelPicker.value);
  });
  ui.sendBtn.addEventListener("click", sendMessage);
  ui.stopBtn.addEventListener("click", () => currentAbort && currentAbort.abort());
  ui.refreshBtn.addEventListener("click", refreshModels);
  ui.newBtn.addEventListener("click", newConversation);
  ui.sessionPicker.addEventListener("change", () => switchToSession(ui.sessionPicker.value));
  ui.deleteBtn.addEventListener("click", deleteActiveSession);
  document.getElementById("export-btn").addEventListener("click", () =>
    exportActiveSession().catch((err) => console.error("[littlebrain-chat] export failed", err))
  );
  ui.compactBtn.addEventListener("click", async () => {
    if (
      !confirm(
        "Compress this session? Older messages become one summary entry; the last 10 stay verbatim."
      )
    )
      return;
    try {
      await runCompaction(activeSessionId, "manual");
    } catch (err) {
      console.error("[littlebrain-chat] manual compact failed", err);
    }
  });
  ui.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  /* Always operate inside an active session; first launch creates one.
   * backendId records provenance only — the store never enforces it. */
  activeSessionId = (await SessionStore.activeId()) || (await SessionStore.create((await loadSettings()).backend)).id;

  /* Redraw the active session's history. appendMessage() renders
   * text nodes only (XSS invariant); messages feed `conversation` so the
   * next turn sends the full restored context. */
  await syncShowThinking(); // prime the per-model "show thinking" cache
  const activeSession = await SessionStore.get(activeSessionId);
  conversation = [...activeSession.messages];
  drawMessages(conversation);
  await renderSessions();

  const settings = await loadSettings();
  if (settings.backend === "openrouter" && settings.openrouterApiKey) {
    doConnect(settings);
  } else if (needsHostAuth(settings.backend) && settings.host && settings.port) {
    // No user gesture here: check silently, never request().
    if (await isHostGranted(settings.host, settings.port)) {
      doConnect(settings);
    } else {
      setStatus({
        state: "error",
        text: `${settings.host}:${settings.port} saved — open ⚙ and press Save to authorize the host`,
      });
    }
  } else {
    setStatus({ state: "error", text: "No endpoint set — click ⚙ to configure" });
  }
  updateCtxStrip(); // first paint of the readout strip (unconnected state)
});
