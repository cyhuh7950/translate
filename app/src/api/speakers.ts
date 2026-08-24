/**
 * 화자 등록(voice print) — `GET /v1/speakers` · `POST /v1/speakers/enroll` ·
 * `DELETE /v1/speakers/{id}`.
 *
 * 근거는 `orchestrator/app/server.py` 의 "음성 등록 (voice print)" 절이다. 정책·임계값·
 * 자동 등록 여부는 여기 없다 — `GET /v1/config` 의 `speaker_id` 절(`types.ts` 의
 * `SpeakerIdView`)에서 온다. 이 파일은 등록·조회·삭제 세 가지만 한다.
 *
 * ★ 임베딩 벡터는 응답 어디에도 없다. 서버가 절대 내보내지 않는다
 *   (`voiceprints.py` 의 `VoicePrint.public()` 주석 그대로) — 그래서 이 타입에도 없다.
 */

import { request } from './http';
import type { ApiClient, FormDataLike } from './http';

export const SPEAKERS_PATH = '/v1/speakers';

/** 등록된 화자 하나. */
export interface SpeakerPublic {
  id: string;
  name: string;
  utterances: number;
  dim: number;
  engine: string;
  model: string;
  created_at: string;
  updated_at: string;
}

/** `GET /v1/speakers` 응답. */
export interface SpeakersResponse {
  policy: string;
  threshold: number;
  auto_enroll: boolean;
  count: number;
  /** 저장소를 읽지 못했을 때만 채워진다. 서버가 렌더한 문장이라 그대로 보여주면 된다. */
  error: string | null;
  speakers: SpeakerPublic[];
}

/** 서버에 등록된 목소리 전부. 세션 중에 저절로 배운 것은 여기 없다 — 그것들은 세션과 함께 사라진다. */
export function fetchSpeakers(client: ApiClient): Promise<SpeakersResponse> {
  return request<SpeakersResponse>(client, SPEAKERS_PATH);
}

/**
 * 올릴 발화 클립 하나. **만드는 것은 호출자 몫이다** — `translateAudio()` 의 `file` 과
 * 같은 이유다. RN 은 `{uri, name, type}`(데이터 URI 도 된다), Node 는 `Blob` 이 된다.
 *
 * `filename` 은 `data` 가 **진짜 `Blob`** 일 때만 쓴다 — 표준 `FormData.append(key, value,
 * filename)` 은 `filename` 을 주면 `value` 가 Blob 이어야 한다고 강제한다(스펙 그대로다).
 * RN 의 `{uri, name, type}` 값은 Blob 이 아니므로 `filename` 을 비우고 `data.name` 에
 * 실어야 한다 — RN 의 `FormData.getParts()` 가 그 자리를 읽는다.
 */
export interface EnrollFile {
  data: any;
  filename?: string;
}

export interface EnrollRequest {
  /** 이 목소리가 속할 참여자 id. 프로필의 참여자 id 와 같아야 대조가 된다. */
  speaker_id: string;
  /** 표시 이름. 비우면 서버가 id 를 쓴다. */
  name?: string;
  /** 화자 임베딩 엔진 라우팅용. 설정 화면에서 고른 세션 모드를 그대로 보낸다. */
  mode?: string;
  /** 이 사람의 발화 클립들. 많을수록 평균 임베딩이 안정적이다(웹 클라이언트와 같은 이유). */
  files: EnrollFile[];
}

export interface EnrollResponse {
  speaker: SpeakerPublic;
  /** 올린 클립들이 서로 얼마나 닮았는지. `threshold` 보다 낮으면 다른 사람의 목소리가 섞였다는 뜻. */
  min_pairwise_similarity: number | null;
  threshold: number;
  /**
   * `min_pairwise_similarity` 가 `threshold` 보다 낮을 때만 채워진다. **서버가 요청
   * 로케일로 렌더한 문장이다 — 앱은 이것을 그대로 보여주고 문구를 만들지 않는다.**
   */
  warning: string | null;
  enrolled: number;
}

/**
 * 발화 클립들의 평균 임베딩을 등록한다(같은 id 가 있으면 대체). multipart 요청이라
 * `FormData` 도 주입받는다 — 이 계층은 RN 인지 Node 인지 모른다(`http.ts` 의 원칙).
 */
export function enrollSpeaker(
  client: ApiClient,
  req: EnrollRequest,
  formData: () => FormDataLike,
): Promise<EnrollResponse> {
  const form = formData();
  form.append('speaker_id', req.speaker_id);
  if (req.name) form.append('name', req.name);
  if (req.mode) form.append('mode', req.mode);
  for (const file of req.files) {
    if (file.filename) form.append('files', file.data, file.filename);
    else form.append('files', file.data);
  }
  return request<EnrollResponse>(client, `${SPEAKERS_PATH}/enroll`, { method: 'POST', body: form });
}

export interface DeleteSpeakerResponse {
  deleted: string;
  enrolled: number;
}

/** 등록된 목소리를 즉시 지운다. */
export function deleteSpeaker(client: ApiClient, speakerId: string): Promise<DeleteSpeakerResponse> {
  return request<DeleteSpeakerResponse>(client, `${SPEAKERS_PATH}/${encodeURIComponent(speakerId)}`, {
    method: 'DELETE',
  });
}
