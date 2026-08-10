/**
 * HTTP 번역 — `POST /v1/translate/text` 와 `POST /v1/translate/audio`.
 *
 * WS 스트림이 실시간 경로라면 이쪽은 한 발화를 통째로 보내는 경로다(PTT/배치).
 * 앱에서는 두 가지로 쓰인다.
 *
 *   - 기기 STT + 서버 TTS: 기기에서 받아적은 문장을 `/v1/translate/text` 에
 *     `with_audio` 로 보내면 번역 음성까지 돌아온다
 *   - 버튼을 눌러 녹음한 파일 하나를 `/v1/translate/audio` 로
 *
 * 응답 모양이 둘이라는 점만 주의하면 된다. `with_audio` 를 켜면 세션·참여자 모델을
 * 지나므로 응답이 `/v1/translate/audio` 와 같은 `SegmentResponse` 가 된다.
 */

import { request } from './http';
import type { ApiClient, FormDataLike } from './http';
import type { ContextTurn, SegmentResponse, TextTranslation } from './types';

export const TEXT_PATH = '/v1/translate/text';
export const AUDIO_PATH = '/v1/translate/audio';

/** 두 요청이 함께 쓰는 값들. 넣지 않은 것은 서버 기본값이 쓰인다. */
export interface TranslateCommon {
  source_lang: string;
  target_lang: string;
  profile?: string;
  mode?: string;
  /** 발화자 참여자 id. 후보가 하나뿐이면 없어도 정해진다. */
  speaker?: string;
  provider?: string;
  model?: string;
  /** `/v1/config` 의 `llm.styles` 중 하나. */
  style?: string;
  tts_engine?: string;
  voice?: string;
  speed?: number;
  response_format?: string;
  /** "json" 이면 오디오가 base64 로, "binary" 면 본문이 오디오 자체가 된다. */
  response_mode?: 'json' | 'binary';
}

export interface TextRequest extends TranslateCommon {
  text: string;
  context?: ContextTurn[];
  glossary?: Record<string, string>;
}

/**
 * 텍스트만 번역한다. LLM 계층만 지나므로 가장 빠르다.
 *
 * `stream: true` 는 본문이 JSON 이 아니라 토큰이 흘러나오는 평문이라 여기서 다루지 않는다.
 * 흘려보내면서 소리까지 내는 경로는 WS 다.
 */
export function translateText(client: ApiClient, req: TextRequest): Promise<TextTranslation> {
  return request<TextTranslation>(client, TEXT_PATH, {
    method: 'POST',
    json: { ...req, with_audio: false, stream: false },
  });
}

/**
 * 텍스트를 번역하고 **소리까지** 받는다 (기기 STT + 서버 TTS).
 *
 * 세션 모델을 지나므로 응답에 `from`/`to` 가 붙고, `deliveries[].audio_base64` 에
 * 오디오가 실린다(`response_mode` 가 json 일 때).
 */
export function translateTextWithAudio(
  client: ApiClient,
  req: TextRequest,
): Promise<SegmentResponse> {
  return request<SegmentResponse>(client, TEXT_PATH, {
    method: 'POST',
    json: { ...req, with_audio: true, stream: false },
  });
}

export interface AudioRequest extends TranslateCommon {
  /**
   * 업로드할 파일. **만드는 것은 호출자 몫이다** — Node 에서는 `Blob`, React Native
   * 에서는 `{ uri, name, type }` 이라 여기서 만들 수 없다.
   */
  file: any;
  /** 서버가 확장자로 형식을 보므로 이름이 의미가 있다. */
  filename?: string;
  stt_engine?: string;
  /** false 면 TTS 를 건너뛰고 텍스트만 받는다. */
  with_audio?: boolean;
}

/**
 * 오디오 파일 하나를 올려 번역 음성을 받는다.
 *
 * `FormData` 도 주입받는다. 생성자가 환경마다 다르고(RN 은 전역, Node 22 도 전역이지만
 * 파일 값의 모양이 다르다) 이 계층은 어느 쪽도 알지 않기로 했기 때문이다.
 */
export function translateAudio(
  client: ApiClient,
  req: AudioRequest,
  formData: () => FormDataLike,
): Promise<SegmentResponse> {
  const form = formData();
  if (req.filename) form.append('file', req.file, req.filename);
  else form.append('file', req.file);

  // 빈 값은 넣지 않는다. 넣으면 서버 기본값 대신 빈 값이 적용된다.
  const fields: Record<string, unknown> = {
    source_lang: req.source_lang,
    target_lang: req.target_lang,
    profile: req.profile,
    mode: req.mode,
    speaker: req.speaker,
    stt_engine: req.stt_engine,
    tts_engine: req.tts_engine,
    voice: req.voice,
    speed: req.speed,
    response_format: req.response_format,
    provider: req.provider,
    model: req.model,
    style: req.style,
    with_audio: req.with_audio,
    response_mode: req.response_mode,
  };
  for (const key of Object.keys(fields)) {
    const value = fields[key];
    if (value === undefined || value === null || value === '') continue;
    form.append(key, String(value));
  }

  return request<SegmentResponse>(client, AUDIO_PATH, { method: 'POST', body: form });
}

/** 오디오가 실린 첫 번째 결과. 단방향이면 수신자가 하나라 이것이 곧 답이다. */
export function firstAudioDelivery(result: SegmentResponse) {
  return result.deliveries.find((d) => d.audio_base64 !== undefined && d.audio_base64 !== '');
}
