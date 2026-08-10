/**
 * HTTP 배관 — 주입받은 `fetch` 로 요청을 보내고 오류 봉투를 예외로 바꾼다.
 *
 * 이 계층의 규칙이 여기 다 들어 있다.
 *
 *   1. **환경 API 를 import 하지 않는다.** `fetch` 도 전역이 아니라 인자로 받는다.
 *      그래야 Node(스모크 테스트)와 React Native(실기기)에서 같은 코드가 돈다.
 *      DOM 타입을 쓰지 않으려고 필요한 만큼만 구조적으로 다시 선언한다.
 *   2. **주소를 고정하지 않는다.** `baseUrl` 은 호출자가 준다. 이 파일에는 어떤
 *      호스트도, 경로 기본값도 없다.
 *   3. **문구를 만들지 않는다.** 서버가 요청 로케일로 렌더한 `detail` 을 그대로 나른다.
 */

import type { ErrorEnvelope, ErrorInfo } from './types';

/* ---- 주입받는 것 ----------------------------------------------------------- */

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  /**
   * 본문의 타입은 환경마다 다르다 — 문자열, FormData, ArrayBuffer …
   * 여기서 좁히면 Node 의 `fetch` 도 RN 의 `fetch` 도 이 타입에 대입되지 않는다.
   */
  body?: any;
  /** 같은 이유. `AbortSignal` 의 선언이 환경마다 달라 구조로 맞출 수 없다. */
  signal?: any;
}

export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Node 22 의 전역 `fetch` 와 RN 의 `fetch` 가 그대로 대입되는 최소 형태다. */
export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponse>;

/**
 * multipart 업로드에 쓰는 `FormData` 의 최소 형태.
 *
 * 만드는 법이 환경마다 다르므로(Node 는 `Blob`, RN 은 `{uri, name, type}`) **만드는 일은
 * 호출자에게 맡기고** 여기서는 채우기만 한다.
 */
export interface FormDataLike {
  append(name: string, value: any, fileName?: string): void;
}

/* ---- 클라이언트 ------------------------------------------------------------ */

export interface ApiClient {
  /** 예: "https://translate.sinsan.kr". 기본값은 없다 — 호출자가 정한다. */
  baseUrl: string;
  /** 주입받은 fetch. Node 든 RN 든 전역을 그대로 넘기면 된다. */
  fetch: FetchLike;
  /** 서버의 `auth.api_key`. 비어 있으면 인증이 꺼진 서버다. */
  apiKey?: string;
  /**
   * 표시 언어. 쿼리(`?locale=`)와 `Accept-Language` 헤더에 함께 실린다.
   * 서버는 쿼리를 먼저 보고 그 다음 헤더를 본다 (`server.py` 의 `request_locale`).
   */
  locale?: string;
  /** 프록시 인증 등 요청마다 붙일 것이 더 있으면. */
  headers?: Record<string, string>;
  /** 호출 취소용. 타입은 환경에 맡긴다. */
  signal?: any;
}

/**
 * 서버가 코드와 함께 거절했다.
 *
 * `message` 는 서버가 렌더한 `detail` 그대로다 — 앱은 이것을 그대로 띄우면 되고,
 * 분기가 필요하면 `code` 를 본다. 클라이언트에 문구 카탈로그를 두지 않기 위한 계약이다.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly params: Record<string, unknown>;
  /** 봉투가 아닌 응답(프록시의 HTML 오류 페이지 등)이면 원문이 여기 남는다. */
  readonly body: string;

  constructor(status: number, message: string, info: ErrorInfo | null, body: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = info ? info.code : '';
    this.params = info ? info.params : {};
    this.body = body;
  }
}

/** 응답이 JSON 이 아니거나 기대한 모양이 아니다. 서버 오류와 구분해서 던진다. */
export class ProtocolError extends Error {
  readonly body: string;

  constructor(message: string, body: string) {
    super(message);
    this.name = 'ProtocolError';
    this.body = body;
  }
}

