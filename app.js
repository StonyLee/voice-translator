import { Segmenter, SENSITIVITY, detectLang } from './engine.js';
import { Transcriber, Translator, ApiError, checkKey, fetchUsdKrw, DEFAULT_STT_MODEL, DEFAULT_TRANSLATE_MODEL } from './api.js';

const $ = (id) => document.getElementById(id);
const DEMO = new URLSearchParams(location.search).has('demo');
const SETTINGS_KEY = 'rt-settings';
const DRAFT_KEY = 'rt-draft';
const VOICE_COLORS = ['#f2b35e', '#5fd0c5', '#ef8f9f', '#a99cf0', '#a9d36a', '#6db8ef', '#e6a0d8', '#d0c28a'];
const LANG_LABEL = { auto: '자동 (영어, 일본어)', ko: '한국어', en: 'English', ja: '日本語', es: 'Español', zh: '中文' };
const LANG_TAG = { ko: '한국어', en: 'EN', ja: '日本語', es: 'ES', zh: '中文' };
const isForeign = (lang) => lang in PARTIAL_GAP;
const STAGE_HOLD_MS = 9000;
const PARTIAL_GAP = { ja: 200, en: 450, es: 450, zh: 450 };
const HEARING_HOLD_MS = 1500;
const APP_VERSION = 11; // sw.js의 CACHE 번호와 맞춘다
const RATE_KEY = 'rt-rate';
// 한 시간 내내 외국어를 듣는 경우의 추정: 음성 인식 $0.017×60분 + 번역 약 $0.30 (초당 2회, gpt-6-luna 일반 기준, 빠른 모드는 2배)
const usdPerHour = () => 0.017 * 60 + (settings.fast ? 0.6 : 0.3);
const USAGE_KEY = 'rt-usage';
const USD_PER_AUDIO_SEC = 0.017 / 60;
const USD_PER_INPUT_TOKEN = 0.1 / 1e6, USD_PER_OUTPUT_TOKEN = 0.5 / 1e6; // gpt-6-luna 기준

function readJson(key, storage = localStorage) {
  try { return JSON.parse(storage.getItem(key)); } catch { return null; }
}
function writeLocal(key, value) {
  try { localStorage.setItem(key, value); } catch { /* 저장 공간 없음 */ }
}

const settings = {
  key: '', stt: DEFAULT_STT_MODEL, trans: DEFAULT_TRANSLATE_MODEL, lang: 'auto', sens: 'normal', delay: 'minimal', fast: true, flip: false,
  ...readJson(SETTINGS_KEY),
};
const saveSettings = () => writeLocal(SETTINGS_KEY, JSON.stringify(settings));

// 기록
let turns = [];
const byId = new Map();
const byItem = new Map();
let savedAt = 0; // 마지막 저장 시점의 완료 발화 수
const stage = [];

// 실행 상태
let running = false, exited = false, segmenter, transcriber, translator, audio, wakeLock, awakeVideo, draftTimer, usdKrw, hearingTimer, translateMs;
const unsavedUsage = { audioSec: 0, inTok: 0, outTok: 0 };

const hasRecord = () => turns.some((t) => t.text && !t.noise);
const isDirty = () => turns.filter((t) => t.text && !t.noise).length > savedAt;

function toast(message, ms = 5000) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, ms);
}

function explain(err) {
  if (err instanceof ApiError && err.status === 401) return 'API 키가 맞지 않아요. 설정에서 확인해 주세요.';
  if (err instanceof ApiError && err.status === 429) return '사용 한도를 넘었어요. OpenAI 결제·한도를 확인해 주세요.';
  return `오류: ${err.message}`;
}

/* ---------- 발화 표시 ---------- */

function voiceName(id) { return `목소리 ${String.fromCharCode(65 + id)}`; }

