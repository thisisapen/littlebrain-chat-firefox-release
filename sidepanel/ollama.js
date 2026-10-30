/**
 * Ollama backend adapter.
 *
 * The ONLY place that knows about Ollama's wire format. It implements the
 * neutral three-method backend interface; the sidebar UI
 * talks only to `backend` in sidepanel.js, so a future adapter (e.g. Pi
 * Agent) registers in BACKENDS without touching UI code.
 *
 * Client-side message model consumed by chatStream():
 *   { role: "system" | "user" | "assistant", content: string, images?: string[] }
 */

"use strict";

const OllamaBackend = {
  /**
   * @param {{host: string, port: number}} endpoint
   * @returns {string} base URL, plain HTTP only
   */
  baseUrl({ host, port }) {
    return `http://${host}:${port}`;
  },

  /** Optional auth header — Ollama supports bearer tokens. */
  headers(apiKey) {
    const h = { "Content-Type": "application/json" };
    if (apiKey) h.Authorization = `Bearer ${apiKey}`;
    return h;
  },

  /**
   * List model names from the native /api/tags endpoint.
   * @param {{host: string, port: number, apiKey?: string}} settings
   * @param {number} [timeoutMs]
   * @returns {Promise<string[]>} model names exactly as reported (e.g. "ornith:latest")
   */
  async listModels(settings, timeoutMs = 5000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl(settings)}/api/tags`, {
        headers: this.headers(settings.apiKey),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body.models)) throw new Error("Unexpected /api/tags response shape");
      return body.models.map((m) => m.name);
    } catch (err) {
      if (err.name === "AbortError") throw new Error("Connection timed out");
      // TypeError("Failed to fetch") etc. — surface the cause tersely.
      throw new Error(this.explainError(err));
    } finally {
      clearTimeout(timer);
    }
  },

  /**
   * Per-model maxima reported by the server itself.
   * Verified against a live Ollama: /api/tags entries carry
   * details.context_length as a number for most models and NO field for
   * others (gemma4:e4b) — only genuine numbers pass through.
   *
   * Returns `{ contexts, capabilities }` from ONE fetch:
   *   contexts:     sparse { [modelName]: contextLength }
   *   capabilities: sparse { [modelName]: string[] } (e.g. ["vision","tools"])
   * Failures reject like listModels; callers treat that as "no metadata",
   * not an error state.
   */
  async modelDetails(settings, timeoutMs = 5000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl(settings)}/api/tags`, {
        headers: this.headers(settings.apiKey),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body.models)) throw new Error("Unexpected /api/tags response shape");
      const contexts = {};
      const capabilities = {};
      for (const m of body.models) {
        const n = m.details && m.details.context_length;
        if (typeof n === "number" && Number.isFinite(n) && n > 0) contexts[m.name] = n;
        if (Array.isArray(m.capabilities)) capabilities[m.name] = m.capabilities;
      }
      return { contexts, capabilities };
    } catch (err) {
      if (err.name === "AbortError") throw new Error("Connection timed out");
      throw new Error(this.explainError(err));
    } finally {
      clearTimeout(timer);
    }
  },

  /**
   * Streaming chat via native /api/chat — NDJSON, one JSON object per line.
   *
   * @param {{host:string, port:number, apiKey?:string}} settings
   * @param {{model:string, messages:Array, options?:{temperature?:number},
   *         tools?:Array}} req
   *   `messages` uses our client-side message model; an optional `images`
   *   array is mapped onto Ollama's per-message `images` field (vision rides
   *   in here without further adapter changes).
   *   Optional `tools` (Ollama wire shape `{type:"function", function:{…}}`)
   *   enables tool calling; a backend without
   *   tool support may ignore the parameter.
   * @param {{signal:AbortSignal, onToken:(tok:string)=>void}} hooks
   * @returns {Promise<{text:string, toolCalls:Array<{name:string,args:Object}>,
   *          usage:{promptTokens:number|null, completionTokens:number|null}|null}>}
   *   `text` = full assistant text (may be empty when the model answers with
   *   tool calls instead of words); `toolCalls` = every DISTINCT call across
   *   chunks (observed quirk: ornith-1.5:9b emitted six identical
   *   read_active_page calls in one response — identical (name, args) pairs
   *   are duplicates by definition for stateless functions, keep first).
   *   Empty when unused. `usage` = REAL token counts reported by Ollama on
   *   the final stream chunk (`prompt_eval_count`/`eval_count`) —
   *   promptTokens is what the model actually consumed;
   *   null when the server build omits the counters.
   */
  async chatStream(settings, req, { signal, onToken, onThinking }) {
    const wireMessages = req.messages.map((m) => ({
      role: m.role,
      content: m.content,
      // Tool-calling fields: the echoed assistant tool_calls and
      // each tool result's name MUST reach the wire or the follow-up makes
      // no sense to the model. Absent on ordinary messages → identical
      // request to pre-tools.
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_name ? { tool_name: m.tool_name } : {}),
      ...(m.images && m.images.length ? { images: m.images } : {}),
    }));
    const res = await fetch(`${this.baseUrl(settings)}/api/chat`, {
      method: "POST",
      headers: this.headers(settings.apiKey),
      body: JSON.stringify({
        model: req.model,
        stream: true,
        messages: wireMessages,
        options: req.options || {},
        // Tool-calling pass-through; omitted when not in use so
        // older server versions see an identical request to before.
        ...(req.tools && req.tools.length ? { tools: req.tools } : {}),
      }),
      signal,
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 200);
      } catch (_) {
        /* no body */
      }
      throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let usage = null; // filled from the final chunk's counters
    const toolCalls = [];
    const seenCalls = new Set();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const obj = JSON.parse(line);
        if (obj.error) throw new Error(obj.error);
        const tok = obj.message && obj.message.content;
        if (tok) {
          full += tok;
          onToken(tok);
        }
        // Reasoning models stream internal thinking in
        // message.thinking ahead of content. Optional callback — callers
        // that don't pass one (compaction) simply ignore the field, and
        // the wire builder above never maps it back, so it can't loop.
        if (onThinking) {
          const th = obj.message && obj.message.thinking;
          if (th) onThinking(th);
        }
        // Tool calls (docs: “Tool calling with streaming”): gather every
        // chunk. Arguments arrive as an object or a JSON string depending
        // on the server build — normalise to an object.
        const tcs = obj.message && obj.message.tool_calls;
        if (tcs && tcs.length) {
          for (const tc of tcs) {
            let args = tc.function.arguments;
            if (typeof args === "string") args = JSON.parse(args);
            args = args || {};
            // Dedup: identical (name, args) within one response carry no
            // extra information (see @returns). Keeps first occurrence.
            const key = `${tc.function.name}::${JSON.stringify(args)}`;
            if (seenCalls.has(key)) continue;
            seenCalls.add(key);
            toolCalls.push({ name: tc.function.name, args });
          }
        }
        if (obj.done) {
          // Ollama reports token counts on the done chunk; older builds may
          // omit them — absence is normal, not an error.
          const p = typeof obj.prompt_eval_count === "number" ? obj.prompt_eval_count : null;
          const e = typeof obj.eval_count === "number" ? obj.eval_count : null;
          usage = p !== null || e !== null ? { promptTokens: p, completionTokens: e } : null;
          return { text: full, toolCalls, usage };
        }
      }
    }
    return { text: full, toolCalls, usage }; // stream ended without explicit done
  },

  /**
   * Translate a transport failure into something actionable.
   * Only the unreachable-host case gets special treatment — it's the one
   * observed in practice and the one browsers report uselessly.
   * Everything else is surfaced verbatim under one generic prefix.
   */
  explainError(err) {
    const m = err && err.message ? String(err.message) : String(err);
    if (err && err.name === "AbortError") return m; // internal; callers handle aborts separately
    if (/failed to fetch|networkerror/i.test(m)) {
      return "Couldn't reach the Ollama host — is it running, and is the host:port reachable from this machine?";
    }
    return `Ollama request failed: ${m}`;
  }
};
