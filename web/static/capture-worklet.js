/*
 * 마이크 캡처 워크릿 — Float32 → PCM16 프레임.
 *
 * ScriptProcessorNode 는 폐기됐고 메인 스레드에서 돌아 GC 에 밀린다.
 * AudioWorklet 은 오디오 렌더링 스레드에서 돌아 프레임이 밀리지 않는다.
 *
 * 이 파일에도 숫자가 없다. 목표 샘플레이트와 프레임 길이는 노드를 만들 때
 * processorOptions 로 들어오고, 그 값은 /v1/config 의
 * audio.stt_sample_rate / stream.client_frame_ms 에서 온 것이다.
 *
 * 리샘플링을 여기서 하는 이유
 * ---------------------------
 * AudioContext 를 목표 레이트로 열 수 있으면(대부분의 브라우저) 브라우저가 알아서
 * 맞춰주지만, 레이트 지정을 받지 않는 브라우저에서는 컨텍스트가 기기 기본값
 * (보통 44.1k/48k)으로 열린다. 서버는 선언한 레이트와 다르면 조용히 리샘플하지 않고
 * 오류를 낸다 — 그러니 클라이언트가 맞춰서 보내야 한다.
 * 전역 `sampleRate` 가 이 워크릿의 입력 레이트다.
 */

// 노드를 만들 때 쓰는 이름. app.js 의 CAPTURE_PROCESSOR 와 같아야 한다.
// registerProcessor 는 정적 문자열만 받으므로 두 곳에 같은 이름이 있다.
const PROCESSOR_NAME = 'capture-processor';

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    if (!opts.targetSampleRate || !opts.frameMs) {
      // 설정이 안 왔는데 임의의 값을 지어내지 않는다. 조용히 틀린 오디오를 보내는 것보다
      // 여기서 죽는 편이 어디가 어긋났는지 드러난다.
      throw new Error('capture worklet requires targetSampleRate and frameMs');
    }
    this.outRate = opts.targetSampleRate;
    this.frameSamples = Math.max(1, Math.round((this.outRate * opts.frameMs) / 1000));
    this.ratio = sampleRate / this.outRate;   // 1 이면 리샘플이 필요 없다
    this.frame = new Int16Array(this.frameSamples);
    this.filled = 0;
    this.pos = 0;        // 다음에 뽑을 위치. 현재 블록 기준이고 음수면 직전 블록 끝과의 사이다
    this.prev = 0;       // 직전 블록의 마지막 샘플 (블록 경계 보간용)
    this.running = true;
    this.port.onmessage = (event) => {
      if (event.data === 'stop') this.running = false;
    };
  }

  /** [-1,1] Float32 하나를 PCM16 으로 담고, 프레임이 차면 메인 스레드로 보낸다. */
  push(sample) {
    let s = sample;
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    // 음수 쪽이 한 칸 더 넓다. 같은 배수로 곱하면 최대 진폭에서 넘친다.
    this.frame[this.filled] = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
    this.filled += 1;
    if (this.filled === this.frameSamples) {
      const copy = new Int16Array(this.frame);
      this.filled = 0;
      // 버퍼를 넘겨버린다(복사 없음). 메인 스레드는 그대로 WebSocket 으로 보낸다.
      this.port.postMessage(copy.buffer, [copy.buffer]);
    }
  }

  process(inputs) {
    if (!this.running) return false;         // 노드가 정리되게 둔다
    const input = inputs[0];
    if (!input || !input.length) return true;
    const channel = input[0];                 // mono — 노드를 1채널로 만든다
    if (!channel || !channel.length) return true;
    const n = channel.length;

    if (this.ratio === 1) {
      for (let i = 0; i < n; i += 1) this.push(channel[i]);
      return true;
    }

    // 선형 보간. 다음 샘플이 있어야 보간되므로 블록 끝의 자투리는 다음 블록으로 넘긴다.
    let p = this.pos;
    while (Math.floor(p) + 1 < n) {
      const i = Math.floor(p);
      const frac = p - i;
      const a = i < 0 ? this.prev : channel[i];
      const b = channel[i + 1];
      this.push(a + (b - a) * frac);
      p += this.ratio;
    }
    this.prev = channel[n - 1];
    this.pos = p - n;                         // 다음 블록 좌표로 옮긴다
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, CaptureProcessor);
