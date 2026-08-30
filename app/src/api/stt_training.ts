/**
 * `stt_training` 모듈의 클라이언트 — 낭독 교정·정오 판정 데이터 수집.
 *
 * ⚠️ **서버에 아직 이 모듈이 없다**(2026-08-30 시점, `PLAN_STT_PERSONALIZATION.md`
 * 0단계는 계획만 확정됐다). 경로·필드 이름은 그 계획서 문장을 그대로 코드로 옮긴
 * 추정 계약이다 — 서버가 실제로 붙으면 `MESSAGE_TO_SERVER.md` 로 맞춰보고 다르면
 * 이 파일과 `./types.ts` 의 `SttTraining*` 타입만 고치면 된다(화면은 이 함수들
 * 뒤에 있으니 손대지 않아도 된다).
 *
 * **multipart 가 아니라 JSON+base64 로 오디오를 보낸다.** RN 의 `FormData` 는 실제
 * 파일 `uri`(`file://`, `content://` …)만 담을 수 있고 메모리에 있는 바이너리를 직접
 * 담지 못한다(RN 소스 `Libraries/Network/FormData.js` — part 값이 `string` 이거나
 * `{uri, name?, type?}` 뿐이다). `lang_learn` 의 WS 응답이 이미 오디오를 base64 로
 * 실어 보내는 것과 같은 관례라 요청 쪽에도 그대로 맞췄다 — 새 파일시스템 의존성
 * (`react-native-fs` 등) 없이 끝난다.
 */

import { request } from './http';
import type { ApiClient } from './http';
import type {
  SttTrainingNextPrompt,
  SttTrainingReadSampleRequest,
  SttTrainingReadSampleResponse,
  SttTrainingStatus,
  SttTrainingVerdictRequest,
  SttTrainingVerdictResponse,
  SttTrainingVerifyRequest,
  SttTrainingVerifyResponse,
} from './types';

function base(userId: string): string {
  return `/v1/users/${encodeURIComponent(userId)}/stt_training`;
}

/** 낭독·정오판정 진행도를 함께 받는다. 화면의 진행률 표시(0-A4)가 이걸 쓴다. */
export function getSttTrainingStatus(client: ApiClient, userId: string): Promise<SttTrainingStatus> {
  return request<SttTrainingStatus>(client, `${base(userId)}/status`);
}

/** 아직 안 읽은 문장 하나. 목표를 채웠으면 `done:true` 뿐이다. */
export function getNextPrompt(
  client: ApiClient,
  userId: string,
  lang?: string,
): Promise<SttTrainingNextPrompt> {
  return request<SttTrainingNextPrompt>(client, `${base(userId)}/next_prompt`, {
    query: { lang },
  });
}

/** 낭독 음성을 올린다. */
export function uploadReadSample(
  client: ApiClient,
  userId: string,
  req: SttTrainingReadSampleRequest,
): Promise<SttTrainingReadSampleResponse> {
  return request<SttTrainingReadSampleResponse>(client, `${base(userId)}/read_sample`, {
    method: 'POST',
    json: req,
  });
}

/** 자유발화 음성을 올려 STT 인식 결과를 받는다. 판정 전 임시 저장 상태다. */
export function uploadVerify(
  client: ApiClient,
  userId: string,
  req: SttTrainingVerifyRequest,
): Promise<SttTrainingVerifyResponse> {
  return request<SttTrainingVerifyResponse>(client, `${base(userId)}/verify`, {
    method: 'POST',
    json: req,
  });
}

/**
 * 인식 결과에 대한 판정. `correct:false` 면 `corrected_text` 없이는 서버가
 * 400 으로 거절한다(§16 — 정답 없는 "틀렸다"는 안 받는다).
 */
export function submitVerdict(
  client: ApiClient,
  userId: string,
  sampleId: string,
  verdict: SttTrainingVerdictRequest,
): Promise<SttTrainingVerdictResponse> {
  return request<SttTrainingVerdictResponse>(
    client,
    `${base(userId)}/verify/${encodeURIComponent(sampleId)}/verdict`,
    { method: 'POST', json: verdict },
  );
}
