const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function adapter(fetch) {
  const ctx = vm.createContext({ fetch, AbortSignal, TextDecoder });
  vm.runInContext(fs.readFileSync('sidepanel/openrouter.js', 'utf8') + '\nglobalThis.adapter = OpenRouterBackend;', ctx);
  return ctx.adapter;
}
test('streams split tool arguments, reasoning, usage and final line without newline', async () => {
  let request;
  const chunks = [': keepalive\r\n\r\ndata: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello', reasoning: 'think', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'open_url', arguments: '{"url":' } }] } }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"https://example.com"}' } }] } }], usage: { prompt_tokens: 12, completion_tokens: 3 } })];
  const backend = adapter(async (url, opts) => { request = JSON.parse(opts.body); return new Response(new ReadableStream({ start(c) { for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk)); c.close(); } })); });
  backend.models = [{ id: 'test', supported_parameters: ['tools'] }];
  let text = '', thinking = '';
  const result = await backend.chatStream({ openrouterApiKey: 'secret' }, { model: 'test', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function' }] }, { onToken: t => text += t, onThinking: t => thinking += t });
  assert.equal(text, 'Hello'); assert.equal(thinking, 'think');
  assert.equal(result.toolCalls[0].id, 'call_1');
  assert.equal(result.toolCalls[0].args.url, 'https://example.com');
  assert.equal(result.usage.promptTokens, 12); assert.equal(request.tools.length, 1);
});
test('maps tool IDs and screenshots and omits tools on unsupported models', async () => {
  let request;
  const backend = adapter(async (_, opts) => { request = JSON.parse(opts.body); return new Response('data: [DONE]\n\n'); });
  await backend.chatStream({}, { model: 'text', tools: [{}], messages: [
    { role: 'assistant', content: '', tool_calls: [{ id: 'abc', function: { name: 'capture_screenshot', arguments: {} } }], reasoning_details: [{ type: 'reasoning.text', text: 'reason' }] },
    { role: 'tool', tool_call_id: 'abc', content: 'screenshot', images: ['AAAA'] },
  ] }, { onToken() {} });
  assert.equal(request.tools, undefined);
  assert.equal(request.messages[0].tool_calls[0].function.arguments, '{}');
  assert.equal(request.messages[0].reasoning_details[0].text, 'reason');
  assert.equal(request.messages[1].tool_call_id, 'abc');
  assert.equal(request.messages[2].content[1].image_url.url, 'data:image/jpeg;base64,AAAA');
});
test('connection rejects invalid credentials', async () => {
  const backend = adapter(async () => new Response(JSON.stringify({ error: { message: 'Invalid key' } }), { status: 401 }));
  await assert.rejects(backend.listModels({ openrouterApiKey: 'bad' }), /401.*Invalid key/);
});
test('surfaces streaming errors', async () => {
  const backend = adapter(async () => new Response('data: {"error":{"message":"Rate limited"}}\n'));
  await assert.rejects(backend.chatStream({}, { messages: [] }, { onToken() {} }), /Rate limited/);
});
