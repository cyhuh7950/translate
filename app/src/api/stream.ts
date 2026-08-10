/**
 * WebSocket 스트리밍 프로토콜 클라이언트.
 *
 * 서버(`orchestrator/app/modules/translate/streaming.py`)가 정한 규약 그대로다.
 *
 *   보낸다   config(최초 1회) → PCM16 바이너리 프레임 … → control(flush/cancel/playback)
 *   받는다   ready / vad / stt.* / llm.* / tts.chunk(+바이너리) / tts.done / tts.stop
 *            / cancelled / speaker.rejected / metrics / error
 *
 * 이 파일이 실제로 해주는 일은 셋이다.
 *
 *   1. **바이너리 짝짓기.** `tts.chunk` 바로 뒤에 오는 바이너리 프레임이 그 청크의 오디오다.
 *      서버가 송신 락으로 순서를 보장하므로, 클라이언트는 직전 chunk 를 기억했다가 붙이면 된다.
 *   2. **소켓 주입.** `WebSocket` 을 전역에서 찾지 않고 팩토리로 받는다. Node 22 의 전역
 *      WebSocket 도, React Native 의 WebSocket 도 그대로 넘어간다.
 *   3. **타입 좁히기.** `type` 별로 이벤트 타입이 정해진 핸들러 맵을 준다.
 *
 * 하지 않는 일도 분명히 해둔다. 마이크도, 재생도, 타이머도 여기 없다. 타임아웃이 필요하면
 * 호출자가 자기 환경의 타이머로 `whenReady()` 를 감싸면 된다 — 그래야 이 파일이 환경을
 * 알지 않아도 된다.
 */

import type {
  ReadyEvent,
  StreamClientMessage,
  StreamConfigMessage,
  StreamErrorEvent,
  StreamEvent,
  StreamEventOf,
  StreamEventType,
  TtsChunkEvent,
} from './types';

/* ---- 주입받는 것 ----------------------------------------------------------- */

/**
 * WebSocket 의 최소 형태.
 *
 * 핸들러 자리를 `any` 로 둔 것은 이벤트 객체의 선언이 환경마다 다르기 때문이다
 * (Node 의 `MessageEvent`, RN 의 `WebSocketMessageEvent` …). 좁게 선언하면 어느 한쪽이
 * 대입되지 않는다. 실제로 우리가 읽는 것은 `event.data` 하나뿐이다.
 */
export interface WebSocketLike {
  binaryType: string;
  send(data: any): void;
  close(code?: number, reason?: string): void;
  onopen: any;
  onmessage: any;
  onerror: any;
  onclose: any;
}

export type WebSocketFactory = (url: string, protocols?: string[]) => WebSocketLike;

/* ---- 오류 ------------------------------------------------------------------ */

/**
 * 서버가 `error` 이벤트로 알린 것.
 *
 * `message` 는 세션 로케일로 렌더된 문장이라 그대로 보여주면 되고, 분기는 `code` 로 한다.
 * HTTP 쪽 `ApiError` 와 같은 계약이다.
 */
export class StreamError extends Error {
  readonly code: string;
  readonly params: Record<string, unknown>;

  constructor(event: StreamErrorEvent) {
    super(event.message);
    this.name = 'StreamError';
    this.code = event.code;
    this.params = event.params || {};
  }
}

/** 소켓이 닫혔다. 서버가 이유를 `error` 로 먼저 보냈으면 그쪽이 진짜 이유다. */
export class StreamClosedError extends Error {
  readonly code: number | undefined;
  readonly reason: string | undefined;

  constructor(code?: number, reason?: string) {
    super(`The stream closed (code=${code ?? '-'}, reason=${reason || '-'})`);
    this.name = 'StreamClosedError';
    this.code = code;
    this.reason = reason;
  }
}

/* ---- 세션 ------------------------------------------------------------------ */

export interface StreamCloseInfo {
  code?: number;
  reason?: string;
}

/** `type` 별로 인자 타입이 좁혀지는 핸들러 맵. */
export type StreamHandlers = {
  [K in StreamEventType]?: (event: StreamEventOf<K>) => void;
};

