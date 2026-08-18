/**
 * `GET /v1/models` — 프로바이더가 **지금** 내주는 모델 목록.
 *
 * 왜 `/v1/config` 와 따로인가
 * --------------------------
 * `/v1/config` 는 앱이 시작할 때마다 부르는 응답이다. 거기서 프로바이더 9곳을 조회하면
 * 앱 시작이 그만큼 늦어진다. 그래서 목록은 **필요한 화면(설정)이 따로** 부른다.
 * 서버가 캐시하므로(기본 15분) 두 번째부터는 바로 온다.
 *
 * 왜 목록을 받아오는가
 * -------------------
 * 모델 이름을 설정에 박아두면 프로바이더가 목록을 바꿀 때 번역이 통째로 멈춘다.
 * 2026-08 에 실제로 멈췄다 — Groq 이 `llama-3.3-70b-versatile` 을 없애 404 가 돌아왔다.
 * 그래서 이름을 아무도 기억하지 않고 그때그때 물어본다. 이 파일에도 모델 이름이 없다.
 */

import { request } from './http';
import type { ApiClient } from './http';

/** 이 경로도 계약이다 (`/v1/config`·`/health` 와 같다). */
export const MODELS_PATH = '/v1/models';

/** 프로바이더 하나의 조회 결과. */
export interface ProviderModels {
  id: string;
  label: string;
  /**
   * 조회가 실패해도 이 값으로는 번역이 돌아간다 — `providers.yaml` 의 폴백.
   * 비어 있으면 그 프로바이더를 고른 요청은 서버가 거절한다.
   */
  default_model: string | null;
  /** 고를 수 있는 이름들. 실패했으면 빈 배열이다. */
  models: string[];
  /** 조회에 성공했는가. false 면 `reason` 에 서버가 렌더한 문장이 있다. */
  ok: boolean;
  /** 못 받은 이유 (요청 로케일로 렌더된 문장). 성공이면 null. */
  reason: string | null;
  /** 기계가 읽을 오류 코드. 분기가 필요할 때만 본다. */
  error: string | null;
  /** 이 결과가 캐시에서 나온 것이면 몇 초 전 것인지. */
  age_s: number | null;
}

export interface ModelsResponse {
  locale: string;
  /** 서버가 결과를 재사용하는 시간(초). 0 이면 캐시하지 않는다. */
  cache_ttl_s: number;
  default_provider: string | null;
  providers: ProviderModels[];
}

/**
 * 모델 목록을 받아온다.
 *
 * `refresh` 를 주면 서버 캐시를 무시하고 다시 조회한다 — 프로바이더가 방금 모델을
 * 추가했을 때 쓴다. 그만큼 느리므로 사용자가 명시적으로 눌렀을 때만 쓸 것.
 */
export function fetchModels(client: ApiClient, refresh = false): Promise<ModelsResponse> {
  return request<ModelsResponse>(client, MODELS_PATH, {
    query: refresh ? { refresh: 'true' } : {},
  });
}

/** 한 프로바이더의 결과만. 없으면 undefined. */
export function providerModels(
  response: ModelsResponse | null,
  providerId: string,
): ProviderModels | undefined {
  if (!response) return undefined;
  return response.providers.find(p => p.id === providerId);
}