function makeElement(t) {
  const el = document.createElement('article');
  el.className = 'turn';
  el.innerHTML = '<div class="who"><span class="name"></span><em class="lang"></em><span class="tag"></span></div><p class="original"></p><p class="korean"></p>';
  t.el = el;
  return el;
}

function paint(t) {
  if (!t.el) return;
  const speaker = t.speaker ?? 0;
  t.el.style.setProperty('--voice', VOICE_COLORS[speaker % VOICE_COLORS.length]);
  t.el.querySelector('.name').textContent = voiceName(speaker);
  t.el.querySelector('.lang').textContent = LANG_TAG[t.lang] || '';
  const foreign = isForeign(t.lang);
  t.el.classList.toggle('ko', !foreign);
  t.el.classList.toggle('partial', foreign && t.koState !== 'final');
  t.el.querySelector('.original').textContent = t.text;
  t.el.querySelector('.korean').textContent = foreign ? (t.ko || '…') : t.text;
  let tag = '';
  if (foreign && t.koState === 'partial') tag = t.lang === 'ja' ? '실시간 번역' : '추정 번역';
  if (foreign && t.koState === 'failed') tag = '번역 실패';
  t.el.querySelector('.tag').textContent = tag;
  if (stage.includes(t)) $('stage').scrollTop = $('stage').scrollHeight;
}

function nearBottom() {
  const h = $('history');
  return h.scrollHeight - h.scrollTop - h.clientHeight < 60;
}

function toHistory(t) {
  const i = stage.indexOf(t);
  if (i >= 0) stage.splice(i, 1);
  if (!t.el) return;
  const follow = nearBottom();
  $('history').append(t.el);
  if (follow) $('history').scrollTop = $('history').scrollHeight;
  else $('jump').hidden = false;
  refreshPlaceholder();
}

function refreshPlaceholder() {
  const p = $('placeholder');
  p.hidden = stage.length > 0;
  p.textContent = running ? '듣고 있어요…' : (hasRecord() ? '' : '마이크를 누르면 듣기 시작해요');
}

// 화면 중앙에는 목소리별 최신 발화 하나씩, 최대 두 개만 둔다
function placeOnStage(t) {
  for (const other of [...stage]) {
    if (other !== t && other.speaker === t.speaker) toHistory(other);
  }
  if (!stage.includes(t)) {
    while (stage.length >= 2) toHistory(stage[0]);
    stage.push(t);
    if (!t.el) makeElement(t);
    $('stage').append(t.el);
  }
  refreshPlaceholder();
}

function isTopVoice(t) {
  if (t.speaker == null || !segmenter) return true;
  const top = segmenter.topSpeakers();
  return top.length === 0 || top.includes(t.speaker);
}

function update(t) {
  if (t.noise || !t.text) return;
  t.lang = settings.lang !== 'auto' ? settings.lang : detectLang(t.text) || t.lang;
  t.hiddenVoice = !isTopVoice(t);
  if (t.hiddenVoice) {
    if (stage.includes(t)) { stage.splice(stage.indexOf(t), 1); t.el?.remove(); t.el = null; refreshPlaceholder(); }
    return;
  }
  if (!t.el || (!t.done && !stage.includes(t) && !t.el.isConnected)) placeOnStage(t);
  else if (stage.includes(t)) placeOnStage(t);
  paint(t);
}

/* ---------- 번역 ---------- */

const needsTranslation = (t) => isForeign(t.lang) && !t.hiddenVoice && !t.noise;

function context(t) {
  return turns.filter((o) => o !== t && o.done && o.text && !o.noise).slice(-2).map((o) => o.text);
}

function schedulePartial(t) {
  if (!needsTranslation(t) || t.done || t.busy || t.timer) return;
  if ((t.lang === 'en' || t.lang === 'es') && t.text.trim().split(/\s+/).length < 2) return;
  const wait = Math.max(0, t.lastRequest + PARTIAL_GAP[t.lang] - Date.now());
  t.timer = setTimeout(() => runPartial(t), wait);
}

