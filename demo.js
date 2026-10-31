// ?demo 주소로 열면 마이크와 API 없이 실제 이벤트 형식의 가짜 대화를 재생한다 (화면 점검용)
const SCRIPT = [
  { speaker: 0, words: ['I', ' think', ' we', ' should', ' leave', ' before', ' the', ' rain', ' starts.'], ko: '비가 오기 전에 출발해야 할 것 같아요.', partial: ['제 생각에는…', '우리가 떠나야…', '비가 오기 전에 떠나야…'] },
  { speaker: 1, words: ['駅', 'まで', 'は', '歩いて', '十分', 'くらい', 'です。'], ko: '역까지는 걸어서 10분 정도예요.', partial: ['역까지는…', '역까지는 걸어서…', '역까지는 걸어서 10분…'] },
  { speaker: 0, words: ['그럼', ' 지금', ' 바로', ' 나가는', ' 게', ' 좋겠네요.'] },
  { speaker: 2, words: ['Excuse', ' me,', ' is', ' this', ' seat', ' taken?'], ko: '실례합니다, 여기 자리 있나요?', partial: [] },
  { speaker: 1, words: ['傘', 'を', '持って', 'いきましょう。'], ko: '우산을 가져갑시다.', partial: ['우산을…'] },
  { speaker: 0, words: ['Good', ' idea,', ' let', ' me', ' grab', ' my', ' jacket', ' too.'], ko: '좋은 생각이에요, 제 재킷도 챙길게요.', partial: ['좋은 생각이에요…', '좋은 생각이에요, 제가…'] },
];

export function startDemo({ startTurn, onServerEvent, setSegmenter, makeSpeakerUpdate, paintMeter }) {
  let stopped = false;
  const finals = new Map();
  const partials = new Map();
  setSegmenter({ topSpeakers: () => [0, 1], setMargin() {}, flush() {} });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const meter = setInterval(() => paintMeter(-30 - Math.random() * 12, true), 120);
  window.__demoStop = () => { stopped = true; clearInterval(meter); };

  (async () => {
    for (let i = 0; i < SCRIPT.length && !stopped; i++) {
      const line = SCRIPT[i];
      const id = 1000 + i, item = `item_${i}`;
      const text = line.words.join('');
      finals.set(text, line.ko);
      startTurn(id);
      makeSpeakerUpdate(id, line.speaker);
      let so_far = '';
      for (const word of line.words) {
        if (stopped) return;
        so_far += word;
        partials.set(so_far, line.partial?.shift() ?? partials.get(so_far.slice(0, -word.length)) ?? '…');
        onServerEvent({ type: 'conversation.item.input_audio_transcription.delta', item_id: item, content_index: 0, delta: word });
        await sleep(window.__demoSpeed ?? 280);
      }
      onServerEvent({ type: 'input_audio_buffer.committed', item_id: item });
      onServerEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: item, content_index: 0, transcript: text });
      await sleep(window.__demoSpeed ?? 500);
    }
    clearInterval(meter);
  })();

  return {
    async translate(text, { partial }) {
      await sleep(120);
      return partial ? partials.get(text) ?? '…' : finals.get(text) ?? text;
    },
  };
}
