/**
 * Littlebrain Chat — content script (Phase 3, P3-M2: active-tab extraction).
 *
 * Runs inside every http/https page the user has open (declared in the
 * manifest's content_scripts; never on chrome://, about:, or add-on pages).
 * Returns raw facts only — all presentation (📄 line, truncation marker)
 * happens in the sidebar, keeping this script dumb and reusable.
 *
 * Protocol (JSON via browser.runtime.sendMessage / onMessage):
 *   in : { type: "littlebrain-chat/ping" }
 *   out: { ok: true }
 *
 *   in : { type: "littlebrain-chat/read-page", limit?: number }
 *   out: { ok: true, url, title, truncated, text }
 *         — text is body innerText sliced head-first to `limit` chars
 *           (default 6000). innerText excludes hidden elements,
 *           scripts and styles by definition; form field values are not
 *           rendered text and therefore never appear.
 *
 *   in : { type: "littlebrain-chat/extract-tables" }
 *   out: { ok: true, url, title, truncated, tables: [
 *            { index, headers: string[], rowCount, rows: string[][] } ] }
 *         — structured <table> data under documented caps (D-P3-12).
 *           innerText per cell ⇒ hidden/scripts/form values excluded
 *           exactly as for read-page. Nested tables also surface as their
 *           own entries (the outer table's cells contain their full text);
 *           accepted v1 limitation. Rows include any header row; `headers`
 *           mirrors the first <th>-bearing row, or [] when none exists.
 *
 *   in : { type: "littlebrain-chat/read-dom", query?: string }
 *   in : { type: "littlebrain-chat/edit-dom", op, selector?, name?, value?, css?, text?, find?, replace?, code? }
 *   out (head, no query) : { ok, url, title, mode:"head", totalChars,
 *                             truncated, html } // html = first 1000 chars
 *   out (search)         : { ok, url, title, mode:"search", totalChars,
 *                             scannedChars, query, matchCount, truncated,
 *                             matches: string[] }
 *         — live-DOM inspection (D-P3-13): documentElement.outerHTML read
 *           FRESH on every call, never cached. Search is literal,
 *           case-insensitive, capped (see constants), snippets carry
 *           ~200 chars of context either side and are whitespace-collapsed.
 */

"use strict";

/** Visible text of the page, sliced head-first. See header for guarantees. */
function readPage(limit) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 6000;
  const root = document.body || document.documentElement;
  const full = root ? root.innerText || "" : "";
  const truncated = full.length > max;
  return {
    ok: true,
    url: location.href,
    title: document.title,
    truncated,
    text: truncated ? full.slice(0, max) : full,
  };
}

// Documented caps (D-P3-12): a pathological page must not blow up memory,
// the message channel, or (indirectly) the summaries shown to the model.
const MAX_TABLES = 20;
const MAX_ROWS_PER_TABLE = 5000;
const MAX_CELL_CHARS = 2000;
// C-M4 audit: the box had one open side — no row-WIDTH cap. A <tr> with
// thousands of long cells would defeat every other limit above.
const MAX_CELLS_PER_ROW = 200;

function cleanCell(cell) {
  return (cell.innerText || "").replace(/\s+/g, " ").trim().slice(0, MAX_CELL_CHARS);
}

/** Structured table data under the documented caps. See header protocol. */
function extractTables() {
  const tables = [];
  let truncated = false;
  const found = Array.from(document.querySelectorAll("table"));
  for (const el of found) {
    if (tables.length >= MAX_TABLES) {
      // Past the cap: only count this as truncation when a beyond-cap table
      // actually carries text — pages hold many empty scaffolding tables and
      // skipping those is not a data loss. First real loss ends the scan.
      if ((el.textContent || "").trim()) {
        truncated = true;
        break;
      }
      continue;
    }
    const rowEls = Array.from(el.querySelectorAll("tr"));
    if (rowEls.length > MAX_ROWS_PER_TABLE) truncated = true;
    const rows = [];
    let headers = [];
    for (const tr of rowEls.slice(0, MAX_ROWS_PER_TABLE)) {
      const cellElsAll = Array.from(tr.children).filter(
        (c) => c.tagName === "TD" || c.tagName === "TH"
      );
      let cellEls = cellElsAll;
      if (cellEls.length > MAX_CELLS_PER_ROW) {
        truncated = true; // dropped cells are real data — flag it honestly
        cellEls = cellElsAll.slice(0, MAX_CELLS_PER_ROW);
      }
      const cells = cellEls.map(cleanCell);
      if (!headers.length && cellEls.some((c) => c.tagName === "TH")) headers = cells.slice();
      rows.push(cells);
    }
    // Skip tables carrying no rendered text at all — layout scaffolding,
    // useless in a CSV and confusing in a model-facing summary.
    if (!rows.length || rows.every((r) => r.every((c) => !c))) continue;
    tables.push({ index: tables.length, headers, rowCount: rows.length, rows });
  }
  return { ok: true, url: location.href, title: document.title, truncated, tables };
}

