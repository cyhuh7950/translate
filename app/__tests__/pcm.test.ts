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
  decodeAudioChunk,
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
