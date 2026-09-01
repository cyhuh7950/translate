/**
 * `audio/capture.ts` 배선 검사.
 *
 * **마이크가 실제로 열리는지는 여기서 알 수 없다** — 그것은 네이티브이고 실기기에서만
 * 확인된다. 여기서 보는 것은 그 앞뒤의 배선이다.
 *
 *   - 라이브러리를 **늦게** 부르는 경로가 실제로 이어지는가 (동적 import)
 *   - `Result` 봉투를 성공으로 제대로 읽는가 (`{status:'success'}` 를 실패로 오해하면
 *     실기기에서 "이유 없이 시작이 안 된다"가 된다)
 *   - `/v1/config` 규격이 그대로 `onAudioReady` 옵션으로 전달되는가
 *
 * 라이브러리는 jest.config.js 가 그 패키지의 목으로 바꿔 끼운다.
 */

import { MicCapture } from '../audio/capture';

/** 목에 넘어간 옵션을 들여다보기 위해 onAudioReady 를 감싼다. */
function spyOnRecorder() {
  const api = require('react-native-audio-api');
  const options: unknown[] = [];
  const original = api.AudioRecorder.prototype.onAudioReady;
  api.AudioRecorder.prototype.onAudioReady = function patched(this: unknown, ...args: unknown[]) {
    options.push(args[0]);
    return original.apply(this, args);
  };
  return { options, restore: () => (api.AudioRecorder.prototype.onAudioReady = original) };
}

test('규격을 그대로 넘기고 성공 봉투를 성공으로 읽는다', async () => {
  const spy = spyOnRecorder();
  try {
    const capture = new MicCapture(
      // /v1/config 의 16000Hz · 1ch · 20ms 에 해당하는 값들.
      { sampleRate: 16000, channels: 1, frameSamples: 320 },
      { onFrame: () => {} },
    );

    // 성공 봉투를 실패로 읽으면 여기서 던진다.
    await expect(capture.start()).resolves.toBeUndefined();
    expect(capture.running).toBe(true);

    expect(spy.options[0]).toEqual({ sampleRate: 16000, bufferLength: 320, channelCount: 1 });

    capture.stop();
    expect(capture.running).toBe(false);
  } finally {
    spy.restore();
  }
});

test('두 번 start 해도 녹음기를 둘로 만들지 않는다', async () => {
  const spy = spyOnRecorder();
  try {
    const capture = new MicCapture(
      { sampleRate: 16000, channels: 1, frameSamples: 320 },
      { onFrame: () => {} },
    );
    await capture.start();
    await capture.start();
    expect(spy.options).toHaveLength(1);
    capture.stop();
  } finally {
    spy.restore();
  }
});

test('파일 출력 모드에서는 네이티브 WAV 경로를 돌려준다', async () => {
  const api = require('react-native-audio-api');
  const originalEnable = api.AudioRecorder.prototype.enableFileOutput;
  const originalStop = api.AudioRecorder.prototype.stop;
  const enableOptions: unknown[] = [];
  api.AudioRecorder.prototype.enableFileOutput = function patched(this: unknown, options: unknown) {
    enableOptions.push(options);
    return { status: 'success' };
  };
  api.AudioRecorder.prototype.stop = async function patchedStop() {
    return { status: 'success', paths: ['/cache/stt-training.wav'], size: 1, duration: 1 };
  };
  try {
    const capture = new MicCapture(
      { sampleRate: 16000, channels: 1, frameSamples: 320, fileOutput: true },
      { onFrame: () => {} },
    );
    await capture.start();
    await expect(capture.stopWithFile()).resolves.toBe('/cache/stt-training.wav');
    expect(enableOptions[0]).toEqual(expect.objectContaining({ format: api.FileFormat.Wav }));
  } finally {
    api.AudioRecorder.prototype.enableFileOutput = originalEnable;
    api.AudioRecorder.prototype.stop = originalStop;
  }
});
