/**
 * `POST /v1/users`, `POST /v1/users/login` — 계정(이름 + PIN, 계정 가입이 아니다).
 *
 * `DESIGN.md` §15 / `orchestrator/app/server.py` 를 그대로 따른다.
 *
 *   - 세션 토큰은 없다. 로그인은 `user_id` 만 돌려주고, 이후 그 사람 것으로 스코프해야
 *     하는 요청(화자 등록·STT 개인화·언어 학습)에 앱이 `user_id` 를 직접 실어 보낸다.
 *   - PIN 은 등록/로그인 요청에만 쓰이고 기기에 남지 않는다 — 남기는 것은 `user_id`
 *     하나뿐이다(`storage.ts`).
 *   - 오류 문구는 서버가 로케일로 렌더한 것을 그대로 쓴다(§2 원칙과 동일) — 앱에
 *     `users.name_taken` 같은 코드의 문구 카탈로그를 두지 않는다.
 */

import { request } from './http';
import type { ApiClient } from './http';

export interface UserCredentials {
  name: string;
  pin: string;
}

/** `POST /v1/users` 응답의 `user` — `pin_hash` 는 절대 포함되지 않는다. */
export interface PublicUser {
  id: string;
  name: string;
  created_at: string;
}

/** 계정을 새로 만든다. 이름이 이미 있으면 서버가 `users.name_taken` 으로 거절한다. */
export function registerUser(client: ApiClient, credentials: UserCredentials): Promise<PublicUser> {
  return request<{ user: PublicUser }>(client, '/v1/users', {
    method: 'POST',
    json: credentials,
  }).then((res) => res.user);
}

/**
 * 이름 + PIN 으로 로그인한다. 성공하면 `user_id` 만 돌아온다 — 그 값을 기기에 남겨두고
 * (`storage.ts`) 이후 요청에 실어 보내면 된다.
 */
export function loginUser(client: ApiClient, credentials: UserCredentials): Promise<string> {
  return request<{ user_id: string }>(client, '/v1/users/login', {
    method: 'POST',
    json: credentials,
  }).then((res) => res.user_id);
}