// Documented caps (D-P3-13): raw markup is a LARGER untrusted surface than
// rendered text, so results stay tiny by construction. Live on every call;
// nothing is ever cached.
const SOURCE_HEAD_CHARS = 1000; // head-mode orientation slice
const SOURCE_SCAN_CAP = 500_000; // max serialized chars scanned per search
const MAX_MATCHES = 8; // snippets returned per search
const MATCH_CTX_CHARS = 200; // context kept either side of each match
const MAX_SCAN_STEPS = 20_000; // advance guard: keeps a pathological search
// ("a" across megabytes) from stalling the page's own JS thread

/**
 * Raw markup of the live DOM (D-P3-13). Falsy `query` → head mode (first
 * SOURCE_HEAD_CHARS chars). Otherwise literal case-insensitive substring
 * search over up to SOURCE_SCAN_CAP chars: up to MAX_MATCHES snippets with
 * context plus the total match count within the scanned range.
 */
function readDom(query) {
  const root = document.documentElement;
  const full = root ? root.outerHTML || "" : "";
  const totalChars = full.length;
  const scan = totalChars > SOURCE_SCAN_CAP ? full.slice(0, SOURCE_SCAN_CAP) : full;
  const q = typeof query === "string" ? query.trim() : "";
  if (!q) {
    return {
      ok: true,
      url: location.href,
      title: document.title,
      mode: "head",
      totalChars,
      truncated: totalChars > SOURCE_HEAD_CHARS,
      html: full.slice(0, SOURCE_HEAD_CHARS),
    };
  }
  const hay = scan.toLowerCase();
  const needle = q.toLowerCase();
  const matches = [];
  let matchCount = 0;
  let steps = 0;
  let exhausted = false;
  let pos = hay.indexOf(needle);
  while (pos !== -1) {
    matchCount++;
    if (matches.length < MAX_MATCHES) {
      const start = Math.max(0, pos - MATCH_CTX_CHARS);
      const end = Math.min(scan.length, pos + q.length + MATCH_CTX_CHARS);
      const snippet = scan.slice(start, end).replace(/\s+/g, " ");
      matches.push((start > 0 ? "…" : "") + snippet + (end < scan.length ? "…" : ""));
    }
    pos = hay.indexOf(needle, pos + needle.length);
    if (++steps >= MAX_SCAN_STEPS) {
      exhausted = true;
      break;
    }
  }
  return {
    ok: true,
    url: location.href,
    title: document.title,
    mode: "search",
    totalChars,
    scannedChars: scan.length,
    query: q,
    matchCount,
    truncated: totalChars > SOURCE_SCAN_CAP || exhausted,
    matches,
  };
}

/* ---------------- page editing (D-P4-10, ratified 2026-09-09) ----------
 * The isolated-world script shares the DOM with the page, so every change
 * below is real and immediately visible. All of it is ephemeral by nature:
 * reloading the tab reverts it. run_js appends a REAL <script>, which runs
 * in the page's main world (the page's own globals, frameworks, fetch —
 * the developer surface the user explicitly asked for); model code reports
 * back by writing dataset.lbResult on <html>, which we poll briefly, read,
 * cap and clean up. No result marker means "ran, said nothing". */
const EDIT_STYLE_ID = "lb-managed-style";
const EDIT_RESULT_ATTR = "data-lb-result";
const JS_WAIT_MS = 5000;
const JS_POLL_MS = 100;
const RESULT_CAP = 4000;

function editStamp(d) {
  d.title = document.title;
  d.url = location.href;
  return d;
}

/** Match-based ops hit EVERY match and report the count; zero matches is
 *  an error, not a silent no-op. Malformed selectors fail as text. */
