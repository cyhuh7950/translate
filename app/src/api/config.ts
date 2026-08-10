/**
 * `GET /v1/config` — 앱이 화면을 그리는 유일한 근거.
 *
 * 프로필 목록도, 언어 목록도, 엔진 목록도, WS 경로도, 마이크 규격도 전부 이 응답에서 온다.
 * 앱에는 그중 어느 것도 박아두지 않는다. 서버 설정에 항목이 하나 늘면 앱은 그대로 늘어난
 * 목록을 받는다 — 이것이 이 프로젝트가 앱을 얇게 유지하는 방식이다.
 */

import { request } from './http';
import type { ApiClient } from './http';
import type {
  EngineView,
  LanguageOption,
  ProfileView,
  ProviderView,
  ServerConfig,
} from './types';

/** 이 경로만은 계약이라 여기 있다. 나머지 경로(WS)는 이 응답이 알려준다. */
export const CONFIG_PATH = '/v1/config';
export const HEALTH_PATH = '/health';

export interface HealthResponse {
  status: string;
  server_id: string;
  engines: { total: number; ready: number };
}

/**
 * 서버가 지금 무엇을 할 수 있는지 받아온다.
 *
 * `client.locale` 이 쿼리와 헤더에 함께 실린다. 응답의 `locale` 은 서버가 실제로 고른
 * 언어라, 요청한 것과 다르면 그 언어의 카탈로그가 없다는 뜻이다.
 */
export function fetchConfig(client: ApiClient): Promise<ServerConfig> {
  return request<ServerConfig>(client, CONFIG_PATH);
}

/** 인증이 필요 없는 유일한 경로. 연결 자체가 되는지 볼 때 쓴다. */
export function fetchHealth(client: ApiClient): Promise<HealthResponse> {
  return request<HealthResponse>(client, HEALTH_PATH);
}

/* ---- 응답에서 골라내는 것들 -------------------------------------------------
 *
 * 화면을 그릴 때 매번 쓰게 되는 조회들. 전부 응답만 보고 답한다 — 여기에 지식이 없다.
 */

/** 지금 고를 수 있는 프로필만. `available: false` 인 것은 이유(`reason`)를 보여줄 때 쓴다. */
export function availableProfiles(config: ServerConfig): ProfileView[] {
  return config.profiles.filter((p) => p.available);
}

export function findProfile(config: ServerConfig, id: string): ProfileView | undefined {
  return config.profiles.find((p) => p.id === id);
}

/** 준비된 엔진만. `kind` 를 주면 그 종류(stt/tts/…)로 거른다. */
export function readyEngines(config: ServerConfig, kind?: string): EngineView[] {
  return config.engines.filter((e) => e.ready && (kind === undefined || e.kind === kind));
}

export function availableProviders(config: ServerConfig): ProviderView[] {
  return config.llm.providers.filter((p) => p.available);
}

export function languageLabel(config: ServerConfig, code: string): string {
  const found: LanguageOption | undefined = config.languages.find((l) => l.code === code);
  return found ? found.label : code;
}

/**
 * 한 프레임에 담아야 할 PCM16 샘플 수.
 *
 * 20ms · 16kHz mono 면 320 샘플(640 바이트)이다. 그 숫자를 여기 적어두지 않고
 * `/v1/config` 의 값으로 계산하는 이유는, 서버가 규격을 바꾸면 앱이 따라가야 하기 때문이다.
 */
export function frameSamples(config: ServerConfig): number {
  return Math.round((config.audio.stt_sample_rate * config.stream.client_frame_ms) / 1000);
}

/** 같은 것을 바이트로. PCM16 이라 샘플당 2 바이트다. */
export function frameBytes(config: ServerConfig): number {
  return frameSamples(config) * 2 * config.audio.stt_channels;
}
