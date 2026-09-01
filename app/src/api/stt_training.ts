/**
 * `stt_training` 모듈의 클라이언트 — 낭독 교정·정오 판정 데이터 수집.
 *
 * 서버 확정 계약: multipart FormData 안에 WAV 파일을 넣는다. 파일 URI는 환경별
 * 네이티브 파일 경로를 그대로 사용해 React Native의 Blob 비호환을 피한다.
 */

import { request } from './http';
import type { ApiClient, FormDataLike } from './http';
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
    body: makeMultipart(client, form => {
      form.append('prompt_id', req.prompt_id);
      form.append('file', { uri: req.audio_uri, name: 'sample.wav', type: req.content_type });
    }),
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
    body: makeMultipart(client, form => {
      form.append('file', { uri: req.audio_uri, name: 'sample.wav', type: req.content_type });
    }),
  });
}

function makeMultipart(client: ApiClient, fill: (form: FormDataLike) => void): FormDataLike {
  if (!client.formData) throw new Error('multipart audio upload is not configured');
  const form = client.formData();
  fill(form);
  return form;
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
