/**
 * 실제 서버에 대고 도는 스모크 테스트.
 *
 * 이 파일은 **Node 전용이다** — 파일을 읽고 타이머를 쓰고 전역 `fetch`/`WebSocket` 을
 * 꺼내 쓴다. `src/api` 는 그중 아무것도 하지 않는다. 그 둘을 잇는 것이 여기 있는
 * 세 줄(`fetch`, `WebSocket`, `FormData` 를 주입하는 곳)뿐이라는 것이 요점이다.
 * 실기기에서는 같은 자리에 RN 의 전역이 들어간다.
 *
 * 돌리는 법
 *
 *   TRANSLATE_BASE_URL=http://localhost:8401 \
 *   TRANSLATE_AUDIO=/path/to/16k-mono.wav \
 *   npm run smoke
 *
 * 환경변수 (기본값 없음 — 주소를 소스에 박지 않는다)
 *
 *   TRANSLATE_BASE_URL   필수. 오케스트레이터 주소
 *   TRANSLATE_API_KEY    서버의 auth.api_key 가 설정돼 있을 때만
 *   TRANSLATE_AUDIO      16kHz mono PCM16 WAV. 없으면 WS 오디오 왕복을 건너뛴다
 *   TRANSLATE_LOCALE_A   오류 문구 비교에 쓸 첫 번째 로케일 (기본 ko)
 *   TRANSLATE_LOCALE_B   두 번째 로케일 (기본 en)
 */

import { readFileSync } from 'node:fs';

import {
  ApiError,
  StreamError,
  fetchConfig,
  frameBytes,
  openStream,
  streamUrl,
  translateText,
} from '../src/api';
import type {
  ApiClient,
  FetchLike,
  ServerConfig,
  StreamEvent,
  WebSocketFactory,
} from '../src/api';

/* ---- 환경 주입 -------------------------------------------------------------
 *
 * src/api 가 환경을 모르게 하려고 여기서 넘긴다. RN 에서도 이 세 줄만 바뀐다.
 */

const doFetch: FetchLike = globalThis.fetch;
const makeSocket: WebSocketFactory = (url, protocols) => new WebSocket(url, protocols);

