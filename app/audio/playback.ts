/**
 * TTS 재생 — `tts.chunk` 로 온 오디오를 순서대로 끊김 없이 잇는다.
 *
 * 웹(`app.js` 의 `hfEnqueue`)이 하던 것과 같은 구조다. 청크를 프라미스 체인으로 한 줄로
 * 세우고, 재생 시각을 직전 청크의 끝에 붙인다. 지금은 세그먼트당 청크가 하나로 오지만
 * 프로토콜은 여러 개를 전제하므로 이어붙일 수 있게 만들어 둔다.
 *
 * 샘플레이트
 * ----------
 * **입력(16kHz)과 다르다.** 합성 엔진이 정하고, supertonic 은 실측 44100 이다.
 * 그래서 재생 컨텍스트를 **그 오디오의 레이트로 연다.**
 *
 * 컨텍스트 레이트를 굳이 맞추는 이유는 이 라이브러리가 버퍼의 레이트와 컨텍스트의 레이트가
 * 다를 때 리샘플해주지 않기 때문이다 — `AudioBufferBaseSourceNode::getComputedPlaybackRateValue`
 * 가 playbackRate·detune 만 곱하고 버퍼의 sampleRate 는 보지 않는다(라이브러리 C++ 소스).
 * 즉 44.1k 버퍼를 48k 컨텍스트에 넣으면 그만큼 빨라진다. 반대로 컨텍스트를 44100 으로 열면
 * 기기 출력까지는 안드로이드 쪽이 맞춰준다 (`AudioPlayer::openAudioStream` 이 oboe 에
 * `setSampleRate` + `setFormatConversionAllowed(true)` + 리샘플 품질을 걸어 연다).
 */

import type { AudioBufferSourceNode, AudioContext } from 'react-native-audio-api';

import { audioApi } from './module';
import { decodeAudioChunk } from './pcm';

export interface PlayerHandlers {
  /** 실제로 소리가 나기 시작/끝났을 때. `session.playback('start'|'end')` 로 이어준다. */
  onPlayingChange?: (playing: boolean) => void;
  /** 청크 하나를 읽지 못했다. 다음 청크는 계속 간다. */
  onWarning?: (message: string) => void;
  /** 무엇을 어떻게 재생했는지 — 진단용. */
  onChunk?: (info: { sampleRate: number; channels: number; container: string; seconds: number }) => void;
}

export class TtsPlayer {
  private context: AudioContext | null = null;
  private contextRate = 0;
  /** 디코딩이 비동기라 그냥 두면 순서가 뒤집힌다. 체인으로 한 줄로 세운다. */
  private chain: Promise<void> = Promise.resolve();
  /** 다음 청크를 붙일 시각. */
  private playAt = 0;
  private sources: AudioBufferSourceNode[] = [];
  private endTimers = new Map<AudioBufferSourceNode, ReturnType<typeof setTimeout>>();
  private playing = false;
  /** `stop()` 이 지나간 뒤에 도착한 청크를 버리기 위한 세대 번호. */
  private generation = 0;
  private disposed = false;

  constructor(private readonly handlers: PlayerHandlers = {}) {}

  /**
   * 청크 하나를 큐에 넣는다. `sr` 은 `tts.chunk` 의 값 — WAV 헤더가 있으면 그쪽이 이긴다.
   */
  enqueue(audio: ArrayBuffer, sr: number | null): void {
    if (this.disposed) return;
    const generation = this.generation;
    this.chain = this.chain
      .then(() => this.play(audio, sr, generation))
      .catch(error => this.warn(error));
  }

  /** 재생을 즉시 멈춘다 (`tts.stop` / `cancelled` / 연결 종료). */
  stop(): void {
    this.generation += 1;
    this.chain = Promise.resolve();
    this.playAt = 0;
    const sources = this.sources;
    this.sources = [];
    for (const source of sources) {
      const timer = this.endTimers.get(source);
      if (timer !== undefined) clearTimeout(timer);
      this.endTimers.delete(source);
      try {
        source.stop();
      } catch {
        // 이미 끝난 소스. 무시한다.
      }
    }
    this.setPlaying(false);
  }

  /** 화면을 떠날 때. 컨텍스트까지 닫는다. */
  dispose(): void {
    this.stop();
    this.disposed = true;
    const context = this.context;
    this.context = null;
    this.contextRate = 0;
    if (context) context.close().catch(() => undefined);
  }

  private async play(audio: ArrayBuffer, sr: number | null, generation: number): Promise<void> {
    if (this.disposed || generation !== this.generation) return;

    const decoded = decodeAudioChunk(audio, sr || 0);
    if (decoded.samples.length === 0) return;

    const context = await this.contextAt(decoded.sampleRate);
    if (this.disposed || generation !== this.generation) return;

    const buffer = context.createBuffer(1, decoded.samples.length, decoded.sampleRate);
    buffer.copyToChannel(decoded.samples, 0);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);

    const at = Math.max(context.currentTime, this.playAt);
    const finish = () => this.finishSource(source);
    source.onEnded = finish;
    source.start(at);
    this.playAt = at + buffer.duration;
    this.sources.push(source);
    // 일부 Android 오디오 경로에서는 네이티브 onEnded 전달이 누락될 수 있다.
    // 실제 재생 길이를 넘긴 뒤에도 남아 있으면 상태만 정리한다.
    const endTimer = setTimeout(finish, Math.max(0, (this.playAt - context.currentTime) * 1000 + 100));
    this.endTimers.set(source, endTimer);
    this.setPlaying(true);

    if (this.handlers.onChunk) {
      this.handlers.onChunk({
        sampleRate: decoded.sampleRate,
        channels: decoded.channels,
        container: decoded.container,
        seconds: buffer.duration,
      });
    }
  }

  private finishSource(source: AudioBufferSourceNode): void {
    const timer = this.endTimers.get(source);
    if (timer !== undefined) clearTimeout(timer);
    this.endTimers.delete(source);
    this.sources = this.sources.filter(s => s !== source);
    if (this.sources.length === 0) {
      this.playAt = 0;
      this.setPlaying(false);
    }
  }

  /**
   * 그 레이트로 열린 컨텍스트를 준다. 레이트가 바뀌면 새로 연다 —
   * 컨텍스트의 샘플레이트는 만든 뒤에 바꿀 수 없다.
   */
  private async contextAt(rate: number): Promise<AudioContext> {
    if (this.context && this.contextRate === rate) {
      if (this.context.state === 'suspended') await this.context.resume();
      return this.context;
    }
    const old = this.context;
    if (old) old.close().catch(() => undefined);

    // 값으로 import 하지 않고 여기서 부른다 — 이유는 audio/module.ts 에 있다.
    const context = new (audioApi().AudioContext)({ sampleRate: rate });
    this.context = context;
    this.contextRate = rate;
    this.playAt = 0;
    if (context.state === 'suspended') await context.resume();
    return context;
  }

  private setPlaying(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
    if (this.handlers.onPlayingChange) this.handlers.onPlayingChange(playing);
  }

  private warn(error: unknown): void {
    if (!this.handlers.onWarning) return;
    this.handlers.onWarning(error instanceof Error ? error.message : String(error));
  }
}
