/**
 * 마이크 캡처 — `/v1/config` 가 정한 규격의 PCM16 프레임을 뱉는다.
 *
 * 웹에서 `getUserMedia` + `AudioContext(rate)` + AudioWorklet 이 하던 일을
 * `react-native-audio-api` 의 `AudioRecorder` 하나로 한다.
 *
 * 왜 AudioContext / 워크릿 노드를 쓰지 않았나
 * -------------------------------------------
 * 이 라이브러리의 워크릿 노드(`createWorkletNode` 등)는 `react-native-worklets` 를 함께
 * 깔아야 동작한다 (package.json 의 peerDependencies, `peerDependenciesMeta` 에서
 * optional 로 표시돼 있고 없으면 워크릿 기능만 못 쓴다). `AudioRecorder.onAudioReady` 는
 * 그것 없이 JS 스레드로 버퍼를 올려주고, 우리가 필요한 것은 20ms 프레임을 소켓으로
 * 흘려보내는 것뿐이라 이쪽으로 충분하다. 의존성을 하나만 늘린다는 원칙과도 맞는다.
 *
 * 규격을 믿지 않는다
 * ------------------
 * `onAudioReady(options, cb)` 의 `options`(sampleRate·bufferLength·channelCount)는
 * 라이브러리 문서가 "선호값"이라고 적어둔 것이다 — "실제 값은 기기 사정에 따라 다를 수
 * 있다"가 그 doc comment 에 그대로 있다. 그래서 올라온 버퍼의 `sampleRate` 를 확인하고
 * 어긋나면 앱이 리샘플한다. 서버는 다른 레이트를 받으면 `stream.sample_rate` 로 끊는다.
 *
 * 라이브러리 실물은 `./module` 의 `audioApi()` 로 **늦게** 부른다. 이유는 그 파일에 있다.
 */

import type { AudioRecorder } from 'react-native-audio-api';

import { audioApi } from './module';
import { LinearResampler, PcmFramer } from './pcm';

/** 전부 `/v1/config` 에서 온 값이다. 이 파일에는 숫자가 없다. */
export interface CaptureSpec {
  /** audio.stt_sample_rate */
  sampleRate: number;
  /** audio.stt_channels */
  channels: number;
  /** frameSamples(config) — stt_sample_rate × client_frame_ms / 1000 */
  frameSamples: number;
  /** 파일 업로드가 필요한 단발 녹음이면 네이티브 파일 출력도 켠다. */
  fileOutput?: boolean;
}

export interface CaptureHandlers {
  /** PCM16 프레임 하나. 그대로 `session.sendAudio()` 로 보내면 된다. */
  onFrame: (frame: ArrayBuffer) => void;
  /** 기기가 규격을 못 맞춰 앱이 보정하고 있다는 통지. 화면에 띄워 진단에 쓴다. */
  onNotice?: (message: string) => void;
  /** 녹음 중 라이브러리가 알린 오류. 문장은 라이브러리가 준 것을 그대로 나른다. */
  onError?: (message: string) => void;
}

/**
 * 라이브러리 호출의 결과 봉투에서 오류 문장을 꺼낸다.
 *
 * 반환 타입이 `Result<T> = ({status:'success'} & T) | {status:'error', message}` 라
 * `T` 가 `void`/`{}` 일 때 좁히기가 어색해진다. 우리가 알아야 할 것은 "실패했으면 그 문장"
 * 하나뿐이라 구조로 읽는다.
 */
function failureOf(result: unknown): string | null {
  const r = result as { status?: string; message?: string } | null | undefined;
  if (!r || r.status !== 'error') return null;
  return r.message || '';
}

export class MicCapture {
  private recorder: AudioRecorder | null = null;
  private readonly framer: PcmFramer;
  private resampler: LinearResampler | null = null;
  /** 리샘플 통지를 한 번만 띄우기 위한 표시. */
  private noticedRate = 0;

  constructor(
    private readonly spec: CaptureSpec,
    private readonly handlers: CaptureHandlers,
  ) {
    this.framer = new PcmFramer(spec.frameSamples, handlers.onFrame);
  }