// 새 번역이 도착하는 중에는 이미 보이는 번역보다 길어질 때부터 바꿔, 글자가 줄었다 늘었다 하지 않게 한다
function showStreaming(t, text) {
  if (text.length < t.ko.replace(/…$/, '').length) return;
  t.ko = text;
  paint(t);
}

async function runPartial(t) {
  t.timer = null;
  if (t.done) return;
  const source = t.text;
  t.busy = true;
  t.lastRequest = Date.now();
  t.abort = new AbortController();
  try {
    const ko = await translator.translate(source, {
      lang: t.lang, partial: true, context: context(t), signal: t.abort.signal,
      onText: (text) => { if (!t.done) { t.koState = 'partial'; showStreaming(t, text); } },
    });
    if (!t.done) { t.ko = ko; t.koState = 'partial'; paint(t); }
  } catch (err) {
    if (err.name !== 'AbortError') toast(explain(err));
  } finally {
    t.busy = false;
  }
  if (!t.done && t.text !== source) schedulePartial(t);
}

async function translateFinal(t) {
  clearTimeout(t.timer);
  t.abort?.abort();
  if (!needsTranslation(t)) return;
  const hadPartial = !!t.ko;
  try {
    t.ko = await translator.translate(t.text, {
      lang: t.lang, partial: false, context: context(t),
      onText: (text) => showStreaming(t, text),
    });
    t.koState = 'final';
    if (hadPartial && t.el) {
      t.el.classList.remove('corrected');
      void t.el.offsetWidth;
      t.el.classList.add('corrected');
    }
  } catch (err) {
    t.koState = 'failed';
    toast(explain(err));
  }
  paint(t);
  queueDraft();
}

/* ---------- 전사 이벤트 ---------- */

function startTurn(id) {
  const t = { id, itemId: null, speaker: null, lang: settings.lang === 'auto' ? null : settings.lang, text: '', ko: '', koState: 'none', done: false, noise: false, lastRequest: 0, time: Date.now() };
  turns.push(t);
  byId.set(id, t);
}

function bind(itemId) {
  if (byItem.has(itemId)) return byItem.get(itemId);
  const t = turns.find((o) => !o.itemId && !o.done);
  if (t) { t.itemId = itemId; byItem.set(itemId, t); }
  return t;
}

function finishTurn(t) {
  t.done = true;
  t.doneAt = Date.now();
  if (!t.text.trim() || t.noise) {
    if (t.el) { stage.includes(t) && stage.splice(stage.indexOf(t), 1); t.el.remove(); refreshPlaceholder(); }
    t.noise = true;
    return;
  }
  update(t);
  translateFinal(t);
  queueDraft();
}

function onServerEvent(evt) {
  switch (evt.type) {
    case 'input_audio_buffer.committed':
      bind(evt.item_id);
      break;
    case 'conversation.item.input_audio_transcription.delta': {
      const t = bind(evt.item_id);
      if (!t || t.done || !evt.delta) break;
      t.text += evt.delta;
      update(t);
      schedulePartial(t);
      break;
    }
    case 'conversation.item.input_audio_transcription.completed': {
      const t = bind(evt.item_id);
      if (!t || t.done) break;
      if (evt.transcript != null) t.text = evt.transcript.trim();
      finishTurn(t);
      break;
    }
    case 'conversation.item.input_audio_transcription.failed': {
      const t = bind(evt.item_id);
      if (t && !t.done) finishTurn(t);
      break;
    }
  }
}

// 연결이 끊기면 응답을 받을 수 없는 발화를 지금까지의 글자로 마무리한다
function settleOpenTurns() {
  turns.filter((t) => !t.done).forEach(finishTurn);
}

/* ---------- 듣기 시작·정지 ---------- */

function showListening() {
  const speed = translateMs ? ` · 번역 응답 ${(translateMs / 1000).toFixed(1)}초` : '';
  $('status').textContent = `듣는 중 · ${LANG_LABEL[settings.lang]}${speed}`;
}

