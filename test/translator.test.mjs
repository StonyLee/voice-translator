// 번역 스트리밍을 가짜 응답으로 점검한다: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { Translator, Transcriber, FIELDS } from '../api.js';

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

test('스페인어와 중국어도 언어 이름과 추정 번역 규칙을 넣어 요청한다', async () => {
  const bodies = stubFetch(sse(piece('네')), sse(piece('네')));
  const tr = new Translator({ key: 'k', model: 'm', fast: false });
  await tr.translate('Hola amigo', { lang: 'es', partial: true });
  await tr.translate('你好', { lang: 'zh', partial: true });
  assert.match(bodies[0].messages[0].content, /스페인어.*추정/);
  assert.match(bodies[1].messages[0].content, /중국어.*추정/);
});

test('분야 힌트를 음성 인식과 번역 요청에 넣는다', async () => {
  const stt = new Transcriber({ key: 'k', model: 'm', languages: ['ko'], delay: 'medium', field: FIELDS.legal });
  stt.send = () => {};
  const on = stt.audioConfig().transcription;
  assert.equal(on.prompt, FIELDS.legal.prompt);
  assert.ok(on.keywords.includes('준거법'));
  assert.equal(on.delay, 'medium');
  stt.setField(null);
  assert.deepEqual([stt.audioConfig().transcription.prompt, stt.audioConfig().transcription.keywords], ['', []]);
  stt.setField(FIELDS.construction);
  stt.receive({ type: 'error', error: { message: 'Invalid keywords' } });
  assert.equal(stt.audioConfig().transcription.keywords, undefined);

  const bodies = stubFetch(sse(piece('네')));
  await new Translator({ key: 'k', model: 'm', field: FIELDS.construction }).translate('Yes', { lang: 'en', partial: false });
  assert.match(bodies[0].messages[0].content, /건설/);
});

test('내 용어만 있어도 힌트를 보내고 번역 규칙에 undefined가 들어가지 않는다', async () => {
  const stt = new Transcriber({ key: 'k', model: 'm', languages: ['ko'], delay: 'medium', field: { keywords: ['현장A'] } });
  const on = JSON.parse(JSON.stringify(stt.audioConfig().transcription));
  assert.deepEqual(on.keywords, ['현장A']);
  assert.equal('prompt' in on, false);
  const bodies = stubFetch(sse(piece('네')));
  await new Translator({ key: 'k', model: 'm', field: null }).translate('Oui', { lang: 'fr', partial: true });
  assert.match(bodies[0].messages[0].content, /프랑스어/);
  assert.doesNotMatch(bodies[0].messages[0].content, /undefined/);
});

test('분야 키워드에 금지 문자가 없다', () => {
  for (const { keywords } of Object.values(FIELDS)) for (const k of keywords) assert.doesNotMatch(k, /[<>\r\n]/);
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
