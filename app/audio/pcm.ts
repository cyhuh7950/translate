/**
 * PCM 배관 — Float32 ↔ PCM16, 리샘플, 프레이밍, WAV 읽기.
 *
 * 이 파일은 `web/static/capture-worklet.js` 를 옮긴 것이다. 웹에서는 오디오 렌더링
 * 스레드(AudioWorklet)에서 돌던 계산인데, 앱에서는 `react-native-audio-api` 의
 * `AudioRecorder.onAudioReady` 가 이미 프레임을 나눠서 JS 로 올려주므로 여기서 한다.
 *
 * **숫자가 없다.** 목표 샘플레이트도 프레임 길이도 전부 인자로 들어오고, 그 값은
 * `/v1/config` 의 `audio.stt_sample_rate` / `stream.client_frame_ms` 에서 온 것이다.
 *
 * 리샘플러가 여기 남아 있는 이유
 * ------------------------------
 * 라이브러리가 원하는 샘플레이트로 맞춰주기는 하지만, 문서가 "기기 사정에 따라 실제 값은
 * 다를 수 있다"고 못박고 있다(`AudioRecorder.onAudioReady` 의 doc comment). 서버는
 * 선언한 레이트와 다르면 조용히 리샘플하지 않고 `stream.sample_rate` 오류로 끊으므로,
 * 실제로 온 버퍼의 `sampleRate` 를 보고 어긋나면 앱이 맞춘다.
 *
 * 이 파일은 react-native 를 import 하지 않는다 — 순수 계산이라 그럴 이유가 없다.
 */

/* ---- Float32 → PCM16 -------------------------------------------------------- */

/**
 * [-1,1] 실수 하나를 PCM16 한 칸으로.
 *
 * 음수 쪽이 한 칸 더 넓다(-32768..32767). 같은 배수로 곱하면 최대 진폭에서 넘치므로
 * 부호별로 다른 배수를 쓴다 — capture-worklet.js 와 같은 계산이다.
 */
export function toPcm16(sample: number): number {
  let s = sample;
  if (s > 1) s = 1;
  else if (s < -1) s = -1;
  return Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
}

/** 반대 방향. 재생할 때 쓴다. */
export function pcm16ToFloat32(pcm: Int16Array): Float32Array<ArrayBuffer> {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) {
    out[i] = (pcm[i] as number) / 0x8000;
  }
  return out;
}

/* ---- 리샘플 ----------------------------------------------------------------- */

/**
 * 선형 보간 리샘플러. 블록 경계를 넘어가며 이어서 쓴다.
 *
 * 다음 샘플이 있어야 보간되므로 블록 끝의 자투리는 다음 블록으로 넘긴다. 그 상태가
 * `pos`(다음에 뽑을 위치, 음수면 직전 블록 끝과의 사이)와 `prev`(직전 블록의 마지막 샘플)다.
 */
export class LinearResampler {
  /** 1 이면 리샘플이 필요 없다. */
  readonly ratio: number;
  private pos = 0;
  private prev = 0;

  constructor(inputRate: number, outputRate: number) {
    this.ratio = inputRate / outputRate;
  }

  get identity(): boolean {
    return this.ratio === 1;
  }

  /** 블록 하나를 흘려보낸다. 나온 샘플마다 `emit` 이 불린다. */
  push(block: Float32Array, emit: (sample: number) => void): void {
    const n = block.length;
    if (n === 0) return;

    if (this.ratio === 1) {
      for (let i = 0; i < n; i += 1) emit(block[i] as number);
      return;
    }

    let p = this.pos;
    while (Math.floor(p) + 1 < n) {
      const i = Math.floor(p);
      const frac = p - i;
      const a = i < 0 ? this.prev : (block[i] as number);
      const b = block[i + 1] as number;
      emit(a + (b - a) * frac);
      p += this.ratio;
    }
    this.prev = block[n - 1] as number;
    this.pos = p - n; // 다음 블록 좌표로 옮긴다
  }

  reset(): void {
    this.pos = 0;
    this.prev = 0;
  }
}

/* ---- 프레이밍 --------------------------------------------------------------- */

/**
 * 샘플을 모아 **정확히 `frameSamples` 개**짜리 PCM16 프레임으로 내보낸다.
 *
 * 라이브러리가 요청한 길이대로 올려주는 것이 정상이지만(안드로이드 네이티브가 원형 버퍼에
 * 모았다가 그 길이로 끊는다), 그것을 믿지 않고 여기서 한 번 더 맞춘다. 서버는 프레임 길이가
 * 달라도 받아주지만, VAD 가 프레임 단위로 도는 만큼 규격대로 보내는 편이 낫다.
 */