function setRunning(on) {
  running = on;
  $('m-mic').classList.toggle('on', on);
  $('m-mic').setAttribute('aria-label', on ? '듣기 정지' : '듣기 시작');
  if (on) showListening();
  else {
    $('status').textContent = '대기 중';
    paintMeter(-90, false);
    clearTimeout(hearingTimer);
    $('live').classList.remove('hearing');
  }
  refreshPlaceholder();
}

const languageHints = () => (settings.lang === 'auto' ? ['ko', 'en', 'ja'] : [settings.lang]);

function makeSegmenter() {
  return new Segmenter({
    margin: SENSITIVITY[settings.sens],
    onStart: startTurn,
    onAudio: (pcm) => {
      unsavedUsage.audioSec += pcm.length / 24000;
      transcriber.audio(pcm);
    },
    onSpeaker: (id, speaker) => {
      const t = byId.get(id);
      t.speaker = speaker;
      if (t.text) update(t);
    },
    onEnd: (id, { voiced }) => {
      const t = byId.get(id);
      if (voiced < 3) t.noise = true;
      transcriber.commit();
    },
  });
}

async function start() {
  if (!settings.key && !DEMO) {
    openSettings();
    toast('먼저 OpenAI API 키를 입력해 주세요.');
    return;
  }
  if (running) return;
  $('m-mic').disabled = true;
  try {
    translator = new Translator({
      key: settings.key, model: settings.trans, fast: settings.fast,
      // 빠른 모드는 토큰 단가가 2배라 요금 계산용 토큰 수도 2배로 기록한다
      onUsage: ({ prompt_tokens = 0, completion_tokens = 0 }, fast) => {
        unsavedUsage.inTok += prompt_tokens * (fast ? 2 : 1);
        unsavedUsage.outTok += completion_tokens * (fast ? 2 : 1);
      },
      onLatency: (ms) => {
        translateMs = ms;
        if (running) showListening();
      },
    });
    if (DEMO) {
      const { startDemo } = await import('./demo.js');
      translator = startDemo({ startTurn, onServerEvent, setSegmenter: (s) => { segmenter = s; }, byId, makeSpeakerUpdate: (id, sp) => { byId.get(id).speaker = sp; }, paintMeter });
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, noiseSuppression: true, echoCancellation: true, autoGainControl: false },
      });
      transcriber = new Transcriber({
        key: settings.key, model: settings.stt, languages: languageHints(), delay: settings.delay,
        onEvent: (evt) => {
          if (evt.type === 'session.created' && running) showListening();
          onServerEvent(evt);
        },
        onError: (err) => toast(explain(err)),
        onDisconnect: () => {
          segmenter?.flush();
          settleOpenTurns();
          $('status').textContent = '연결이 끊겨 다시 연결하는 중…';
        },
      });
      await transcriber.connect();
      segmenter = makeSegmenter();
      await startAudio(stream);
    }
    setRunning(true);
  } catch (err) {
    stopAudio();
    transcriber?.close();
    if (err.name === 'NotAllowedError') toast('마이크 권한이 필요해요. 브라우저 설정에서 허용해 주세요.');
    else toast(explain(err));
    if (err instanceof ApiError && err.status === 401) openSettings();
  } finally {
    $('m-mic').disabled = false;
  }
}

async function startAudio(stream) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  await ctx.audioWorklet.addModule('worklet.js');
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'mic-frames', { numberOfOutputs: 1 });
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(node).connect(mute).connect(ctx.destination);
  node.port.onmessage = (e) => {
    const { db, loud } = segmenter.process(e.data);
    paintMeter(db, loud);
  };
  await ctx.resume();
  audio = { ctx, stream, node };
}

function stopAudio() {
  if (!audio) return;
  audio.node.port.onmessage = null;
  audio.stream.getTracks().forEach((track) => track.stop());
  audio.ctx.close();
  audio = null;
}

