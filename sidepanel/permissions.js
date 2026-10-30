/**
 * Littlebrain Chat — tool permissions.
 *
 * The GATE between the model and the tool registry (tools.js): which
 * registered tools actually reach the backend, and therefore what the
 * model can request. One entry per registered tool — 1:1 with TOOLS, so a
 * tool added there appears here automatically; nothing about a tool's
 * permissions needs to be written down twice.
 *
 * Storage: browser.storage.local key "tool_permissions" holding ONLY
 * explicit user toggles ({ [toolName]: bool }). A missing entry means
 * DEFAULT ON — existing behaviour is preserved, and newly added tools
 * arrive usable, visible in Settings, and one checkbox away from off.
 * Exception: tools that MUTATE the page
 * are listed in DEFAULT_OFF and ship disabled until deliberately enabled —
 * a writing tool should never be armed by omission.
 *
 * Changes apply IMMEDIATELY on toggle (they do not wait for the settings
 * form's Save button): tool access is a security control, and blocking it
 * behind host/port validation would couple two unrelated concerns.
 *
 * Loaded AFTER tools.js, BEFORE sidepanel.js (see index.html).
 */

const TOOL_PERMS_KEY = "tool_permissions"; // { [toolName]: bool } — explicit overrides only

// Page-mutating tools start OFF; everything else stays missing=ON.
const DEFAULT_OFF = { edit_dom: true };

const ToolPermissions = (() => {
  /** In-memory snapshot of explicit toggles; refreshed on load() and set(). */
  let state = {};

  async function load() {
    try {
      const data = await browser.storage.local.get(TOOL_PERMS_KEY);
      state = data[TOOL_PERMS_KEY] || {};
    } catch {
      state = {}; // storage unavailable → everything defaults on, nothing breaks
    }
    // One-shot rename migration: read_page_source → read_dom.
    // Carries an explicit user toggle across so a deliberate OFF never
    // silently resets to the default ON when the tool changes its name.
    if (state.read_page_source !== undefined && state.read_dom === undefined) {
      state.read_dom = state.read_page_source;
      delete state.read_page_source;
      browser.storage.local.set({ [TOOL_PERMS_KEY]: { ...state } }).catch(() => {});
    }
    return { ...state };
  }

  /** Effective permission for one tool: stored toggle wins; otherwise the
   *  per-tool default (ON — except the DEFAULT_OFF writers above). */
  function isEnabled(name) {
    if (state[name] !== undefined) return state[name];
    return !DEFAULT_OFF[name];
  }

  /** Persist a toggle immediately and update the snapshot. */
  async function setEnabled(name, on) {
    if (!TOOLS[name]) throw new Error(`Unknown tool: ${name}`);
    state[name] = !!on;
    await browser.storage.local.set({ [TOOL_PERMS_KEY]: { ...state } });
    return { ...state };
  }

  /** The gated schemas: registry order preserved; disabled tools absent. */
  function enabledSchemas() {
    return Object.values(TOOLS)
      .filter((t) => isEnabled(t.schema.function.name))
      .map((t) => t.schema);
  }

  return { load, isEnabled, setEnabled, enabledSchemas };
})();