  /** 마이크를 연다. 실패하면 던진다 — 문장은 라이브러리가 준 것이다. */
  async start(): Promise<void> {
    if (this.recorder) return;

    // 여기가 네이티브 모듈을 실제로 설치하는 지점이다 (audio/module.ts 를 볼 것).
    const recorder = new (audioApi().AudioRecorder)();
    this.recorder = recorder;
    this.framer.reset();

    if (this.spec.fileOutput) {
      const api = audioApi();
      const fileOutput = recorder.enableFileOutput({
        directory: api.FileDirectory.Cache,
        subDirectory: 'TranslateApp',
        format: api.FileFormat.Wav,
        channelCount: this.spec.channels,
        fileNamePrefix: 'stt-training',
        androidFlushIntervalMs: 500,
      });
      const fileError = failureOf(fileOutput);
      if (fileError !== null) {
        this.stop();
        throw new Error(fileError || '녹음 파일 출력을 설정하지 못했다.');
      }
    }

    recorder.onError(event => {
      if (this.handlers.onError) this.handlers.onError(event.message);
    });

    const registered = recorder.onAudioReady(
      {
        sampleRate: this.spec.sampleRate,
        bufferLength: this.spec.frameSamples,
        channelCount: this.spec.channels,
      },
      event => this.onBuffer(event.buffer),
    );
    const registerError = failureOf(registered);
    if (registerError !== null) {
      this.stop();
      throw new Error(registerError || '마이크 콜백을 등록하지 못했다.');
    }

    const started = await recorder.start();
    const startError = failureOf(started);
    if (startError !== null) {
      this.stop();
      throw new Error(startError || '녹음을 시작하지 못했다.');
    }
  }

  stop(): void {
    const recorder = this.recorder;
    this.recorder = null;
    this.resampler = null;
    this.noticedRate = 0;
    this.framer.reset();
    if (!recorder) return;
    try {
      recorder.clearOnAudioReady();
      recorder.clearOnError();
    } catch {
      // 이미 정리된 경우. 여기서 죽을 이유가 없다.
    }
    // stop() 은 프라미스를 준다. 결과를 기다릴 이유가 없어 흘려보내되 거부는 삼킨다.
    Promise.resolve(recorder.stop()).catch(() => undefined);
  }

  /** 녹음을 멈추고 네이티브가 만든 파일 URI를 돌려준다. */
  async stopWithFile(): Promise<string | null> {
    const recorder = this.recorder;
    this.recorder = null;
    this.resampler = null;
    this.noticedRate = 0;
    this.framer.reset();
    if (!recorder) return null;
    try {
      recorder.clearOnAudioReady();
      recorder.clearOnError();
    } catch {
      // 이미 정리된 경우. 그래도 stop 결과는 확인한다.
    }
    const result = await recorder.stop();
    const error = failureOf(result);
    if (error !== null) throw new Error(error || '녹음 파일을 저장하지 못했다.');
    const paths = (result as { paths?: string[] }).paths;
    return paths && paths.length > 0 ? paths[0] : null;
  }

  get running(): boolean {
    return this.recorder !== null;
  }

  /** 라이브러리가 올려준 버퍼 하나. 채널 0 만 쓴다 — mono 로 요청했다. */
  private onBuffer(buffer: {
    sampleRate: number;
    numberOfChannels: number;
    getChannelData(channel: number): Float32Array;
  }): void {
    const block = buffer.getChannelData(0);
    if (buffer.sampleRate === this.spec.sampleRate) {
      for (let i = 0; i < block.length; i += 1) this.framer.push(block[i] as number);
      return;
    }

    // 기기가 요청한 레이트를 못 맞췄다. 서버는 맞춰주지 않으므로 여기서 맞춘다.
    if (!this.resampler || this.noticedRate !== buffer.sampleRate) {
      this.resampler = new LinearResampler(buffer.sampleRate, this.spec.sampleRate);
      this.framer.reset();
      this.noticedRate = buffer.sampleRate;
      if (this.handlers.onNotice) {
        this.handlers.onNotice(
          `마이크가 ${buffer.sampleRate}Hz 로 열렸다. 서버 규격 ${this.spec.sampleRate}Hz 로 앱이 리샘플한다.`,
        );
      }
    }
    this.resampler.push(block, sample => this.framer.push(sample));
  }
}