async function stop() {
  if (!running) return;
  stopAudio();
  segmenter?.flush();
  setRunning(false);
  if (transcriber) {
    const closing = transcriber;
    transcriber = null;
    await waitForOpenTurns(3000);
    closing.close();
    settleOpenTurns();
  }
  if (DEMO) { window.__demoStop?.(); settleOpenTurns(); }
}

function waitForOpenTurns(limit) {
  const started = Date.now();
  return new Promise((resolve) => {
    const check = () => (turns.every((t) => t.done) || Date.now() - started > limit ? resolve() : setTimeout(check, 100));
    check();
  });
}

// 앱이 켜져 있는 동안 화면이 꺼지지 않게 한다 (듣기 정지 중에도 유지)
async function keepScreenOn() {
  if (exited || document.visibilityState !== 'visible' || (wakeLock && !wakeLock.released)) return;
  try {
    if (!navigator.wakeLock) throw new Error('unsupported');
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { if (!exited) keepScreenOn(); });
    stopAwakeVideo();
  } catch {
    startAwakeVideo();
  }
}

// Wake Lock을 못 쓰는 브라우저용 대안: 보이지 않는 무음 영상을 계속 재생한다
function startAwakeVideo() {
  if (awakeVideo) { awakeVideo.play().catch(() => {}); return; }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 2;
  if (!canvas.captureStream) return;
  awakeVideo = Object.assign(document.createElement('video'), { muted: true, playsInline: true, loop: true, srcObject: canvas.captureStream(1) });
  awakeVideo.setAttribute('playsinline', '');
  awakeVideo.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.append(awakeVideo);
  awakeVideo.play().catch(() => {});
}

function stopAwakeVideo() {
  awakeVideo?.remove();
  awakeVideo = null;
}

function releaseScreen() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  stopAwakeVideo();
}

/* ---------- 예상 요금 ---------- */

const today = () => new Date().toLocaleDateString('sv');

function showCost(rate) {
  usdKrw = rate;
  paintUsage();
  const won = Math.round((usdPerHour() * rate) / 10) * 10;
  $('cost').textContent = `한 시간 사용에 약 ${won.toLocaleString('ko-KR')}원입니다.`;
  $('cost').title = `1달러 ${Math.round(rate).toLocaleString('ko-KR')}원 기준`;
  $('cost').hidden = false;
}

async function refreshCost() {
  const cached = readJson(RATE_KEY);
  if (cached?.rate) showCost(cached.rate);
  if (cached?.date === today()) return;
  try {
    const rate = await fetchUsdKrw();
    writeLocal(RATE_KEY, JSON.stringify({ date: today(), rate }));
    showCost(rate);
  } catch { /* 오프라인이면 마지막 환율을 유지하고 다음에 다시 시도 */ }
}

/* ---------- 최근 30일 사용량 (이 휴대폰에서 실제로 보낸 음성과 번역 토큰을 날짜별로 기록) ---------- */

function flushUsage() {
  if (!unsavedUsage.audioSec && !unsavedUsage.inTok && !unsavedUsage.outTok) return;
  const log = readJson(USAGE_KEY) || {};
  const day = (log[today()] ||= { audioSec: 0, inTok: 0, outTok: 0 });
  for (const k of Object.keys(unsavedUsage)) { day[k] += unsavedUsage[k]; unsavedUsage[k] = 0; }
  const cutoff = new Date(Date.now() - 29 * 86400000).toLocaleDateString('sv');
  for (const date of Object.keys(log)) if (date < cutoff) delete log[date];
  writeLocal(USAGE_KEY, JSON.stringify(log));
  paintUsage();
}

