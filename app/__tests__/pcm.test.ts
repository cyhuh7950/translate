/**
 * `audio/pcm.ts` 검사 — 이 계층만은 실기기 없이 확인할 수 있다.
 *
 * 캡처·재생 자체는 네이티브라 여기서 돌지 않지만, 그 사이의 계산(PCM16 변환·리샘플·
 * 프레이밍·WAV 읽기)은 순수 함수라 Node 에서 그대로 검사된다. 실기기에서 소리가
 * 이상할 때 "계산이 틀린 건지 네이티브가 틀린 건지"를 가르는 것이 이 파일의 값이다.
 *
 * 기대값의 근거는 `web/static/capture-worklet.js`(같은 계산)와 실제 서버 응답이다 —
 * 스모크 테스트가 `tts.chunk` 를 `sr=44100, audio/wav` 로 받는 것을 확인해 두었다.
 */

import {
  bytesToBase64,
  concatPcm16,
  decodeAudioChunk,
  encodeWav,
  frameLevel,
  LinearResampler,
  PcmFramer,
  pcm16ToFloat32,
  toPcm16,
} from '../audio/pcm';

/** 검사용 16bit PCM WAV 한 벌. 서버가 보내는 것과 같은 모양이다. */
function makeWav(samples: Int16Array, sampleRate: number, channels: number): ArrayBuffer {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) view.setInt16(44 + i * 2, samples[i] as number, true);
  return bytes;
}

describe('PCM16 변환', () => {
  test('넘치지 않게 자른다 (음수 쪽이 한 칸 더 넓다)', () => {
    expect(toPcm16(0)).toBe(0);
    expect(toPcm16(1)).toBe(32767);
    expect(toPcm16(-1)).toBe(-32768);
    expect(toPcm16(2)).toBe(32767);
    expect(toPcm16(-2)).toBe(-32768);
  });

  test('되돌리면 [-1,1] 안에 있다', () => {
    const back = pcm16ToFloat32(new Int16Array([0, 32767, -32768]));
    expect(back[0]).toBe(0);
    expect(back[1]).toBeCloseTo(1, 4);
    expect(back[2]).toBe(-1);
  });
});

describe('프레이밍', () => {
  test('정확히 frameSamples 개씩, 자투리는 다음 프레임으로 넘긴다', () => {
    const frames: ArrayBuffer[] = [];
    const framer = new PcmFramer(320, f => frames.push(f));
    for (let i = 0; i < 320 * 3 + 100; i += 1) framer.push(0.5);

    // 20ms · 16kHz mono = 320 샘플 = 640 바이트. 100 개는 아직 나가지 않는다.
    expect(frames).toHaveLength(3);
    for (const frame of frames) expect(frame.byteLength).toBe(640);
  });

  test('프레임끼리 버퍼를 공유하지 않는다 (보내는 중에 덮이면 안 된다)', () => {
    const frames: ArrayBuffer[] = [];
    const framer = new PcmFramer(2, f => frames.push(f));
    framer.push(1);
    framer.push(1);
    framer.push(-1);
    framer.push(-1);

    expect(new Int16Array(frames[0] as ArrayBuffer)[0]).toBe(32767);
    expect(new Int16Array(frames[1] as ArrayBuffer)[0]).toBe(-32768);
  });
});

describe('리샘플', () => {
  test('48k → 16k 로 1초를 흘리면 16000 샘플이 나오고 주파수가 보존된다', () => {
    const out: number[] = [];
    const resampler = new LinearResampler(48000, 16000);
    // 480 샘플(10ms)씩 쪼개 넣는다 — 블록 경계를 넘어가는 상태가 살아 있는지 함께 본다.
    for (let start = 0; start < 48000; start += 480) {
      const block = new Float32Array(480);
      for (let i = 0; i < 480; i += 1) {
        block[i] = Math.sin((2 * Math.PI * 440 * (start + i)) / 48000);
      }
      resampler.push(block, s => out.push(s));
    }

    expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(5);

    // 440Hz 사인이면 1초에 제로크로싱이 880 번이다. 리샘플이 음을 바꾸지 않았는지 본다.
    let crossings = 0;
    for (let i = 1; i < out.length; i += 1) {
      if ((out[i - 1] as number) < 0 !== ((out[i] as number) < 0)) crossings += 1;
    }
    expect(Math.abs(crossings - 880)).toBeLessThanOrEqual(4);
  });

  test('같은 레이트면 그대로 지나간다', () => {
    const resampler = new LinearResampler(16000, 16000);
    expect(resampler.identity).toBe(true);
    const out: number[] = [];
    resampler.push(new Float32Array([0.1, 0.2, 0.3]), s => out.push(s));
    expect(out).toEqual([0.1, 0.2, 0.3].map(v => Math.fround(v)));
  });
});

