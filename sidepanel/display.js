/**
 * Per-model display preferences.
 *
 * "Show model thinking" is a per-model display choice: whether to render the
 * model's reasoning blocks above its answer. Every backend streams thinking
 * (Ollama, vLLM, OpenRouter), so each model carries its own flag. Defaults to
 * ON when a model has no stored preference.
 */

"use strict";

const ModelDisplay = (() => {
  const KEY = "model_display"; // { [model]: { showThinking?: bool } }

  async function load() {
    const d = await browser.storage.local.get(KEY);
    return d[KEY] || {};
  }

  async function setShowThinking(model, on) {
    if (!model) return;
    const map = await load();
    const cur = map[model] || {};
    cur.showThinking = !!on;
    map[model] = cur;
    await browser.storage.local.set({ [KEY]: map });
  }

  /** True unless the user has explicitly turned thinking off for this model. */
  async function showThinking(model) {
    if (!model) return true;
    const entry = (await load())[model];
    return entry ? entry.showThinking !== false : true;
  }

  /** Set of model ids the user has explicitly turned thinking OFF for. */
  async function offSet() {
    const map = await load();
    return Object.keys(map).filter((m) => map[m].showThinking === false);
  }

  return { setShowThinking, showThinking, offSet };
})();