function paintUsage() {
  const cutoff = new Date(Date.now() - 29 * 86400000).toLocaleDateString('sv');
  const total = { audioSec: 0, inTok: 0, outTok: 0 };
  for (const [date, day] of Object.entries(readJson(USAGE_KEY) || {})) {
    if (date >= cutoff) for (const k of Object.keys(total)) total[k] += day[k];
  }
  const minutes = Math.round(total.audioSec / 60);
  const time = minutes >= 60 ? `${Math.floor(minutes / 60)}시간 ${minutes % 60}분` : `${minutes}분`;
  const usd = total.audioSec * USD_PER_AUDIO_SEC + total.inTok * USD_PER_INPUT_TOKEN + total.outTok * USD_PER_OUTPUT_TOKEN;
  const cost = usdKrw ? ` · 약 ${(Math.round((usd * usdKrw) / 10) * 10).toLocaleString('ko-KR')}원` : '';
  $('usage').textContent = `최근 30일 사용 ${time}${cost}`;
}

const bars = [...document.querySelectorAll('#meter i')];
const BAR_SHAPE = [0.55, 0.8, 0.95, 1, 0.9, 0.75, 0.5];
function paintMeter(db, loud) {
  const level = Math.max(0.12, Math.min(1, (db + 62) / 44));
  $('meter').classList.toggle('on', loud);
  if (loud) {
    $('live').classList.add('hearing');
    clearTimeout(hearingTimer);
    hearingTimer = setTimeout(() => $('live').classList.remove('hearing'), HEARING_HOLD_MS);
  }
  bars.forEach((bar, i) => { bar.style.transform = `scaleY(${Math.max(0.12, level * BAR_SHAPE[i])})`; });
}

/* ---------- 저장 ---------- */

function formatRecord() {
  const lines = ['음성번역 기록', new Date(turns[0]?.time || Date.now()).toLocaleString('ko-KR'), ''];
  for (const t of turns) {
    if (t.noise || !t.text) continue;
    const time = new Date(t.time).toLocaleTimeString('ko-KR', { hour12: false });
    const lang = LANG_TAG[t.lang] || '';
    lines.push(`[${time}] ${voiceName(t.speaker ?? 0)} (${lang})${t.hiddenVoice ? ' · 화면에 표시 안 됨' : ''}`);
    lines.push(t.text);
    if (t.ko) lines.push(`→ ${t.ko}`);
    lines.push('');
  }
  return lines.join('\n');
}

function fileName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `음성번역_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.txt`;
}

async function saveRecord() {
  if (!hasRecord()) { toast('저장할 기록이 아직 없어요.', 2500); return false; }
  const name = fileName();
  const file = new File([formatRecord()], name, { type: 'text/plain' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
    } catch (err) {
      if (err.name === 'AbortError') return false;
      download(file);
    }
  } else {
    download(file);
  }
  markSaved();
  return true;
}

function download(file) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function markSaved() {
  savedAt = turns.filter((t) => t.text && !t.noise).length;
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* 무시 */ }
}

// 휴대폰에서는 앱을 밀어 닫는 순간을 막을 수 없어, 저장 전 기록을 임시로 보관해 다음 실행 때 복구한다
function queueDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(writeDraft, 800);
}
function writeDraft() {
  if (!isDirty()) return;
  const data = turns.filter((t) => t.text && !t.noise).map(({ time, speaker, lang, text, ko, hiddenVoice }) => ({ time, speaker, lang, text, ko, hiddenVoice }));
  writeLocal(DRAFT_KEY, JSON.stringify(data));
}

function restoreDraft(data) {
  data.forEach((d, i) => {
    const t = { ...d, id: `old${i}`, done: true, noise: false, koState: d.ko ? 'final' : 'none' };
    turns.push(t);
    if (!t.hiddenVoice) {
      makeElement(t);
      paint(t);
      $('history').append(t.el);
    }
  });
  $('history').scrollTop = $('history').scrollHeight;
  refreshPlaceholder();
}

/* ---------- 메뉴와 대화상자 ---------- */

