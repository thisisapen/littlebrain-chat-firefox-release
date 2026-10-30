/**
 * Session store.
 *
 * The ONLY owner of session data in browser.storage.local.
 * Knows nothing about backends, models, or hosts. Provenance is stored as
 * inert data (session.backendId), never enforced here.
 *
 * Data layout (single key → atomic reads/writes at this scale):
 *   "sessions":      { "<uuid>": { title, createdAt, updatedAt,
 *                                  backendId, lastModel, messages[] } }
 *   "activeSession": "<uuid>" | null
 *
 * Messages use the client-side message model verbatim; an optional
 * images[] array passes through untouched.
 */

"use strict";

const SessionStore = {
  KEY: "sessions",
  ACTIVE_KEY: "activeSession",
  TITLE_MAX: 40, // trimmed first user message, ≤40 chars

  /** Full map; absence of the key reads as empty, never throws. */
  async all() {
    const data = await browser.storage.local.get(this.KEY);
    return data[this.KEY] || {};
  },

  /** One session, or null. */
  async get(id) {
    const map = await this.all();
    return map[id] || null;
  },

  /** Currently selected session id, or null. */
  async activeId() {
    const data = await browser.storage.local.get(this.ACTIVE_KEY);
    return data[this.ACTIVE_KEY] || null;
  },

  /** Create an empty session and make it active. Returns it. */
  async create(backendId) {
    const now = Date.now();
    const session = {
      title: "",
      createdAt: now,
      updatedAt: now,
      backendId: backendId || "",
      lastModel: "",
      messages: [],
    };
    const id = crypto.randomUUID();
    const map = await this.all();
    map[id] = session;
    await browser.storage.local.set({ [this.KEY]: map, [this.ACTIVE_KEY]: id });
    return { id, session };
  },

  async setActive(id) {
    await browser.storage.local.set({ [this.ACTIVE_KEY]: id });
  },

  /**
   * Append a message; bumps updatedAt; derives the title from the first
   * user message if none is set yet. Returns the updated session.
   */
  async appendMessage(id, message) {
    this.ensureMessage(message);
    const map = await this.all();
    const s = map[id];
    if (!s) throw new Error(`Unknown session: ${id}`);
    s.messages.push(message);
    s.updatedAt = Date.now();
    if (!s.title && message.role === "user") {
      const t = message.content.trim().replace(/\s+/g, " ");
      s.title = t.length > this.TITLE_MAX ? t.slice(0, this.TITLE_MAX - 1) + "…" : t;
    }
    await browser.storage.local.set({ [this.KEY]: map });
    return s;
  },

  /**
   * Whole-history replacement. The ONE sanctioned non-conversation write
   * path into a session — reserved for compaction.
   * Every element passes the same door check as appended messages.
   */
  async setMessages(id, messages) {
    for (const m of messages) this.ensureMessage(m);
    const map = await this.all();
    const s = map[id];
    if (!s) throw new Error(`Unknown session: ${id}`);
    s.messages = messages;
    s.updatedAt = Date.now();
    await browser.storage.local.set({ [this.KEY]: map });
    return s;
  },

  /**
   * Remember the model most recently used in a session (picker state).
   */
  async setLastModel(id, model) {
    const map = await this.all();
    const s = map[id];
    if (!s) throw new Error(`Unknown session: ${id}`);
    s.lastModel = model;
    await browser.storage.local.set({ [this.KEY]: map });
  },

  /**
   * Remove a session. Returns the id to activate next — the remaining
   * session with the newest updatedAt, or null when none remain
   * (the caller decides whether to auto-create).
   */
  async delete(id) {
    const map = await this.all();
    if (!map[id]) throw new Error(`Unknown session: ${id}`);
    delete map[id];
    let next = null;
    let newest = -Infinity;
    for (const [sid, s] of Object.entries(map)) {
      if (s.updatedAt >= newest) {
        newest = s.updatedAt;
        next = sid;
      }
    }
    await browser.storage.local.set({ [this.KEY]: map, [this.ACTIVE_KEY]: next });
    return next;
  },

  /**
   * The browser's own accounting ({usage, quota} bytes) — the real
   * storage.local ceiling, measured rather than assumed.
   */
  async estimate() {
    return browser.storage.manager.estimate();
  },

  /* Boundary check: the store refuses malformed messages at its door so a
   * future UI bug can't corrupt persisted data. Nothing speculative —
   * these are exactly the fields the message model guarantees. */
  ensureMessage(m) {
    if (
      !m ||
      typeof m !== "object" ||
      !["system", "user", "assistant"].includes(m.role) ||
      typeof m.content !== "string" ||
      (m.images !== undefined && !Array.isArray(m.images))
    ) {
      throw new Error("Malformed message object");
    }
  },
};