describe('서버가 보낸 오디오 읽기', () => {
  test('WAV 헤더의 샘플레이트를 쓴다 (입력 16k 와 다른 44.1k)', () => {
    const wav = makeWav(new Int16Array([0, 16384, -16384, 32767]), 44100, 1);
    const decoded = decodeAudioChunk(wav, 16000);

    expect(decoded.container).toBe('wav');
    expect(decoded.sampleRate).toBe(44100); // fallback(16000) 이 아니다
    expect(decoded.samples).toHaveLength(4);
  });

  test('스테레오는 모노로 합친다', () => {
    const wav = makeWav(new Int16Array([32767, -32768, 16384, 16384]), 44100, 2);
    const decoded = decodeAudioChunk(wav, 0);

    expect(decoded.channels).toBe(2);
    expect(decoded.samples).toHaveLength(2);
    expect(decoded.samples[0]).toBeCloseTo(0, 3); // (+1 + -1) / 2
    expect(decoded.samples[1]).toBeCloseTo(0.5, 3);
  });

  test('헤더가 없으면 원시 PCM16 으로 보고 tts.chunk 의 sr 을 쓴다', () => {
    const raw = new Int16Array([0, 32767, -32768]);
    const decoded = decodeAudioChunk(raw.buffer as ArrayBuffer, 24000);

    expect(decoded.container).toBe('pcm16');
    expect(decoded.sampleRate).toBe(24000);
  });

  test('헤더도 없고 sr 도 없으면 조용히 재생하지 않고 이유를 던진다', () => {
    expect(() => decodeAudioChunk(new Int16Array([1, 2]).buffer as ArrayBuffer, 0)).toThrow();
  });
});

describe('WAV 쓰기 (화자 등록 클립 업로드용)', () => {
  test('encode → decode 왕복하면 샘플이 그대로 보존된다', () => {
    const samples = new Int16Array([0, 16384, -16384, 32767, -32768, 100, -1]);
    const wav = encodeWav(samples, 16000, 1);
    const decoded = decodeAudioChunk(wav, 0);

    expect(decoded.container).toBe('wav');
    expect(decoded.sampleRate).toBe(16000);
    expect(decoded.channels).toBe(1);
    // decodeAudioChunk 도 같은 공식(pcm16ToFloat32, /0x8000)으로 되돌리므로 정확히 같아야 한다.
    expect(Array.from(decoded.samples)).toEqual(Array.from(pcm16ToFloat32(samples)));
  });

  test('스테레오로 인코딩해도 왕복된다 (기존 readWav 의 다운믹스를 그대로 탄다)', () => {
    const samples = new Int16Array([32767, -32768, 0, 0]); // 2 프레임 · 2채널
    const wav = encodeWav(samples, 44100, 2);
    const decoded = decodeAudioChunk(wav, 0);

    expect(decoded.sampleRate).toBe(44100);
    expect(decoded.channels).toBe(2);
    expect(decoded.samples).toHaveLength(2); // 다운믹스돼 프레임 수만 남는다
    expect(decoded.samples[0]).toBeCloseTo(0, 3); // (1 + -1) / 2
    expect(decoded.samples[1]).toBeCloseTo(0, 3);
  });

  test('표준 44바이트 헤더 — RIFF/WAVE/fmt/data 태그와 PCM16 필드가 맞다', () => {
    const wav = encodeWav(new Int16Array([1, 2, 3]), 16000, 1);
    expect(wav.byteLength).toBe(44 + 6);

    const view = new DataView(wav);
    const tag = (at: number) =>
      String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(tag(12)).toBe('fmt ');
    expect(tag(36)).toBe('data');
    expect(view.getUint16(20, true)).toBe(1); // PCM 정수
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(40, true)).toBe(6); // data 청크 길이(바이트)
  });

  test('concatPcm16 이 여러 프레임을 순서대로 이어붙인다 (버퍼를 공유하지 않는다)', () => {
    const a = new Int16Array([1, 2]).buffer as ArrayBuffer;
    const b = new Int16Array([3, 4, 5]).buffer as ArrayBuffer;
    const out = concatPcm16([a, b]);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);

    // 원본을 나중에 바꿔도 이어붙인 결과는 영향받지 않는다.
    new Int16Array(a)[0] = 999;
    expect(out[0]).toBe(1);
  });
});

describe('base64 인코딩 (등록 클립을 data URI 로 올릴 때 쓴다)', () => {
  // 기대값은 Node 의 Buffer.from(bytes).toString('base64') 로 미리 뽑아 둔 것이다.
  // 이 파일은 tsconfig.json(RN 앱 코드) 소관이라 Node 타입(Buffer)이 없다 — audio/pcm.ts
  // 가 RN 무의존인 것과 같은 이유로, 테스트도 Node 전역에 기대지 않는다.
  test('표준 base64 결과와 같다 (경계값 포함 — 0 · 255 · 패딩 없는 3바이트 배수)', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 65, 66, 67]);
    expect(bytesToBase64(bytes)).toBe('AAEC/f7/QUJD');
  });

  test('길이가 3 의 배수가 아니어도 패딩(=)이 맞다', () => {
    expect(bytesToBase64(new Uint8Array([65]))).toBe('QQ==');
    expect(bytesToBase64(new Uint8Array([65, 66]))).toBe('QUI=');
    expect(bytesToBase64(new Uint8Array([]))).toBe('');
  });
});

describe('레벨 미터', () => {
  test('무음은 0, 큰 소리가 더 크다', () => {
    const silent = new Int16Array(320);
    const quiet = new Int16Array(320).fill(20);
    const loud = new Int16Array(320).fill(20000);

    expect(frameLevel(silent.buffer as ArrayBuffer, 60)).toBe(0);
    expect(frameLevel(loud.buffer as ArrayBuffer, 60)).toBeGreaterThan(
      frameLevel(quiet.buffer as ArrayBuffer, 60),
    );
    expect(frameLevel(loud.buffer as ArrayBuffer, 60)).toBeLessThanOrEqual(1);
  });
});
