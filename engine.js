// 음성 분석 엔진: 큰 목소리 감지, 발화 구간 분리, 목소리 구별 (브라우저 API에 의존하지 않음)
export const SAMPLE_RATE = 24000;
export const FRAME = 960; // 40ms
const FRAME_MS = 40;
const FFT_SIZE = 1024;
const BANDS = 12;
export const SENSITIVITY = { near: 16, normal: 11, far: 7 }; // 소음 대비 필요한 dB

const hann = Float32Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));

function magnitudes(frame) {
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  // 960 샘플을 1024로 패딩한 뒤 비트 역순 정렬
  for (let i = 0, j = 0; i < FFT_SIZE; i++) {
    re[j] = i < FRAME ? frame[i] * hann[i] : 0;
    let bit = FFT_SIZE >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
  }
  for (let size = 2; size <= FFT_SIZE; size <<= 1) {
    const step = (-2 * Math.PI) / size;
    for (let start = 0; start < FFT_SIZE; start += size) {
      for (let k = 0; k < size / 2; k++) {
        const c = Math.cos(step * k), s = Math.sin(step * k);
        const a = start + k, b = a + size / 2;
        const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
  const mag = new Float32Array(FFT_SIZE / 2);
  for (let i = 0; i < mag.length; i++) mag[i] = re[i] * re[i] + im[i] * im[i];
  return mag;
}

const bandEdges = Array.from({ length: BANDS + 1 }, (_, i) => {
  const hz = 200 * Math.pow(5000 / 200, i / BANDS);
  return Math.round((hz / SAMPLE_RATE) * FFT_SIZE);
});

export function levelDb(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return 10 * Math.log10(sum / frame.length + 1e-10);
}

function pitch(frame) {
  const minLag = Math.floor(SAMPLE_RATE / 400), maxLag = Math.floor(SAMPLE_RATE / 70);
  const n = FRAME - maxLag;
  let energy = 0;
  for (let i = 0; i < n; i++) energy += frame[i] * frame[i];
  if (energy < 1e-7) return { f0: 0, strength: 0 };
  let best = 0, bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0, e2 = 0;
    for (let i = 0; i < n; i++) { corr += frame[i] * frame[i + lag]; e2 += frame[i + lag] * frame[i + lag]; }
    const r = corr / Math.sqrt(energy * e2 + 1e-12);
    if (r > best) { best = r; bestLag = lag; }
  }
  return { f0: bestLag ? SAMPLE_RATE / bestLag : 0, strength: best };
}

// 유성음 프레임의 목소리 특징: [음높이(반음), 음색 대역 12개(dB, 평균 제거)]
export function voiceFeatures(frame) {
  const { f0, strength } = pitch(frame);
  if (strength < 0.5) return null;
  const mag = magnitudes(frame);
  const vec = new Float32Array(BANDS + 1);
  vec[0] = 12 * Math.log2(f0 / 100);
  let mean = 0;
  for (let b = 0; b < BANDS; b++) {
    let sum = 1e-9;
    for (let i = bandEdges[b]; i < Math.max(bandEdges[b + 1], bandEdges[b] + 1); i++) sum += mag[i];
    vec[b + 1] = 10 * Math.log10(sum);
    mean += vec[b + 1] / BANDS;
  }
  for (let b = 1; b <= BANDS; b++) vec[b] -= mean;
  return vec;
}

export function voiceDistance(a, b) {
  let timbre = 0;
  for (let i = 1; i <= BANDS; i++) timbre += (a[i] - b[i]) ** 2;
  return Math.abs(a[0] - b[0]) * 0.35 + Math.sqrt(timbre / BANDS) * 0.12;
}

const SAME_VOICE = 2.0;

class Average {
  constructor() { this.n = 0; this.mean = new Float32Array(BANDS + 1); }
  add(v) {
    this.n++;
    for (let i = 0; i <= BANDS; i++) this.mean[i] += (v[i] - this.mean[i]) / this.n;
  }
}

// 이번 세션에서 들린 목소리들을 기억하고 큰 순서로 고른다
export class SpeakerTracker {
  constructor() { this.speakers = []; }
  identify(vec) {
    let best = null, bestD = Infinity;
    for (const s of this.speakers) {
      const d = voiceDistance(vec, s.avg.mean);
      if (d < bestD) { bestD = d; best = s; }
    }
    if (best && bestD < SAME_VOICE) return best;
    if (this.speakers.length >= 8) return best;
    const created = { id: this.speakers.length, avg: new Average(), level: -60, lastMs: 0 };
    this.speakers.push(created);
    return created;
  }
  learn(speaker, vec, db, nowMs) {
    if (speaker.avg.n < 500) speaker.avg.add(vec);
    speaker.level = speaker.lastMs ? speaker.level * 0.97 + db * 0.03 : db;
    speaker.lastMs = nowMs;
  }
  // 최근 40초 안에 들린 목소리 중 큰 두 개
  top(nowMs, count = 2) {
    return this.speakers
      .filter((s) => nowMs - s.lastMs < 40000)
      .sort((a, b) => b.level - a.level)
      .slice(0, count)
      .map((s) => s.id);
  }
}

// 큰 목소리만 통과시키는 문턱: 주변 소음과 최근 가장 큰 소리를 함께 기준으로 삼는다
export class LoudVoiceGate {
  constructor(margin) { this.margin = margin; this.floor = -55; this.peak = -60; this.above = 0; this.quietFrames = 0; this.open = false; }
  process(db) {
    this.floor += db < this.floor ? (db - this.floor) * 0.25 : 0.02;
    this.peak = Math.max(db, this.peak - 0.04);
    const gate = Math.max(this.floor + this.margin, this.peak - 18, -52);
    const loud = db > gate;
    if (loud) { this.above++; this.quietFrames = 0; } else { this.above = 0; this.quietFrames++; }
    if (!this.open && this.above >= 3) this.open = true;
    return { loud, quietMs: this.quietFrames * FRAME_MS };
  }
}

const PREROLL_FRAMES = 8;
const END_SILENCE_MS = 600;
const SOFT_MAX_MS = 8000, SOFT_SILENCE_MS = 240, HARD_MAX_MS = 15000;
const SPLIT_WINDOW = 12, SPLIT_CONFIRM = 10;

// 40ms 프레임을 받아 발화(turn)의 시작·오디오·화자·끝을 알려 준다
export class Segmenter {
  constructor({ margin, onStart, onAudio, onSpeaker, onEnd }) {
    Object.assign(this, { onStart, onAudio, onSpeaker, onEnd });
    this.gate = new LoudVoiceGate(margin);
    this.tracker = new SpeakerTracker();
    this.preroll = [];
    this.turn = null;
    this.nextId = 1;
    this.clock = 0;
  }
  setMargin(margin) { this.gate.margin = margin; }
  topSpeakers() { return this.tracker.top(this.clock); }

  process(frame) {
    this.clock += FRAME_MS;
    const db = levelDb(frame);
    const { loud, quietMs } = this.gate.process(db);
    const pcm = toPcm16(frame);

    if (!this.turn) {
      if (this.gate.above >= 3) {
        this.begin();
        for (const p of this.preroll) this.onAudio(p);
        this.preroll = [];
      } else {
        this.preroll.push(pcm);
        if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
        return { db, loud, active: false };
      }
    }

    this.onAudio(pcm);
    const t = this.turn;
    if (loud) {
      const vec = voiceFeatures(frame);
      if (vec) this.observe(t, vec, db);
    }
    if (this.turn === t) {
      const age = this.clock - t.startMs;
      if (quietMs >= END_SILENCE_MS || age >= HARD_MAX_MS || (age >= SOFT_MAX_MS && quietMs >= SOFT_SILENCE_MS)) this.finish();
    }
    return { db, loud, active: !!this.turn };
  }

  // 정지할 때 진행 중인 발화를 마무리한다
  flush() { if (this.turn) this.finish(); }

  begin() {
    this.turn = { id: this.nextId++, startMs: this.clock, avg: new Average(), voiced: 0, window: [], changed: 0, speaker: null };
    this.onStart(this.turn.id);
  }

  observe(t, vec, db) {
    t.voiced++;
    t.window.push(vec);
    if (t.window.length > SPLIT_WINDOW) t.window.shift();

    if (t.speaker) {
      const recent = new Average();
      t.window.forEach((v) => recent.add(v));
      const differs = t.window.length === SPLIT_WINDOW && voiceDistance(recent.mean, t.avg.mean) > SAME_VOICE;
      t.changed = differs ? t.changed + 1 : 0;
      if (t.changed >= SPLIT_CONFIRM) {
        // 다른 목소리로 바뀌었다: 지금까지를 끝내고 새 발화로 이어 간다
        this.finish();
        this.begin();
        const next = this.turn;
        const carry = t.window.slice(-SPLIT_CONFIRM);
        carry.forEach((v) => { next.avg.add(v); next.window.push(v); next.voiced++; });
        this.assign(next, db);
        return;
      }
      if (t.changed === 0) { t.avg.add(vec); this.tracker.learn(t.speaker, vec, db, this.clock); }
    } else {
      t.avg.add(vec);
      if (t.avg.n >= 8) this.assign(t, db);
    }
  }

  assign(t, db) {
    t.speaker = this.tracker.identify(t.avg.mean);
    this.tracker.learn(t.speaker, t.avg.mean, db, this.clock);
    this.onSpeaker(t.id, t.speaker.id);
  }

  finish() {
    const t = this.turn;
    this.turn = null;
    this.gate.above = 0;
    this.onEnd(t.id, { voiced: t.voiced });
  }
}

export function toPcm16(frame) {
  const out = new Int16Array(frame.length);
  for (let i = 0; i < frame.length; i++) {
    const s = Math.max(-1, Math.min(1, frame[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// 글자 종류로 언어를 판별한다 (한국어·영어·일본어)
export function detectLang(text) {
  let hangul = 0, kana = 0, han = 0, latin = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x3131 && c <= 0x318e)) hangul++;
    else if (c >= 0x3040 && c <= 0x30ff) kana++;
    else if (c >= 0x4e00 && c <= 0x9fff) han++;
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) latin++;
  }
  if (hangul && hangul >= kana + han && hangul * 2 >= latin) return 'ko';
  if (kana || han > latin) return 'ja';
  if (latin) return 'en';
  return hangul ? 'ko' : null;
}