function editDom(p) {
  const fail = (error) => editStamp({ ok: false, error });
  try {
    const needsSelector = !p.op.startsWith("clear_") && p.op !== "inject_css";
    const els = p.selector ? Array.from(document.querySelectorAll(p.selector)) : [];
    if (needsSelector) {
      if (!p.selector) return fail("no selector given");
      if (!els.length) return fail(`no elements match '${p.selector}' — nothing changed`);
    }
    switch (p.op) {
      case "remove":
        els.forEach((el) => el.remove());
        return editStamp({ ok: true, effect: `removed ${els.length} element(s)` });
      case "set_attribute": {
        for (const el of els)
          p.value === "" ? el.removeAttribute(p.name) : el.setAttribute(p.name, p.value);
        return editStamp({
          ok: true,
          effect: `${p.value === "" ? "cleared" : "set"} attribute '${p.name}' on ${els.length} element(s)`,
        });
      }
      case "set_style":
        els.forEach((el) => (el.style.cssText += `; ${p.css}`));
        return editStamp({ ok: true, effect: `styled ${els.length} element(s)` });
      case "set_text":
        els.forEach((el) => (el.textContent = p.text));
        return editStamp({ ok: true, effect: `replaced text of ${els.length} element(s)` });
      case "append_text":
        els.forEach((el) => el.appendChild(document.createTextNode(p.text)));
        return editStamp({ ok: true, effect: `appended text to ${els.length} element(s)` });
      case "replace_text": {
        let n = 0;
        for (const el of els) {
          const t = el.textContent;
          if (t.includes(p.find)) {
            el.textContent = t.split(p.find).join(p.replace);
            n++;
          }
        }
        return editStamp({ ok: true, effect: `replaced text inside ${n} of ${els.length} matched element(s)` });
      }
      case "inject_css": {
        let st = document.getElementById(EDIT_STYLE_ID);
        if (!st) {
          st = document.createElement("style");
          st.id = EDIT_STYLE_ID;
          document.head.appendChild(st);
        }
        st.textContent = p.css; // replace, never stack — repeat calls are idempotent
        return editStamp({ ok: true, effect: `injected ${p.css.length} chars of CSS (managed <style>)` });
      }
      case "clear_css":
        document.getElementById(EDIT_STYLE_ID)?.remove();
        return editStamp({ ok: true, effect: "removed managed <style>" });
      default:
        return fail(`Unknown op: ${p.op}`);
    }
  } catch (err) {
    return fail(String((err && err.message) || err));
  }
}

/** run_js: main-world execution. The model's code runs with the page's own
 *  context; the only contract is the lbResult marker (documented in the
 *  tool description). Bounded wait, capped readback, cleanup either way. */
async function editRunJs(code) {
  const root = document.documentElement;
  let script;
  try {
    root.removeAttribute(EDIT_RESULT_ATTR);
    script = document.createElement("script");
    script.textContent = code;
    root.appendChild(script);
  } catch (err) {
    return editStamp({ ok: false, error: String((err && err.message) || err) });
  }
  const started = Date.now();
  while (Date.now() - started < JS_WAIT_MS && !root.hasAttribute(EDIT_RESULT_ATTR)) {
    await new Promise((r) => setTimeout(r, JS_POLL_MS));
  }
  script.remove();
  if (!root.hasAttribute(EDIT_RESULT_ATTR)) {
    return editStamp({ ok: true, effect: "script executed — no result marker written" });
  }
  const raw = root.getAttribute(EDIT_RESULT_ATTR) || "";
  root.removeAttribute(EDIT_RESULT_ATTR);
  const out = raw.length > RESULT_CAP ? `${raw.slice(0, RESULT_CAP)}… [truncated, ${raw.length} total]` : raw;
  return editStamp({ ok: true, effect: `result: ${out}` });
}

browser.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "littlebrain-chat/ping") return Promise.resolve({ ok: true });
  if (message.type === "littlebrain-chat/read-page") {
    return Promise.resolve(readPage(message.limit));
  }
  if (message.type === "littlebrain-chat/extract-tables") {
    return Promise.resolve(extractTables());
  }
  if (message.type === "littlebrain-chat/read-dom") {
    return Promise.resolve(readDom(message.query));
  }
  if (message.type === "littlebrain-chat/edit-dom") {
    return Promise.resolve(
      message.op === "run_js" ? editRunJs(message.code) : editDom(message)
    );
  }
  // Not our message type: answer nothing, never throw.
});
