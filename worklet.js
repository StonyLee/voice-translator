// 마이크 입력을 24kHz로 낮춰 40ms 프레임 단위로 넘긴다
const FRAME = 960;
const TARGET_RATE = 24000;

class MicFrames extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.frame = new Float32Array(FRAME);
    this.filled = 0;
    this.sum = 0;
    this.count = 0;
    this.phase = 0;
  }

  process(inputs) {
    const input = inputs[0][0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i];
      this.count++;
      this.phase++;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        this.frame[this.filled++] = this.sum / this.count;
        this.sum = 0;
        this.count = 0;
        if (this.filled === FRAME) {
          this.port.postMessage(this.frame, [this.frame.buffer]);
          this.frame = new Float32Array(FRAME);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('mic-frames', MicFrames);