const BASE_URL = required('TRANSLATE_BASE_URL');
const API_KEY = process.env.TRANSLATE_API_KEY || undefined;
const AUDIO_PATH = process.env.TRANSLATE_AUDIO || '';
const LOCALE_A = process.env.TRANSLATE_LOCALE_A || 'ko';
const LOCALE_B = process.env.TRANSLATE_LOCALE_B || 'en';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required. See the header of test/smoke.ts.`);
    process.exit(2);
  }
  return value;
}

function client(locale: string): ApiClient {
  const c: ApiClient = { baseUrl: BASE_URL, fetch: doFetch, locale };
  if (API_KEY) c.apiKey = API_KEY;
  return c;
}

/* ---- 결과 집계 -------------------------------------------------------------- */

let passed = 0;
let failed = 0;

function ok(label: string, detail = ''): void {
  passed += 1;
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}

function bad(label: string, detail = ''): void {
  failed += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) ok(label, detail);
  else bad(label, detail);
}

function section(title: string): void {
  console.log(`\n== ${title}`);
}

/** 환경의 타이머는 테스트가 갖는다. src/api 에는 타이머가 없다. */
function timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/* ---- 1. GET /v1/config ------------------------------------------------------ */

async function testConfig(): Promise<ServerConfig> {
  section(`GET /v1/config (locale=${LOCALE_A}, ${LOCALE_B})`);

  const a = await fetchConfig(client(LOCALE_A));
  const b = await fetchConfig(client(LOCALE_B));

  check('locale echoed back', a.locale === LOCALE_A && b.locale === LOCALE_B, `${a.locale} / ${b.locale}`);
  check('profiles parsed', a.profiles.length > 0, `${a.profiles.length} profiles`);
  check('languages parsed', a.languages.length > 0, `${a.languages.length} languages`);
  check('engines parsed', a.engines.length > 0, `${a.engines.filter((e) => e.ready).length} ready`);
  check('stream section present', typeof a.stream.path === 'string', `path=${a.stream.path}`);
  check(
    'audio spec present',
    a.audio.stt_sample_rate > 0 && a.stream.client_frame_ms > 0,
    `${a.audio.stt_sample_rate}Hz x${a.audio.stt_channels}, ${a.stream.client_frame_ms}ms = ${frameBytes(a)} bytes/frame`,
  );

  const labelA = a.languages[0]?.label;
  const labelB = b.languages[0]?.label;
  check('labels are localized', labelA !== labelB, `${labelA} vs ${labelB}`);

  return a;
}

/* ---- 2. POST /v1/translate/text --------------------------------------------- */

async function testTextRoundTrip(config: ServerConfig): Promise<void> {
  section('POST /v1/translate/text');

  const result = await translateText(client(LOCALE_A), {
    text: '안녕하세요, 오늘 회의는 세 시에 시작합니다.',
    source_lang: config.session.default_source_lang,
    target_lang: config.session.default_target_lang,
  });

  check('translation returned', result.text.length > 0, JSON.stringify(result.text));
  check(
    'direction echoed',
    result.source_lang === config.session.default_source_lang &&
      result.target_lang === config.session.default_target_lang,
    `${result.source_lang} -> ${result.target_lang}`,
  );
  check('provider reported', result.provider.length > 0, `${result.provider} (${result.elapsed_s}s)`);
}

/* ---- 3. 오류 봉투 ----------------------------------------------------------- */

async function testErrorEnvelope(config: ServerConfig): Promise<void> {
  section('Error envelope (unknown profile)');

  const details: string[] = [];
  for (const locale of [LOCALE_A, LOCALE_B]) {
    try {
      await translateText(client(locale), {
        text: 'hello',
        source_lang: config.session.default_source_lang,
        target_lang: config.session.default_target_lang,
        profile: 'nope',
      });
      bad(`rejected (locale=${locale})`, 'the request succeeded');
    } catch (error) {
      if (!(error instanceof ApiError)) {
        bad(`rejected (locale=${locale})`, String(error));
        continue;
      }
      details.push(error.message);
      check(`status 400 (locale=${locale})`, error.status === 400, String(error.status));
      check(`code parsed (locale=${locale})`, error.code === 'profile.unknown', error.code);
      check(
        `params parsed (locale=${locale})`,
        error.params.profile === 'nope',
        JSON.stringify(error.params),
      );
      console.log(`        detail: ${error.message}`);
    }
  }

  check(
    'detail differs per locale',
    details.length === 2 && details[0] !== details[1],
    `${details[0]} / ${details[1]}`,
  );
}

/* ---- 4. WS 왕복 ------------------------------------------------------------- */

/** 44바이트 WAV 헤더를 건너뛰고 PCM 만 꺼낸다. 검증용이라 정식 파서를 쓰지 않는다. */
function readPcm(path: string): Buffer {
  const wav = readFileSync(path);
  return wav.subarray(44);
}

async function testStreamRoundTrip(config: ServerConfig): Promise<void> {
  section('WS round trip');

  const url = streamUrl(BASE_URL, config.stream.path);
  const seen: string[] = [];
  const texts: Record<string, string> = {};

  const session = openStream({
    url,
    webSocket: makeSocket,
    config: {
      type: 'config',
      profile: config.session.default_profile,
      source_lang: config.session.default_source_lang,
      target_lang: config.session.default_target_lang,
      sample_rate: config.audio.stt_sample_rate,
      locale: LOCALE_A,
      with_audio: true,
    },
    onEvent: (event: StreamEvent) => seen.push(event.type),
    onAudio: (chunk, audio) => {
      texts['tts.bytes'] = String(audio.byteLength);
      texts['tts.sr'] = String(chunk.sr);
      texts['tts.content_type'] = String(chunk.content_type);
    },
    handlers: {
      'stt.final': (event) => {
        texts['stt'] = event.text;
      },
      'llm.final': (event) => {
        texts['llm'] = event.text;
      },
      error: (event) => {
        texts['error'] = `${event.code}: ${event.message}`;
      },
    },
    onWarning: (message, detail) => console.log(`        warning: ${message}`, detail ?? ''),
  });

  const ready = await timeout(session.whenReady(), 10000, 'ready');
  check('ready received', ready.type === 'ready', `session=${ready.session_id}`);
  check(
    'ready echoes the audio spec',
    ready.audio.sample_rate === config.audio.stt_sample_rate,
    `${ready.audio.sample_rate}Hz ${ready.audio.format}, ${ready.audio.frame_ms}ms, vad=${ready.vad.backend}`,
  );
  check(
    'participants delivered',
    ready.participants.length > 0,
    ready.participants.map((p) => `${p.id}(${p.lang})`).join(' -> '),
  );

  if (!AUDIO_PATH) {
    console.log('  SKIP  audio round trip — TRANSLATE_AUDIO is not set');
    session.close();
    return;
  }

  // 20ms = 640바이트씩. 숫자는 /v1/config 에서 계산한다.
  const chunkBytes = frameBytes(config);
  const pcm = readPcm(AUDIO_PATH);
  let frames = 0;
  for (let at = 0; at < pcm.length; at += chunkBytes) {
    const frame = pcm.subarray(at, Math.min(at + chunkBytes, pcm.length));
    if (frame.length < chunkBytes) break;
    session.sendAudio(frame);
    frames += 1;
    // 실시간처럼 흘려보낸다. 한 번에 다 밀어 넣으면 서버 쪽 VAD 가 한 덩어리로 본다.
    if (frames % 10 === 0) await sleep(4);
  }
  check('audio streamed', frames > 0, `${frames} frames x ${chunkBytes} bytes`);

  // 꼬리 무음을 기다리는 대신 강제로 세그먼트를 끊는다.
  session.flush();

  await timeout(waitFor(() => seen.includes('tts.done') || 'error' in texts), 60000, 'tts.done');

  check('stt.final received', typeof texts['stt'] === 'string', texts['stt']);
  check('llm.final received', typeof texts['llm'] === 'string', texts['llm']);
  check('tts.done received', seen.includes('tts.done'));
  check(
    'tts audio paired with its chunk',
    texts['tts.bytes'] !== undefined,
    `${texts['tts.bytes']} bytes, sr=${texts['tts.sr']}, ${texts['tts.content_type']}`,
  );
  check('metrics received', seen.includes('metrics'));
  console.log(`        events: ${seen.join(', ')}`);

  session.close();
}

/* ---- 5. WS 오류 이벤트 ------------------------------------------------------- */

async function testStreamError(config: ServerConfig): Promise<void> {
  section('WS error event (unknown profile)');

  const session = openStream({
    url: streamUrl(BASE_URL, config.stream.path),
    webSocket: makeSocket,
    config: {
      type: 'config',
      profile: 'nope',
      source_lang: config.session.default_source_lang,
      target_lang: config.session.default_target_lang,
      sample_rate: config.audio.stt_sample_rate,
      locale: LOCALE_A,
    },
  });

  try {
    await timeout(session.whenReady(), 10000, 'ws error');
    bad('rejected', 'the session became ready');
  } catch (error) {
    if (!(error instanceof StreamError)) {
      bad('rejected', String(error));
    } else {
      check('code parsed', error.code === 'profile.unknown', error.code);
      check('params parsed', error.params.profile === 'nope', JSON.stringify(error.params));
      check('message is a rendered sentence', error.message.length > 0, error.message);
    }
  }
  session.close();
}

/* ---- 잡동사니 --------------------------------------------------------------- */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 조건이 참이 될 때까지. 이벤트 기반이 아니라 단순 폴링이면 충분한 자리다. */
function waitFor(condition: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => {
      if (condition()) resolve();
      else setTimeout(tick, 50);
    };
    tick();
  });
}

async function main(): Promise<void> {
  console.log(`server: ${BASE_URL}`);
  const config = await testConfig();
  await testTextRoundTrip(config);
  await testErrorEnvelope(config);
  await testStreamRoundTrip(config);
  await testStreamError(config);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nThe smoke test crashed:', error);
  process.exit(1);
});
