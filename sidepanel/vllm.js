/**
 * vLLM / OpenAI-compatible backend adapter.
 *
 * The second implementation of the neutral three-method backend interface,
 * alongside OllamaBackend. It speaks the OpenAI
 * `/v1/chat/completions` wire format that vLLM serves. The sidebar talks only
 * to `backend`, so registering this in BACKENDS needs no UI change beyond the
 * selector.
 *
 * Verified against a live vLLM (v0.31.0):
 *   - GET  /v1/models           -> { data: [ { id, max_model_len, ... } ] }
 *   - POST /v1/chat/completions -> SSE: `data: {json}` lines, ends `data: [DONE]`
 *   - a stream delta carries `content` and/or `reasoning` (reasoning models)
 *   - the final chunk has an EMPTY choices[] plus usage (requires
 *     stream_options.include_usage)
 *   - unknown request params are SILENTLY IGNORED, not rejected
 *
 * Scope: text chat (content + reasoning + usage) plus OpenAI function
 * calling — tool schemas are forwarded, streamed tool_calls are
 * accumulated by index and returned as { name, args, id }, and the wire
 * mapper threads tool_call_id back through the loop.
 */

"use strict";

/**
 * Map one client-side message onto the OpenAI wire shape. Returns an ARRAY
 * because a tool result that carries images expands into TWO wire messages
 * (the text result + a user message holding the pixels) — OpenAI cannot put
 * image parts on a role:"tool" message. Ordinary messages map 1:1.
 */
