/**
 * `lang_learn` 모듈의 클라이언트 — 학습 설정 조회 + WS 학습 세션.
 *
 * `stream.ts`(번역 스트림)와 나란히 두지 않고 새 파일로 뗀 이유: 두 프로토콜이
 * `ready`/`error` 라는 이벤트 **이름**만 같고 모양·오가는 순서가 다르다(여기는
 * `session.py` 주석대로 "문제 하나 → 답 하나"의 단순한 요청-응답 루프이지 VAD 로
 * 세그먼트를 흘리는 스트림이 아니다). 억지로 `StreamSession` 을 재사용하면 그 클래스의
 * `tts.chunk` 바이너리 짝짓기 규칙이 여기의 `problem`/`audio_hint` 짝짓기와 어긋난다.
 */

import { request } from './http';
import type { ApiClient } from './http';
import type { WebSocketFactory, WebSocketLike } from './stream';
import type {
  LangLearnAnswerMessage,
  LangLearnEvent,
  LangLearnEventOf,
  LangLearnEventType,
  LangLearnSettings,
  LangLearnStartMessage,
} from './types';

/** `GET /v1/users/{id}/lang_learn/settings` — 없으면 서버가 기본값을 채워 돌려준다. */
export function getLangLearnSettings(client: ApiClient, userId: string): Promise<LangLearnSettings> {
  return request<LangLearnSettings>(client, `/v1/users/${encodeURIComponent(userId)}/lang_learn/settings`);
}

export interface LangLearnCloseInfo {
  code?: number;
  reason?: string;
}

export type LangLearnHandlers = {
  [K in LangLearnEventType]?: (event: LangLearnEventOf<K>) => void;
};

export interface LangLearnSessionOptions {
  /** `streamUrl(client.baseUrl, config.lang_learn.stream.path)` 로 만든 완성된 WS 주소. */
  url: string;
  webSocket: WebSocketFactory;
  protocols?: string[];
  /** 소켓이 열리자마자 자동으로 보낼 시작 메시지. */
  start: LangLearnStartMessage;
  handlers?: LangLearnHandlers;
  /** `problem` 이벤트 뒤에 온 오디오(`audio_hint` 가 true 일 때만). */
  onAudio?: (problem: LangLearnEventOf<'problem'>, audio: ArrayBuffer) => void;
  onOpen?: () => void;
  onClose?: (info: LangLearnCloseInfo) => void;
  onSocketError?: (error: unknown) => void;
  onWarning?: (message: string, detail?: unknown) => void;
}

type SessionState = 'idle' | 'connecting' | 'open' | 'closed';

export class LangLearnSession {
  private readonly options: LangLearnSessionOptions;
  private socket: WebSocketLike | null = null;
  private state: SessionState = 'idle';
  /** 직전에 온 `problem`. `audio_hint` 가 true 면 다음 바이너리가 그 문제의 오디오다. */
  private pendingProblem: LangLearnEventOf<'problem'> | null = null;

  constructor(options: LangLearnSessionOptions) {
    this.options = options;
  }

  get isOpen(): boolean {
    return this.state === 'open';
  }

  open(): void {
    if (this.state !== 'idle') return;
    this.state = 'connecting';

    const socket = this.options.webSocket(this.options.url, this.options.protocols);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.state = 'open';
      this.send(this.options.start);
      if (this.options.onOpen) this.options.onOpen();
    };

    socket.onmessage = (event: any) => {
      const data = event && event.data;
      if (typeof data === 'string') {
        this.onText(data);
        return;
      }
      this.onBinary(data);
    };

    socket.onerror = (error: any) => {
      if (this.options.onSocketError) this.options.onSocketError(error);
    };

    socket.onclose = (event: any) => {
      this.state = 'closed';
      if (this.options.onClose) {
        this.options.onClose({
          code: event && typeof event.code === 'number' ? event.code : undefined,
          reason: event && typeof event.reason === 'string' ? event.reason : undefined,
        });
      }
    };
  }

  /** 텍스트 답변. */
  answerText(idx: number, text: string): void {
    this.send({ type: 'answer', idx, modality: 'text', text });
  }

  /** 음성 답변 — JSON 메시지 하나 뒤에 오디오 바이너리 하나(`session.py` 의 규약대로). */
  answerAudio(idx: number, audio: ArrayBuffer, contentType: string, durationS: number): void {
    if (!this.socket || this.state !== 'open') return;
    this.send({ type: 'answer', idx, modality: 'audio', content_type: contentType, duration_s: durationS });
    this.socket.send(audio);
  }

  close(code?: number, reason?: string): void {
    if (this.socket && this.state !== 'closed') this.socket.close(code, reason);
    this.state = 'closed';
  }

  private send(message: LangLearnAnswerMessage | LangLearnStartMessage): boolean {
    if (!this.socket || this.state !== 'open') return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private onText(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.warn('서버가 JSON 이 아닌 텍스트 프레임을 보냈다', raw);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
      this.warn('이벤트에 type 이 없다', parsed);
      return;
    }

    const event = parsed as LangLearnEvent;
    if (event.type === 'problem') this.pendingProblem = event;
    else this.pendingProblem = null;

    const handlers = this.options.handlers;
    if (!handlers) return;
    const handler = (handlers as Record<string, ((e: LangLearnEvent) => void) | undefined>)[event.type];
    if (handler) handler(event);
  }

  private onBinary(data: unknown): void {
    const problem = this.pendingProblem;
    this.pendingProblem = null;
    if (!problem) {
      this.warn('짝이 없는 바이너리 프레임이 왔다');
      return;
    }
    const audio = toArrayBuffer(data);
    if (!audio) {
      this.warn('바이너리 프레임을 ArrayBuffer 로 읽지 못했다', data);
      return;
    }
    if (this.options.onAudio) this.options.onAudio(problem, audio);
  }

  private warn(message: string, detail?: unknown): void {
    if (this.options.onWarning) this.options.onWarning(message, detail);
  }
}

export function openLangLearnStream(options: LangLearnSessionOptions): LangLearnSession {
  const session = new LangLearnSession(options);
  session.open();
  return session;
}

function toArrayBuffer(data: unknown): ArrayBuffer | null {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }
  return null;
}