export interface StreamSessionOptions {
  /**
   * 완성된 WS 주소. `http.ts` 의 `streamUrl(baseUrl, config.stream.path)` 로 만든다 —
   * 경로는 `/v1/config` 가 알려주므로 이 계층에 박히지 않는다.
   */
  url: string;
  /** `(url) => new WebSocket(url)`. 전역을 찾지 않는 이유는 파일 첫머리 주석에 있다. */
  webSocket: WebSocketFactory;
  /** 연결되면 자동으로 보낼 config 메시지. */
  config: StreamConfigMessage;
  protocols?: string[];
  /**
   * `type` 별 핸들러. 인증 헤더처럼 핸드셰이크에 붙일 것이 있으면 `webSocket` 팩토리
   * 안에서 처리한다 — 그것은 환경마다 되는 방식이 다르기 때문이다.
   */
  handlers?: StreamHandlers;
  /** 모든 JSON 이벤트가 여기로도 온다. 모르는 이벤트를 로그로 흘려보낼 때 쓴다. */
  onEvent?: (event: StreamEvent) => void;
  /** `tts.chunk` 와 그 뒤에 온 오디오. 짝은 이 클래스가 맞춰준다. */
  onAudio?: (chunk: TtsChunkEvent, audio: ArrayBuffer) => void;
  onOpen?: () => void;
  onClose?: (info: StreamCloseInfo) => void;
  /** 소켓 자체의 오류. 이유는 대개 비어 있다 — 진짜 이유는 서버의 `error` 이벤트다. */
  onSocketError?: (error: unknown) => void;
  /** 규약이 어긋났을 때(JSON 파싱 실패, 짝 없는 바이너리 …). 끊지는 않는다. */
  onWarning?: (message: string, detail?: unknown) => void;
}

type SessionState = 'idle' | 'connecting' | 'open' | 'closed';

export class StreamSession {
  private readonly options: StreamSessionOptions;
  private socket: WebSocketLike | null = null;
  private state: SessionState = 'idle';

  /** 직전에 온 `tts.chunk`. 다음 바이너리 프레임이 이것의 오디오다. */
  private pendingChunk: TtsChunkEvent | null = null;

  private readyEvent: ReadyEvent | null = null;
  private readyResolve: ((event: ReadyEvent) => void) | null = null;
  private readyReject: ((error: unknown) => void) | null = null;
  private readonly readyPromise: Promise<ReadyEvent>;

  private closeInfo: StreamCloseInfo | null = null;
  private closeResolve: ((info: StreamCloseInfo) => void) | null = null;
  private readonly closePromise: Promise<StreamCloseInfo>;

  constructor(options: StreamSessionOptions) {
    this.options = options;
    this.readyPromise = new Promise<ReadyEvent>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // ready 를 기다리지 않는 호출자도 있으므로 미리 삼켜둔다. 그러지 않으면
    // 오류로 끝난 세션이 "처리되지 않은 거부"로 남는다.
    this.readyPromise.catch(() => undefined);
    this.closePromise = new Promise<StreamCloseInfo>((resolve) => {
      this.closeResolve = resolve;
    });
  }

  /** 지금까지 서버가 알려준 세션 정보. `ready` 전에는 null 이다. */
  get ready(): ReadyEvent | null {
    return this.readyEvent;
  }

  get isOpen(): boolean {
    return this.state === 'open';
  }

  /** `ready` 를 기다린다. 그전에 오류나 종료가 오면 그것으로 거부된다. */
  whenReady(): Promise<ReadyEvent> {
    return this.readyPromise;
  }

  /** 소켓이 닫힐 때까지. 오류가 아니라 정보로 완료된다. */
  whenClosed(): Promise<StreamCloseInfo> {
    return this.closePromise;
  }

