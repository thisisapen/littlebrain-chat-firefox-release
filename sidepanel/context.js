/**
 * Context-limit knowledge.
 *
 * Answers exactly one question: "do we KNOW this model's context window?"
 * Three honest sources, kept separately per model, in priority order:
 *   manual    — entered by the user in Model setup;
 *   observed  — parsed from Ollama's documented overflow error after it
 *               actually happens (the ceiling the server itself stated);
 *   meta      — details.context_length from /api/tags (present on most
 *               models, ABSENT on some).
 *               It is the MODEL MAXIMUM; since we send no num_ctx the active
 *               window can be smaller, so it ranks last and the readout says
 *               where its number came from. Clearing the manual field falls
 *               back through observed to meta rather than destroying either.
 *               Guesses, defaults and unverified fields are NOT recorded.
 *
 * Enforcement: a per-model "enforce" flag makes the
 * MANUAL limit real — sent to Ollama as options.num_ctx when, and only when,
 * both a manual value AND the flag are set. Observed/meta values are NEVER
 * sent to the server no matter how the flag reads; effectiveNumCtx() is the
 * single gate for that decision.
 */

"use strict";

const ContextLimits = (() => {
  const KEY = "context_limits"; // { [model]: { manual?: int, observed?: int, meta?: int } }

  /** The ONLY overflow format trusted: Ollama's documented error text
   *  "this model's maximum context length is N tokens". Returns N or null —
   *  nothing else is guessed at. */
  function limitFromOverflow(text) {
    const m = /maximum context length is (\d+) tokens/.exec(String(text || ""));
    return m ? parseInt(m[1], 10) : null;
  }

  async function load() {
    const d = await browser.storage.local.get(KEY);
    return d[KEY] || {};
  }

  /** Called from the send-path error handler. Writes at most once per value;
   *  coexists with any manual entry (effective() picks the priority). */
  async function recordOverflow(model, errorText) {
    const n = limitFromOverflow(errorText);
    if (!n) return;
    const map = await load();
    const cur = map[model] || {};
    if (cur.observed === n) return;
    map[model] = { ...cur, observed: n };
    await browser.storage.local.set({ [KEY]: map });
  }

  /** Manual set from Model setup; pass null to clear (falls back to any
   *  observation, then unknown). Clearing also drops the enforce flag —
   *  it means nothing without a manual value to act on. */
  async function setManual(model, limitOrNull) {
    const map = await load();
    const cur = map[model] || {};
    if (limitOrNull === null) { delete cur.manual; delete cur.enforce; }
    else cur.manual = limitOrNull;
    if (Object.keys(cur).length) map[model] = cur;
    else delete map[model]; // empty entry — don't store husks
    await browser.storage.local.set({ [KEY]: map });
  }

  /** Bulk-merge model maxima reported by /api/tags (details.context_length).
   *  Fills ONLY the lowest-priority slot; never touches manual/observed.
   *  Non-numbers are dropped at the door (the adapter already guards, this
   *  is the boundary check). Skips storage entirely when nothing changed. */
  async function recordMeta(entries) {
    if (!entries || !Object.keys(entries).length) return;
    const map = await load();
    let dirty = false;
    for (const [model, n] of Object.entries(entries)) {
      if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) continue;
      const cur = map[model] || {};
      if (cur.meta === n) continue;
      map[model] = { ...cur, meta: n };
      dirty = true;
    }
    if (dirty) await browser.storage.local.set({ [KEY]: map });
  }

  /** Known window in tokens, or null (unknown): manual > observed > meta. */
  async function effective(model) {
    const e = (await load())[model];
    if (!e) return null;
    return e.manual ?? e.observed ?? e.meta ?? null;
  }

  /** effective() plus WHERE the number came from (the readout tooltip and
   *  the Model-setup prefill both stay honest about provenance) and whether
   *  the user has made it ENFORCING. */
  async function info(model) {
    const e = (await load())[model];
    if (!e) return { limit: null, source: null, enforced: false };
    if (e.manual !== undefined)
      return { limit: e.manual, source: "manual", enforced: e.enforce === true };
    if (e.observed !== undefined) return { limit: e.observed, source: "observed", enforced: false };
    if (e.meta !== undefined) return { limit: e.meta, source: "meta", enforced: false };
    return { limit: null, source: null, enforced: false };
  }

  /** Persist the per-model enforce flag. Only the
   *  truthy state is stored — absent means OFF, which is the default. */
  async function setEnforced(model, on) {
    const map = await load();
    const cur = map[model] || {};
    if (on) cur.enforce = true;
    else delete cur.enforce;
    if (Object.keys(cur).length) map[model] = cur;
    else delete map[model]; // empty entry — don't store husks
    await browser.storage.local.set({ [KEY]: map });
  }

  /** THE single enforcement gate: the number sent to Ollama as
   *  options.num_ctx, or null when nothing must be sent. Only a MANUAL
   *  limit can ever be enforced — observed and meta values never change
   *  what the server does, no matter how the flag reads. Note: num_ctx
   *  covers prompt+answer combined while the readout tracks prompt tokens,
   *  so UI copy says the number means the TOTAL window. */
  async function effectiveNumCtx(model) {
    const e = (await load())[model];
    if (!e || e.manual === undefined || e.enforce !== true) return null;
    return e.manual;
  }

  return { limitFromOverflow, recordOverflow, recordMeta, setManual, setEnforced, effective, info, effectiveNumCtx };
})();