function toWireMessages(m) {
  // Tool result: OpenAI uses role:"tool" + tool_call_id. When a vision
  // tool returns images, relay them as a follow-up user message with image
  // parts — the OpenAI way to feed pixels back to the model.
  if (m.role === "tool") {
    const out = [{ role: "tool", tool_call_id: m.tool_call_id, content: m.content }];
    if (m.images && m.images.length) {
      out.push({
        role: "user",
        content: [
          { type: "text", text: "Screenshot captured by the tool:" },
          ...m.images.map((b64) => ({
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${b64}` },
          })),
        ],
      });
    }
    return out;
  }
  // Assistant tool-call echo: the id came from the model's response;
  // arguments must be a JSON string on the wire (the client model keeps them
  // as an object).
  if (m.role === "assistant" && m.tool_calls && m.tool_calls.length) {
    return [{
      role: "assistant",
      content: m.content || "",
      tool_calls: m.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.function.name,
          arguments: JSON.stringify(tc.function.arguments),
        },
      })),
    }];
  }
  if (m.images && m.images.length) {
    const parts = [];
    if (m.content) parts.push({ type: "text", text: m.content });
    for (const b64 of m.images) {
      parts.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${b64}` },
      });
    }
    return [{ role: m.role, content: parts }];
  }
  return [{ role: m.role, content: m.content }];
}

const VllmBackend = {
  /** Base URL. vLLM serves the OpenAI API under /v1. */
  baseUrl({ host, port }) {
    return `http://${host}:${port}/v1`;
  },

  /** Same auth shape as Ollama — vLLM honours a Bearer token. */
  headers(apiKey) {
    const h = { "Content-Type": "application/json" };
    if (apiKey) h.Authorization = `Bearer ${apiKey}`;
    return h;
  },

  /**
   * List model names from GET /v1/models.
   * @returns {Promise<string[]>} model ids exactly as reported
   *   (e.g. "nvidia/Qwen3.8-27B-NVFP4")
   */
  async listModels(settings, timeoutMs = 5000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl(settings)}/models`, {
        headers: this.headers(settings.apiKey),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body.data)) throw new Error("Unexpected /v1/models response shape");
      return body.data.map((m) => m.id);
    } catch (err) {
      if (err.name === "AbortError") throw new Error("Connection timed out");
      throw new Error(this.explainError(err));
    } finally {
      clearTimeout(timer);
    }
  },

  /**
   * Per-model context window from GET /v1/models (data[].max_model_len).
   * vLLM reports no capabilities array, so capabilities is empty here —
   * vision support comes from the per-model "Vision Model?" flag instead.
   */
  async modelDetails(settings, timeoutMs = 5000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl(settings)}/models`, {
        headers: this.headers(settings.apiKey),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body.data)) throw new Error("Unexpected /v1/models response shape");
      const contexts = {};
      for (const m of body.data) {
        const n = m.max_model_len;
        if (typeof n === "number" && Number.isFinite(n) && n > 0) contexts[m.id] = n;
      }
      return { contexts, capabilities: {} };
    } catch (err) {
      if (err.name === "AbortError") throw new Error("Connection timed out");
      throw new Error(this.explainError(err));
    } finally {
      clearTimeout(timer);
    }
  },

  /**
   * Streaming chat via POST /v1/chat/completions (SSE).
   *
   * Sampling: the send path hands us Ollama-shaped `options`
   * ({ temperature, num_ctx }). We forward `temperature` as a top-level OpenAI
   * field and DROP `num_ctx` (an Ollama concept — vLLM sizes the window via
   * max_model_len / max_tokens, not num_ctx).
   *
   * @param {{host:string, port:number, apiKey?:string}} settings
   * @param {{model:string, messages:Array, options?:Object, tools?:Array}} req
   * @param {{signal:AbortSignal, onToken:(t:string)=>void,
   *        onThinking?:((t:string)=>void)}} hooks
   * @returns {Promise<{text:string, toolCalls:Array<{name:string,args:Object,id?:string}>,
   *          usage:{promptTokens:number|null, completionTokens:number|null}|null}>}
   *   `toolCalls` = every call the model requested, as { name, args, id } (id
   *   is the OpenAI tool_call id; args is the parsed arguments object). Empty
   *   when the model answers in words. `usage` = real token counts from the
   *   final chunk (prompt_tokens / completion_tokens).
   */
  async chatStream(settings, req, { signal, onToken, onThinking }) {
    const wireMessages = req.messages.flatMap(toWireMessages);
    const body = {
      model: req.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: wireMessages,
      // Tool schemas: the same {type:"function", function:{…}} shape
      // Ollama uses, so the send path's req.tools passes through unchanged.
      // Omitted when empty so a tool-less turn is a plain chat request.
      ...(req.tools && req.tools.length ? { tools: req.tools } : {}),
    };
    // Sampling params: forward the whole bag as top-level OpenAI fields.
    // num_ctx is Ollama-only — vLLM sizes the window via max_model_len, so it
    // is dropped here (an unknown top-level field would be ignored anyway).
    if (req.options) {
      for (const [k, v] of Object.entries(req.options)) {
        if (k === "num_ctx") continue;
        body[k] = v;
      }
    }

    const res = await fetch(`${this.baseUrl(settings)}/chat/completions`, {
      method: "POST",
      headers: this.headers(settings.apiKey),
      body: JSON.stringify(body),
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
    let usage = null;
    // Tool-call accumulation: OpenAI streams each call by `index` — the
    // first chunk carries id + function.name, later chunks append
    // function.arguments as string fragments. Accumulate per index, parse at
    // the end. (Mirrors the Ollama adapter's normalise-to-object contract.)
    const tcAcc = {};
    const finish = () => ({
      text: full,
      usage,
      toolCalls: Object.values(tcAcc).map((acc) => ({
        name: acc.name,
        args: acc.argsStr ? JSON.parse(acc.argsStr) : {},
        id: acc.id,
      })),
    });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return finish();
        let obj;
        try {
          obj = JSON.parse(payload);
        } catch (_) {
          continue; // non-JSON keepalive / comment line — skip
        }
        const choice = obj.choices && obj.choices[0];
        const delta = choice && choice.delta;
        if (delta) {
          if (delta.content) {
            full += delta.content;
            onToken(delta.content);
          }
          if (onThinking && delta.reasoning) onThinking(delta.reasoning);
          if (delta.tool_calls && delta.tool_calls.length) {
            for (const tc of delta.tool_calls) {
              const acc =
                tcAcc[tc.index] || (tcAcc[tc.index] = { id: "", name: "", argsStr: "" });
              if (tc.id) acc.id = tc.id;
              if (tc.function && tc.function.name) acc.name = tc.function.name;
              if (tc.function && typeof tc.function.arguments === "string")
                acc.argsStr += tc.function.arguments;
            }
          }
        }
        // The final usage chunk carries an empty choices[] plus usage.
        if (obj.usage) {
          const p =
            typeof obj.usage.prompt_tokens === "number" ? obj.usage.prompt_tokens : null;
          const c =
            typeof obj.usage.completion_tokens === "number" ? obj.usage.completion_tokens : null;
          usage = p !== null || c !== null ? { promptTokens: p, completionTokens: c } : null;
        }
      }
    }
    return finish(); // stream ended without [DONE]
  },

  /**
   * Translate a transport failure into something actionable. Mirrors the
   * Ollama adapter: only the unreachable-host case gets special wording.
   */
  explainError(err) {
    const m = err && err.message ? String(err.message) : String(err);
    if (err && err.name === "AbortError") return m; // internal; callers handle aborts
    if (/failed to fetch|networkerror/i.test(m)) {
      return "Couldn't reach the vLLM host — is it running, and is host:port/v1 reachable from this machine?";
    }
    return `vLLM request failed: ${m}`;
  }
};