export class PcmFramer {
  private readonly frame: Int16Array;
  private filled = 0;

  constructor(
    private readonly frameSamples: number,
    private readonly onFrame: (frame: ArrayBuffer) => void,
  ) {
    this.frame = new Int16Array(frameSamples);
  }

  /** Float32 샘플 하나. 프레임이 차면 그때 `onFrame` 이 불린다. */
  push(sample: number): void {
    this.frame[this.filled] = toPcm16(sample);
    this.filled += 1;
    if (this.filled === this.frameSamples) {
      this.filled = 0;
      // 복사본을 넘긴다 — 호출자가 WebSocket 으로 보내는 동안 다음 프레임이 덮어쓰지 않게.
      this.onFrame(new Int16Array(this.frame).buffer);
    }
  }

  /** 채우다 만 프레임을 버린다. 세션을 다시 열 때. */
  reset(): void {
    this.filled = 0;
  }
}

/* ---- 레벨 ------------------------------------------------------------------- */

/**
 * 프레임 하나의 RMS 를 0..1 로. **화면 표현일 뿐**이라 프로토콜과도 설정과도 무관하다.
 * `floorDb` 아래는 0 으로 본다 (웹의 레벨 미터와 같은 계산).
 */
export function frameLevel(frame: ArrayBuffer, floorDb: number): number {
  const pcm = new Int16Array(frame);
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const v = pcm[i] as number;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / pcm.length) / 0x8000;
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (db + floorDb) / floorDb));
}

/* ---- 서버가 보낸 오디오 읽기 ------------------------------------------------- */

export interface DecodedAudio {
  /**
   * 모노로 합친 [-1,1] 샘플.
   *
   * 버퍼 종류를 `ArrayBuffer` 로 못박은 것은 재생기가 이 배열을 그대로
   * `AudioBuffer.copyToChannel()` 에 넘기기 때문이다 — 그쪽 선언이
   * `Float32Array<ArrayBuffer>` 라 `SharedArrayBuffer` 를 받지 않는다.
   */
  samples: Float32Array<ArrayBuffer>;
  sampleRate: number;
  /** 원본 채널 수. 2 면 여기서 합쳤다는 뜻이다. */
  channels: number;
  /** 무엇으로 읽었는지 — 화면에 그대로 띄워 진단에 쓴다. */
  container: 'wav' | 'pcm16';
}

/**
 * `tts.chunk` 뒤에 온 바이너리를 재생할 수 있는 형태로 바꾼다.
 *
 * 서버 기본값은 `audio.tts_response_format: wav` 라 RIFF 헤더가 붙어 온다. 헤더가 없으면
 * 원시 PCM16 으로 보고 `fallbackRate` 를 쓴다 — 그 값은 이벤트의 `sr` 이다.
 *
 * **샘플레이트는 반드시 이 오디오 자신의 것을 쓴다.** 입력(16kHz)과 다르다 —
 * 합성 엔진이 정하는 값이고 실측 44100 이다.
 *
 * 읽을 수 없으면 던진다. 조용히 이상한 소리를 내는 것보다 화면에 이유가 뜨는 편이 낫다.
 */
export function decodeAudioChunk(bytes: ArrayBuffer, fallbackRate: number): DecodedAudio {
  const wav = readWav(bytes);
  if (wav) return wav;

  if (!fallbackRate || fallbackRate <= 0) {
    throw new Error('오디오에 WAV 헤더가 없고 tts.chunk 의 sr 도 비어 있어 재생 규격을 알 수 없다.');
  }
  const pcm = new Int16Array(bytes.byteLength >= 2 ? bytes.slice(0, bytes.byteLength - (bytes.byteLength % 2)) : new ArrayBuffer(0));
  return { samples: pcm16ToFloat32(pcm), sampleRate: fallbackRate, channels: 1, container: 'pcm16' };
}

