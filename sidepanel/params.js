/**
 * Per-model sampling-parameter bag.
 *
 * Stores an arbitrary { [paramName]: value } map per model (keyed by model id)
 * so the user can send any backend sampling parameter — top_k, top_p,
 * repetition_penalty, seed, max_tokens, … — without code changes. Values are
 * numbers or simple strings. The active adapter forwards the bag in its native
 * shape (Ollama -> options, vLLM/OpenAI -> top-level fields); unknown names are
 * ignored by the server, not rejected.
 */

"use strict";

const ModelParams = (() => {
  const KEY = "model_params"; // { [model]: { [name]: number|string } }

  async function load() {
    const d = await browser.storage.local.get(KEY);
    return d[KEY] || {};
  }

  /** The bag for one model, or {} when none. */
  async function get(model) {
    if (!model) return {};
    return (await load())[model] || {};
  }

  /** Replace the whole bag for a model. Empty bags are dropped (no husks). */
  async function setBag(model, bag) {
    if (!model) return;
    const map = await load();
    const clean = {};
    for (const [k, v] of Object.entries(bag || {})) {
      if (!k) continue;
      clean[k] = v;
    }
    if (Object.keys(clean).length) map[model] = clean;
    else delete map[model];
    await browser.storage.local.set({ [KEY]: map });
  }

  return { get, setBag };
})();
