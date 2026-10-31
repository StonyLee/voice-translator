// 번역 스트리밍을 가짜 응답으로 점검한다: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { Translator } from '../api.js';

function sse(...parts) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(c) { parts.forEach((p) => c.enqueue(encoder.encode(p))); c.close(); },
  }), { status: 200 });
}
const piece = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

function stubFetch(...responses) {
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return responses.shift();
  };
  return bodies;
}

test('네트워크 조각이 줄 중간에서 잘려도 번역문을 순서대로 넘긴다', async () => {
  const whole = piece('안녕') + piece('하세요') + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`;
  stubFetch(sse(whole.slice(0, 20), whole.slice(20)));
  const seen = [], usage = [], latency = [];
  const tr = new Translator({ key: 'k', model: 'm', fast: true, onUsage: (u, fast) => usage.push([u.prompt_tokens, fast]), onLatency: (ms) => latency.push(ms) });
  const out = await tr.translate('Hello', { lang: 'en', partial: false, onText: (t) => seen.push(t) });
  assert.equal(out, '안녕하세요');
  assert.deepEqual(seen, ['안녕', '안녕하세요']);
  assert.deepEqual(usage, [[7, true]]);
  assert.equal(latency.length, 1);
});

test('빠른 모드가 거절되면 빼고 다시 요청한다', async () => {
  const bodies = stubFetch(
    new Response(JSON.stringify({ error: { message: 'Unsupported service_tier' } }), { status: 400 }),
    sse(piece('네')),
  );
  const tr = new Translator({ key: 'k', model: 'm', fast: true });
  assert.equal(await tr.translate('Yes', { lang: 'en', partial: false }), '네');
  assert.equal(bodies[0].service_tier, 'fast');
  assert.equal(bodies[1].service_tier, undefined);
  assert.equal(bodies[1].stream, true);
});

test('없는 모델이면 다음 모델로 넘어간다', async () => {
  const bodies = stubFetch(
    new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 }),
    sse(piece('네')),
  );
  const tr = new Translator({ key: 'k', model: 'none', fast: false });
  assert.equal(await tr.translate('Yes', { lang: 'en', partial: false }), '네');
  assert.notEqual(bodies[1].model, 'none');
});
