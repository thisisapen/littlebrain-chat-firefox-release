/**
 * Per-model capability flags.
 *
 * vLLM's /v1/models reports no capabilities array (unlike Ollama's /api/tags),
 * so whether a model can see images cannot be auto-detected. The user decides:
 * a per-model "Vision Model?" flag in Model setup. Ollama models still get
 * vision auto-detected from capabilities; this flag ADDS to that set, and is
 * the only source for backends that don't report capabilities.
 */

"use strict";

const ModelCapabilities = (() => {
  const KEY = "model_capabilities"; // { [model]: { vision?: true } }

  async function load() {
    const d = await browser.storage.local.get(KEY);
    return d[KEY] || {};
  }

  async function setVision(model, on) {
    if (!model) return;
    const map = await load();
    const cur = map[model] || {};
    if (on) cur.vision = true;
    else delete cur.vision;
    if (Object.keys(cur).length) map[model] = cur;
    else delete map[model]; // empty entry — don't store husks
    await browser.storage.local.set({ [KEY]: map });
  }

  /** True when the user has marked this model vision-capable. */
  async function isVision(model) {
    if (!model) return false;
    return ((await load())[model] || {}).vision === true;
  }

  /** The set of model ids the user has marked vision-capable. */
  async function visionSet() {
    const map = await load();
    return Object.keys(map).filter((m) => map[m].vision === true);
  }

  return { setVision, isVision, visionSet };
})();