/* ---- URL ------------------------------------------------------------------- */

/** baseUrl 과 경로를 잇는다. 슬래시가 겹치거나 빠지는 것만 손본다. */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const tail = path.startsWith('/') ? path : `/${path}`;
  return base + tail;
}

/** 쿼리스트링. 값이 없는 것은 넣지 않는다 — 빈 값이 기본값을 덮지 않게. */
export function withQuery(url: string, params: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const key of Object.keys(params)) {
    const value = params[key];
    if (value === undefined || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  if (parts.length === 0) return url;
  return url + (url.includes('?') ? '&' : '?') + parts.join('&');
}

/**
 * HTTP(S) 주소를 WS(S) 주소로 바꾼다.
 *
 * 경로는 인자로 받는다 — 호출자가 `/v1/config` 의 `stream.path` 에서 가져온 값이다.
 * 여기에 `/v1/stream` 같은 문자열이 없는 것이 요점이다.
 */
export function streamUrl(
  baseUrl: string,
  path: string,
  params: Record<string, string | undefined> = {},
): string {
  const http = joinUrl(baseUrl, path);
  const ws = http.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  return withQuery(ws, params);
}

/* ---- 요청 ------------------------------------------------------------------ */

export function authHeaders(client: ApiClient): Record<string, string> {
  const headers: Record<string, string> = { ...(client.headers || {}) };
  if (client.apiKey) headers['Authorization'] = `Bearer ${client.apiKey}`;
  if (client.locale) headers['Accept-Language'] = client.locale;
  return headers;
}

export interface RequestOptions {
  method?: string;
  /** 있으면 JSON 으로 직렬화해 보낸다. */
  json?: unknown;
  /** 이미 만들어진 본문(FormData 등). `json` 과 함께 쓰지 않는다. */
  body?: any;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  signal?: any;
}

/**
 * 한 번의 요청. 응답이 오류 봉투면 `ApiError` 로, JSON 이 아니면 `ProtocolError` 로 던진다.
 *
 * 본문을 항상 텍스트로 먼저 읽는 이유는, 오류일 때도 같은 방식으로 파싱해야 하고
 * 봉투가 아닌 응답(프록시가 낸 HTML 등)의 원문을 예외에 실어야 하기 때문이다.
 */
export async function request<T>(
  client: ApiClient,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const url = withQuery(joinUrl(client.baseUrl, path), {
    ...(options.query || {}),
    locale: client.locale,
  });

  const headers = { ...authHeaders(client), ...(options.headers || {}) };
  let body = options.body;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  }

  const init: FetchInit = { method: options.method || 'GET', headers };
  if (body !== undefined) init.body = body;
  const signal = options.signal !== undefined ? options.signal : client.signal;
  if (signal !== undefined) init.signal = signal;

  const response = await client.fetch(url, init);
  const text = await response.text();

  let parsed: unknown = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }

  if (!response.ok) throw new ApiError(response.status, errorMessage(parsed, text), errorInfo(parsed), text);
  if (parsed === undefined) throw new ProtocolError('The response was not JSON', text);
  return parsed as T;
}

/** 봉투의 `error` 부분. 봉투가 아니면 null 이고, 그때는 `code` 로 분기할 수 없다. */
function errorInfo(parsed: unknown): ErrorInfo | null {
  const envelope = parsed as Partial<ErrorEnvelope> | undefined;
  const error = envelope && envelope.error;
  if (!error || typeof error.code !== 'string') return null;
  return { code: error.code, params: (error.params || {}) as Record<string, unknown> };
}

/** 사용자에게 보일 문장. 서버가 렌더한 `detail` 이 있으면 무조건 그것이다. */
function errorMessage(parsed: unknown, text: string): string {
  const envelope = parsed as Partial<ErrorEnvelope> | undefined;
  if (envelope && typeof envelope.detail === 'string') return envelope.detail;
  return text;
}