  open(): void {
    if (this.state !== 'idle') return;
    this.state = 'connecting';

    const socket = this.options.webSocket(this.options.url, this.options.protocols);
    // 바이너리를 ArrayBuffer 로 받는다. RN 의 기본값은 blob 이라 이 줄이 꼭 필요하다.
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.state = 'open';
      // 서버는 첫 메시지가 config 가 아니면 끊는다. 그래서 여는 즉시 보낸다.
      this.sendMessage(this.options.config);
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
      const info: StreamCloseInfo = {
        code: event && typeof event.code === 'number' ? event.code : undefined,
        reason: event && typeof event.reason === 'string' ? event.reason : undefined,
      };
      this.finish(info);
    };
  }

  /**
   * PCM16 프레임 하나. `/v1/config` 가 알려준 규격(16kHz mono, 20ms)으로 만들어 보낸다.
   * 서버는 리샘플링을 대신 해주지 않는다.
   *
   * `ready` 전에는 보내지 않는다. 서버가 config 를 거절하면 소켓이 그대로 닫히므로,
   * 규격 확인(`ready.audio`)이 끝나기 전에 마이크를 흘려보낼 이유가 없다.
   */
  sendAudio(frame: ArrayBuffer | ArrayBufferView): boolean {
    if (!this.socket || this.state !== 'open' || this.readyEvent === null) return false;
    this.socket.send(frame);
    return true;
  }

  /** 지금까지 들어온 것을 한 세그먼트로 확정한다 (PTT 버튼을 뗐을 때). */
  flush(): void {
    this.sendMessage({ type: 'control', action: 'flush' });
  }

  /** 진행 중인 세그먼트를 버린다. 서버는 `cancelled` 로 답한다. */
  cancel(): void {
    this.sendMessage({ type: 'control', action: 'cancel' });
  }

  /**
   * 실제 재생 상태를 알린다. 서버는 스피커를 볼 수 없어 보낸 오디오 길이로 재생 구간을
   * 추정하는데, 이 값이 그 추정을 덮는다. half_duplex 에서 마이크가 열리는 시점이 여기 달렸다.
   */
  playback(state: 'start' | 'end'): void {
    this.sendMessage({ type: 'control', action: 'playback', state });
  }

  close(code?: number, reason?: string): void {
    if (this.socket && this.state !== 'closed') {
      this.socket.close(code, reason);
    }
    this.state = 'closed';
  }

  /* ---- 내부 --------------------------------------------------------------- */

  private sendMessage(message: StreamClientMessage): boolean {
    if (!this.socket || this.state !== 'open') return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private onText(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.warn('The server sent a text frame that is not JSON', raw);
      return;
    }
    if (!parsed || typeof parsed !== 'object') {
      this.warn('The server sent a JSON value that is not an object', parsed);
      return;
    }

    const event = parsed as StreamEvent;
    if (typeof event.type !== 'string') {
      this.warn('The event has no type', parsed);
      return;
    }

    // 짝짓기가 먼저다. 다음 바이너리 프레임이 이 청크의 오디오라는 사실을 기억해둔다.
    if (event.type === 'tts.chunk') {
      this.pendingChunk = event as TtsChunkEvent;
    }

    if (event.type === 'ready') {
      this.readyEvent = event as ReadyEvent;
      if (this.readyResolve) this.readyResolve(this.readyEvent);
      this.readyResolve = null;
      this.readyReject = null;
    }

    // ready 전에 온 오류는 세션이 아예 열리지 않았다는 뜻이다. 기다리는 쪽을 깨운다.
    if (event.type === 'error' && this.readyReject) {
      this.readyReject(new StreamError(event as StreamErrorEvent));
      this.readyResolve = null;
      this.readyReject = null;
    }

    if (this.options.onEvent) this.options.onEvent(event);

    const handlers = this.options.handlers;
    if (!handlers) return;
    // 모르는 이벤트는 조용히 흘려보낸다. 서버가 단계를 늘려도 앱이 깨지지 않게.
    const handler = (handlers as Record<string, ((event: StreamEvent) => void) | undefined>)[
      event.type
    ];
    if (handler) handler(event);
  }

  private onBinary(data: unknown): void {
    const chunk = this.pendingChunk;
    this.pendingChunk = null;
    if (!chunk) {
      // 짝이 없는 바이너리. 서버가 락으로 순서를 보장하므로 정상적으로는 오지 않는다.
      this.warn('A binary frame arrived without a preceding tts.chunk');
      return;
    }
    const audio = toArrayBuffer(data);
    if (!audio) {
      this.warn('The binary frame could not be read as an ArrayBuffer', data);
      return;
    }
    if (this.options.onAudio) this.options.onAudio(chunk, audio);
  }

  private finish(info: StreamCloseInfo): void {
    if (this.state === 'closed' && this.closeInfo) return;
    this.state = 'closed';
    this.closeInfo = info;
    if (this.readyReject) {
      this.readyReject(new StreamClosedError(info.code, info.reason));
      this.readyResolve = null;
      this.readyReject = null;
    }
    if (this.options.onClose) this.options.onClose(info);
    if (this.closeResolve) this.closeResolve(info);
    this.closeResolve = null;
  }

  private warn(message: string, detail?: unknown): void {
    if (this.options.onWarning) this.options.onWarning(message, detail);
  }
}

/** 만들자마자 연다. 대부분의 호출자가 원하는 형태다. */
export function openStream(options: StreamSessionOptions): StreamSession {
  const session = new StreamSession(options);
  session.open();
  return session;
}

/**
 * 소켓이 준 바이너리를 ArrayBuffer 로 맞춘다.
 *
 * `binaryType = 'arraybuffer'` 를 걸어도 환경에 따라 뷰(Buffer·Uint8Array)가 오는 경우가
 * 있어서 둘 다 받는다. 뷰일 때 잘라내는 이유는 뷰가 더 큰 버퍼의 일부일 수 있기 때문이다.
 */
function toArrayBuffer(data: unknown): ArrayBuffer | null {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }
  return null;
}