function ask(title, text, buttons) {
  return new Promise((resolve) => {
    $('c-title').textContent = title;
    $('c-text').textContent = text;
    const box = $('c-actions');
    box.replaceChildren(...buttons.map(({ label, value, style }) => {
      const b = document.createElement('button');
      b.className = style;
      b.textContent = label;
      b.onclick = () => { $('confirm').close(); resolve(value); };
      return b;
    }));
    $('confirm').oncancel = (e) => { e.preventDefault(); $('confirm').close(); resolve('cancel'); };
    $('confirm').showModal();
  });
}

async function requestExit() {
  if ($('confirm').open) return;
  if (isDirty()) {
    const choice = await ask('종료하기 전에 저장할까요?', '저장하지 않으면 이번 기록은 사라져요.', [
      { label: '저장하고 종료', value: 'save', style: 'primary' },
      { label: '저장 안 함', value: 'discard', style: 'ghost' },
      { label: '취소', value: 'cancel', style: 'plain' },
    ]);
    if (choice === 'cancel') return;
    if (choice === 'save') {
      await stop();
      if (!await saveRecord()) return; // 공유 창을 닫으면 종료하지 않는다
    }
  }
  await stop();
  clearTimeout(draftTimer);
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* 무시 */ }
  savedAt = Infinity;
  exited = true;
  releaseScreen();
  $('ended').hidden = false;
  window.close();
}

function closeOnBackdrop(dialog) {
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
}

function refreshLangMenu() {
  $('m-lang-label').textContent = LANG_LABEL[settings.lang];
  document.querySelectorAll('#lang-options button').forEach((b) => b.classList.toggle('selected', b.dataset.lang === settings.lang));
}

function refreshSens() {
  document.querySelectorAll('#s-sens button').forEach((b) => b.classList.toggle('selected', b.dataset.sens === settings.sens));
}

function refreshSpeed() {
  document.querySelectorAll('#s-delay button').forEach((b) => b.classList.toggle('selected', b.dataset.delay === settings.delay));
  document.querySelectorAll('#s-fast button').forEach((b) => b.classList.toggle('selected', (b.dataset.fast === '1') === settings.fast));
}

// API 키는 버튼을 눌렀을 때만 보이고 수정할 수 있다
function showKeyField(open) {
  $('s-key-box').hidden = !open;
  $('s-key-toggle').setAttribute('aria-expanded', open);
  $('s-key-toggle').textContent = open ? 'API 키 숨기기' : ($('s-key').value.trim() ? 'API 키 보기·수정' : 'API 키 입력');
}

function openSettings() {
  $('s-key').value = settings.key;
  showKeyField(false);
  $('s-stt').value = settings.stt;
  $('s-trans').value = settings.trans;
  $('s-result').textContent = '';
  refreshSens();
  refreshSpeed();
  $('settings-sheet').showModal();
}

function applySettings() {
  settings.key = $('s-key').value.trim();
  settings.stt = $('s-stt').value.trim() || DEFAULT_STT_MODEL;
  settings.trans = $('s-trans').value.trim() || DEFAULT_TRANSLATE_MODEL;
  saveSettings();
}

function applyFlip() {
  document.documentElement.classList.toggle('flipped', settings.flip);
  $('m-flip').setAttribute('aria-pressed', settings.flip);
}

$('m-flip').onclick = () => {
  settings.flip = !settings.flip;
  saveSettings();
  applyFlip();
};
$('m-mic').onclick = () => (running ? stop() : start());
$('m-save').onclick = saveRecord;
$('m-exit').onclick = requestExit;
$('m-lang').onclick = () => { refreshLangMenu(); $('lang-sheet').showModal(); };
$('m-settings').onclick = openSettings;
$('restart').onclick = () => location.reload();
$('jump').onclick = () => {
  $('history').scrollTop = $('history').scrollHeight;
  $('jump').hidden = true;
};
$('history').addEventListener('scroll', () => { if (nearBottom()) $('jump').hidden = true; }, { passive: true });