/** RIFF/WAVE 면 읽고, 아니면 null. 청크를 순회하는 것은 fmt 와 data 사이에 다른 청크가 끼기 때문이다. */
function readWav(bytes: ArrayBuffer): DecodedAudio | null {
  if (bytes.byteLength < 12) return null;
  const view = new DataView(bytes);
  if (tag(view, 0) !== 'RIFF' || tag(view, 8) !== 'WAVE') return null;

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataAt = -1;
  let dataLength = 0;

  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const id = tag(view, at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ' && body + 16 <= bytes.byteLength) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataAt = body;
      dataLength = Math.min(size, bytes.byteLength - body);
    }
    // 청크는 짝수 바이트로 정렬된다.
    at = body + size + (size % 2);
  }

  if (dataAt < 0 || channels < 1 || sampleRate < 1) {
    throw new Error('WAV 헤더를 읽지 못했다 (fmt/data 청크가 없다).');
  }

  // 1 = PCM 정수, 3 = IEEE float. 서버 기본 경로는 1/16bit 다.
  if (format === 1 && bits === 16) {
    const count = Math.floor(dataLength / 2);
    const pcm = new Int16Array(count);
    for (let i = 0; i < count; i += 1) pcm[i] = view.getInt16(dataAt + i * 2, true);
    return { samples: downmix(pcm16ToFloat32(pcm), channels), sampleRate, channels, container: 'wav' };
  }
  if (format === 3 && bits === 32) {
    const count = Math.floor(dataLength / 4);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i += 1) out[i] = view.getFloat32(dataAt + i * 4, true);
    return { samples: downmix(out, channels), sampleRate, channels, container: 'wav' };
  }

  throw new Error(`재생할 수 없는 WAV 형식이다 (format=${format}, bits=${bits}).`);
}

function tag(view: DataView, at: number): string {
  return String.fromCharCode(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3),
  );
}

/** 채널이 여럿이면 평균으로 모노를 만든다. 재생기는 모노 하나만 연다. */
function downmix(interleaved: Float32Array<ArrayBuffer>, channels: number): Float32Array<ArrayBuffer> {
  if (channels <= 1) return interleaved;
  const frames = Math.floor(interleaved.length / channels);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += interleaved[f * channels + c] as number;
    out[f] = sum / channels;
  }
  return out;
}

/* ---- 화자 등록 클립 쓰기 ------------------------------------------------------
 *
 * 화자 등록(`/v1/speakers/enroll`)은 캡처와 반대 방향이다 — 마이크가 준 PCM16 프레임을
 * 모아 서버에 파일로 올려야 한다. 여기 두 함수가 그 변환을 맡는다. 둘 다 순수 계산이고,
 * `readWav()` 가 읽는 것과 정확히 대칭이 되는 것을 `__tests__/pcm.test.ts` 의 왕복
 * (encode → decode) 테스트로 확인한다.
 */

/** `MicCapture.onFrame` 이 준 PCM16 프레임(ArrayBuffer) 여러 개를 하나로 이어붙인다. */
export function concatPcm16(frames: ArrayBuffer[]): Int16Array {
  let total = 0;
  for (const frame of frames) total += frame.byteLength / 2;
  const out = new Int16Array(total);
  let at = 0;
  for (const frame of frames) {
    const chunk = new Int16Array(frame);
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * PCM16 샘플에 표준 44바이트 WAV(RIFF) 헤더를 씌운다. `readWav()` 가 읽는 형식
 * (`format=1` PCM 정수, `bits=16`) 과 정확히 대칭이다 — 여기서 인코딩한 것을 그 함수로
 * 다시 읽으면 샘플이 그대로 나와야 한다.
 *
 * 화자 등록 클립을 멀티파트로 올릴 때 쓴다. 서버는 파일(오디오 컨테이너)을 받지
 * PCM16 프레임을 받지 않으므로, 프레임을 이어붙인 뒤(`concatPcm16`) 여기서 헤더를 씌운다.
 */
export function encodeWav(samples: Int16Array, sampleRate: number, channels = 1): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt 청크 길이 (PCM 은 16)
  view.setUint16(20, 1, true); // 1 = PCM 정수
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); // byte rate
  view.setUint16(32, channels * 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(44 + i * 2, samples[i] as number, true);
  }
  return buffer;
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * 순수 base64 인코더. RN 에는 `btoa` 가 없고(JS 엔진에 따라 없을 수 있다), 이 인코딩
 * 하나를 위해 의존성을 늘리지 않으려고 직접 짰다 — 등록 클립을 `data:` URI 로 감싸
 * RN 의 `FormData` 에 올릴 때 쓴다(`ui/EnrollScreen.tsx`). 3바이트씩 훑으며 문자만
 * 이어 붙이므로 긴 클립에서도 계산량은 선형이다.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = i + 1 < len ? (bytes[i + 1] as number) : 0;
    const b2 = i + 2 < len ? (bytes[i + 2] as number) : 0;
    out += BASE64_CHARS[b0 >> 2];
    out += BASE64_CHARS[((b0 & 0x3) << 4) | (b1 >> 4)];
    out += i + 1 < len ? BASE64_CHARS[((b1 & 0xf) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < len ? BASE64_CHARS[b2 & 0x3f] : '=';
  }
  return out;
}
