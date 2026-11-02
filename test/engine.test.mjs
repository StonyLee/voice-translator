// 합성 음성으로 엔진을 점검한다: node test/engine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Segmenter, SENSITIVITY, PEAK_RANGE, FRAME, SAMPLE_RATE, detectLang } from '../engine.js';

// 음높이(f0)와 포먼트가 다른 유성음. 프레임 사이에 위상이 이어지도록 샘플 위치를 받는다
function voice(start, f0, formant, amp) {
  const out = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) {
    const t = (start + i) / SAMPLE_RATE;
    const vibrato = (0.01 * f0 / 4) * Math.sin(2 * Math.PI * 4 * t);
    let s = 0;
    for (let h = 1; h <= 20; h++) {
      const hz = f0 * h;
      s += Math.sin(2 * Math.PI * h * (f0 * t + vibrato / (2 * Math.PI))) * Math.exp(-(((hz - formant) / 900) ** 2));
    }
    out[i] = (s / 3) * amp;
  }
  return out;
}

function silence(amp = 0.001) {
  return Float32Array.from({ length: FRAME }, () => (Math.random() - 0.5) * amp);
}

function run(script, options = {}) {
  const log = { started: [], ended: [], speakers: new Map(), audio: 0 };
  const seg = new Segmenter({
    margin: SENSITIVITY.normal,
    ...options,
    onStart: (id) => log.started.push(id),
    onAudio: (p) => { log.audio += p.length; },
    onSpeaker: (id, s) => log.speakers.set(id, s),
    onEnd: (id, info) => log.ended.push({ id, ...info }),
  });
  let pos = 0;
  for (const [make, ms] of script) {
    for (let n = 0; n < ms / 40; n++) { seg.process(make(pos)); pos += FRAME; }
  }
  return { seg, log };
}

const low = (p) => voice(p, 115, 600, 0.25);
const high = (p) => voice(p, 225, 1500, 0.25);
const quiet = () => silence();

test('조용하면 발화가 생기지 않고 오디오도 보내지 않는다', () => {
  const { log } = run([[quiet, 3000]]);
  assert.equal(log.started.length, 0);
  assert.equal(log.audio, 0);
});

test('말이 끝나면 발화 하나로 커밋한다', () => {
  const { log } = run([[quiet, 1000], [low, 2000], [quiet, 1000]]);
  assert.equal(log.started.length, 1);
  assert.equal(log.ended.length, 1);
  assert.ok(log.ended[0].voiced > 20);
});

test('번갈아 말하면 두 목소리로 구별하고 같은 목소리는 다시 알아본다', () => {
  const { log } = run([[quiet, 1000], [low, 1500], [quiet, 800], [high, 1500], [quiet, 800], [low, 1500], [quiet, 800]]);
  assert.equal(log.started.length, 3);
  const [a, b, c] = log.started.map((id) => log.speakers.get(id));
  assert.notEqual(a, b);
  assert.equal(a, c);
});

test('쉬지 않고 목소리가 바뀌면 발화를 나눈다', () => {
  const { log } = run([[quiet, 1000], [low, 2500], [high, 2500], [quiet, 800]]);
  assert.equal(log.started.length, 2);
  const [a, b] = log.started.map((id) => log.speakers.get(id));
  assert.notEqual(a, b);
});

test('큰 목소리 직후의 작은 목소리는 무시한다', () => {
  const faint = (p) => voice(p, 225, 1500, 0.01);
  const { log } = run([[quiet, 1000], [low, 2000], [faint, 1500]]);
  // 큰 목소리 발화 하나만 생기고, 작은 소리로 새 발화가 시작되지 않는다
  assert.equal(log.started.length, 1);
});

const faraway = (p) => voice(p, 225, 1500, 0.25 * 10 ** (-24 / 20));
const talks = [[quiet, 1000], [low, 2000], [quiet, 1000], [faraway, 2000], [quiet, 1000]];

test('회의 모드는 24dB 작은 목소리도 보낸다', () => {
  assert.equal(run(talks).log.started.length, 1);
  assert.equal(run(talks, { meeting: true }).log.started.length, 2);
});

test('큰 목소리 모드의 듣는 범위가 실제로 작은 목소리에 영향을 준다', () => {
  assert.equal(run(talks, { peakRange: PEAK_RANGE.normal }).log.started.length, 1);
  assert.equal(run(talks, { peakRange: PEAK_RANGE.far, margin: SENSITIVITY.far }).log.started.length, 2);
});

test('회의 모드는 0.7초 쉼에서 문장을 끊지 않고 목소리가 바뀌어도 나누지 않는다', () => {
  const pause = [[quiet, 1000], [low, 1500], [quiet, 700], [low, 1500], [quiet, 1000]];
  assert.equal(run(pause).log.started.length, 2);
  assert.equal(run(pause, { meeting: true }).log.started.length, 1);
  assert.equal(run([[quiet, 1000], [low, 2500], [high, 2500], [quiet, 1000]], { meeting: true }).log.started.length, 1);
});

test('세 목소리 중 큰 두 개를 고른다', () => {
  const third = (p) => voice(p, 330, 2600, 0.08);
  const { seg, log } = run([[quiet, 1000], [low, 1500], [quiet, 800], [high, 1500], [quiet, 800], [third, 1500], [quiet, 800]]);
  const ids = new Set(log.speakers.values());
  assert.equal(ids.size, 3);
  const top = seg.topSpeakers();
  assert.equal(top.length, 2);
  assert.ok(top.includes(log.speakers.get(log.started[0])));
  assert.ok(top.includes(log.speakers.get(log.started[1])));
});

test('글자로 언어를 판별한다', () => {
  assert.equal(detectLang('안녕하세요 반갑습니다'), 'ko');
  assert.equal(detectLang('Hello there'), 'en');
  assert.equal(detectLang('こんにちは'), 'ja');
  assert.equal(detectLang('東京駅'), 'ja');
  assert.equal(detectLang('오늘 meeting 있어요'), 'ko');
  assert.equal(detectLang('123'), null);
});