$('lang-options').addEventListener('click', (e) => {
  const lang = e.target.closest('button')?.dataset.lang;
  if (!lang) return;
  settings.lang = lang;
  saveSettings();
  refreshLangMenu();
  transcriber?.setLanguages(languageHints());
  if (running) showListening();
  $('lang-sheet').close();
});

$('s-sens').addEventListener('click', (e) => {
  const sens = e.target.closest('button')?.dataset.sens;
  if (!sens) return;
  settings.sens = sens;
  saveSettings();
  refreshSens();
  segmenter?.setMargin?.(SENSITIVITY[sens]);
});

$('s-delay').addEventListener('click', (e) => {
  const delay = e.target.closest('button')?.dataset.delay;
  if (!delay) return;
  settings.delay = delay;
  saveSettings();
  refreshSpeed();
  transcriber?.setDelay(delay);
});

$('s-fast').addEventListener('click', (e) => {
  const fast = e.target.closest('button')?.dataset.fast;
  if (!fast) return;
  settings.fast = fast === '1';
  saveSettings();
  refreshSpeed();
  if (translator) translator.fast = settings.fast;
  if (usdKrw) showCost(usdKrw);
});

$('s-key-toggle').onclick = () => {
  const open = $('s-key-box').hidden;
  showKeyField(open);
  if (open) $('s-key').focus();
};

$('s-done').onclick = () => { applySettings(); $('settings-sheet').close(); };
$('settings-sheet').addEventListener('close', applySettings);
$('s-test').onclick = async () => {
  $('s-result').textContent = '확인 중…';
  try {
    await checkKey($('s-key').value.trim());
    $('s-result').textContent = '키가 정상이에요.';
  } catch (err) {
    $('s-result').textContent = explain(err);
  }
};
closeOnBackdrop($('lang-sheet'));
closeOnBackdrop($('settings-sheet'));

// 무대에 오래 머문 발화는 위로 올린다
setInterval(() => {
  for (const t of [...stage]) if (t.done && Date.now() - t.doneAt > STAGE_HOLD_MS) toHistory(t);
}, 1000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { writeDraft(); flushUsage(); return; }
  keepScreenOn();
  refreshCost();
  audio?.ctx.resume();
});
// 첫 터치 전에는 화면 유지를 막는 브라우저가 있어 터치할 때마다 다시 확인한다
document.addEventListener('pointerdown', keepScreenOn);
window.addEventListener('pagehide', () => { writeDraft(); flushUsage(); });
setInterval(flushUsage, 5000);
window.addEventListener('beforeunload', (e) => { if (isDirty()) e.preventDefault(); });

// 안드로이드 뒤로 가기도 종료 확인으로 받는다
history.pushState({ app: true }, '');
window.addEventListener('popstate', () => {
  history.pushState({ app: true }, '');
  requestExit();
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  // 새 버전이 설치되면 듣는 중이거나 저장 안 한 기록이 있을 때를 빼고 바로 다시 불러온다
  const updating = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updating && !running && !isDirty()) location.reload();
  });
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

$('s-version').textContent = `앱 버전 ${APP_VERSION}`;
applyFlip();
refreshLangMenu();
refreshPlaceholder();
keepScreenOn();
paintUsage();
refreshCost();

const draft = readJson(DRAFT_KEY);
if (Array.isArray(draft) && draft.length) {
  ask('저장하지 않은 기록이 있어요', `이전 기록 ${draft.length}개를 이어서 볼까요?`, [
    { label: '복구하기', value: 'restore', style: 'primary' },
    { label: '삭제', value: 'drop', style: 'ghost' },
  ]).then((choice) => {
    if (choice === 'restore') restoreDraft(draft);
    else try { localStorage.removeItem(DRAFT_KEY); } catch { /* 무시 */ }
  });
}

if (DEMO) window.__app = { turns: () => turns, stage, formatRecord, stop, unsavedUsage, flushUsage, screen: () => ({ lock: wakeLock && !wakeLock.released, video: !!awakeVideo }) };
