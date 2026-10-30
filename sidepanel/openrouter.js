"use strict";

// OpenRouter uses OpenAI-compatible messages and server-sent events.
const OpenRouterBackend = {
  models: [],
  headers(s) { return { "Content-Type": "application/json", Authorization: `Bearer ${s.openrouterApiKey}` }; },
  async check(res) {
    if (res.ok) return;
    let detail = "";
    try { detail = (await res.json()).error?.message || ""; } catch {}
    throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
  },
  async listModels(s) {
    for (const path of ["key", "models"]) {
      const res = await fetch(`https://openrouter.ai/api/v1/${path}`, {
        headers: this.headers(s), signal: AbortSignal.timeout(10000),
      });
      await this.check(res);
      if (path === "models") {
        const body = await res.json();
        if (!Array.isArray(body.data)) throw new Error("Unexpected model catalog response");
        this.models = body.data.filter(m => m.architecture?.output_modalities?.includes("text"));
      }
    }
    return this.models.map(m => m.id).sort();
  },
  async modelDetails() {
    const contexts = {}, capabilities = {};
    for (const m of this.models) {
      contexts[m.id] = m.context_length;
      capabilities[m.id] = m.architecture?.input_modalities?.includes("image") ? ["vision"] : [];
    }
    return { contexts, capabilities };
  },
  async chatStream(s, req, { signal, onToken, onThinking }) {
    const messages = [];
    const images = m => [{ type: "text", text: m.content }, ...m.images.map(data => ({
      type: "image_url", image_url: { url: data.startsWith("data:") ? data : `data:image/jpeg;base64,${data}` },
    }))];
    for (const m of req.messages) {
      const out = { role: m.role, content: m.content };
      if (m.images?.length && m.role !== "tool") out.content = images(m);
      if (m.tool_calls) {
        out.tool_calls = m.tool_calls.map(tc => ({ id: tc.id, type: "function", function: {
          name: tc.function.name, arguments: JSON.stringify(tc.function.arguments),
        } }));
        if (m.reasoning_details) out.reasoning_details = m.reasoning_details;
      }
      if (m.role === "tool") out.tool_call_id = m.tool_call_id;
      messages.push(out);
      if (m.role === "tool" && m.images?.length) messages.push({ role: "user", content: images(m) });
    }
    const supportsTools = this.models.find(m => m.id === req.model)?.supported_parameters?.includes("tools");
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", headers: this.headers(s), signal,
      body: JSON.stringify({ model: req.model, messages, stream: true, temperature: req.options?.temperature,
        ...(supportsTools && req.tools?.length ? { tools: req.tools } : {}),
      }),
    });
    await this.check(res);
    const reader = res.body.getReader(), decoder = new TextDecoder();
    let buffer = "", text = "", usage = null;
    const calls = new Map(), reasoningDetails = [];
    const consume = line => {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return;
      const obj = JSON.parse(data);
      if (obj.error) throw new Error(obj.error.message || "Streaming request failed");
      if (obj.usage) usage = { promptTokens: obj.usage.prompt_tokens ?? null, completionTokens: obj.usage.completion_tokens ?? null };
      const delta = obj.choices?.[0]?.delta;
      if (!delta) return;
      if (delta.content) { text += delta.content; onToken(delta.content); }
      if (delta.reasoning && onThinking) onThinking(delta.reasoning);
      if (delta.reasoning_details) reasoningDetails.push(...delta.reasoning_details);
      for (const tc of delta.tool_calls || []) {
        const call = calls.get(tc.index) || { id: "", name: "", arguments: "" };
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.name += tc.function.name;
        if (tc.function?.arguments) call.arguments += tc.function.arguments;
        calls.set(tc.index, call);
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          consume(buffer.slice(0, nl).trimEnd()); buffer = buffer.slice(nl + 1);
        }
        if (done) { if (buffer.trim()) consume(buffer.trimEnd()); break; }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return { text, usage, reasoningDetails, toolCalls: [...calls.values()].map(c => ({
      id: c.id, name: c.name, args: JSON.parse(c.arguments || "{}"),
    })) };
  },
  explainError(err) { return `OpenRouter request failed: ${err.message || err}`; },
};
