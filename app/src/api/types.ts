/**
 * 서버가 실제로 보내는 것의 타입.
 *
 * 추측으로 쓴 것이 하나도 없다. 근거는 아래 네 곳이다.
 *
 *   orchestrator/app/server.py                            /v1/config, 오류 봉투
 *   orchestrator/app/modules/translate/routes.py          HTTP 요청·응답
 *   orchestrator/app/modules/translate/streaming.py       WS 이벤트 전부
 *   orchestrator/app/modules/translate/pipeline.py        세그먼트 결과 모양
 *
 * 값(엔진 이름·프로필 id·언어 코드 …)은 **문자열로 둔다.** 유니온으로 좁히면 서버 설정에
 * 항목을 하나 더할 때마다 앱을 고쳐야 한다 — 이 프로젝트가 피하려는 것이 정확히 그것이다.
 */

/* ---- 오류 봉투 ------------------------------------------------------------ */

/**
 * 기계가 읽는 부분. 문구를 파싱하는 대신 이 `code` 로 분기한다.
 * 코드 목록은 config/messages/*.yaml 에 있다 (예: `profile.unknown`, `stream.sample_rate`).
 */
export interface ErrorInfo {
  code: string;
  params: Record<string, unknown>;
}

/**
 * HTTP 오류 응답 본문.
 *
 * `detail` 은 **요청 로케일로 이미 렌더된 문장**이다. 앱은 그대로 보여주면 되고,
 * 클라이언트에 문구 카탈로그를 두지 않는다. 앱이 할 일은 로케일을 실어 보내는 것뿐이다.
 */
export interface ErrorEnvelope {
  detail: string;
  error: ErrorInfo;
}

/* ---- GET /v1/config -------------------------------------------------------- */

export interface LanguageOption {
  code: string;
  /** 표시 이름. 요청 로케일로 이미 번역돼 있다. */
  label: string;
}

/** 프로필이 정의한 참여자 한 명. `lang` 은 세션이 열리기 전이라 아직 비어 있을 수 있다. */
export interface ParticipantSpec {
  id: string;
  lang: string | null;
  /** 이 참여자의 언어를 무엇으로 채우는지 (`source_lang` / `target_lang`). */
  lang_var?: string | null;
  input: boolean;
  output: string[];
}

export interface ProfileView {
  id: string;
  label: string;
  description: string;
  speaker_id: string;
  turn_policy: string;
  participants: ParticipantSpec[];
  participant_count: number;
  bidirectional: boolean;
  /** false 면 고를 수 없다. 이유는 `reason` 에 문장으로 들어 있다. */
  available: boolean;
  reason: string | null;
}

export interface EngineView {
  id: string;
  /** "stt" | "tts" | ... — 종류도 설정에서 오므로 좁히지 않는다. */
  kind: string;
  server: string;
  modes: string[];
  streaming: boolean;
  available: boolean;
  ready: boolean;
  model: string | null;
  languages: string[] | null;
  voices: string[] | null;
  default_voice: string | null;
  error: string | null;
}

export interface ProviderView {
  id: string;
  label: string;
  kind: string;
  default_model: string | null;
  fast: boolean;
  available: boolean;
  reason: string | null;
}

export interface SessionDefaults {
  default_profile: string;
  default_mode: string;
  allow_profile_override: boolean;
  allow_mode_override: boolean;
  default_source_lang: string;
  default_target_lang: string;
}

export interface LlmView {
  default_provider: string;
  style: string;
  styles: string[];
  context_turns: number;
  providers: ProviderView[];
}

/** 마이크 캡처 규격의 근거. 앱은 이 값에 맞춰 PCM 을 만든다. */
export interface AudioView {
  stt_sample_rate: number;
  stt_channels: number;
  tts_response_format: string;
}

export interface VadView {
  backend: string;
  available: string[];
  silence_ms: number;
  min_speech_ms: number;
}

export interface AudioFilterView {
  enabled: boolean;
  implementation: string;
  available: string[];
}

export interface TurnView {
  default_policy: string;
  available: string[];
}

export interface SpeakerIdView {
  default: string;
  available: string[];
  policy: string;
  policies: string[];
  threshold: number;
  auto_enroll: boolean;
  enrolled: number;
  store_error: string | null;
}

export interface ClientView {
  input_modes: string[];
  default_input_mode: string;
}

/**
 * WebSocket 규격. **translate 모듈이 얹는 섹션이다.**
 *
 * `path` 가 여기 있다는 것이 요점이다 — WS 경로를 앱에 박지 않고 이 값에서 가져온다.
 */
export interface StreamView {
  path: string;
  /** 지금은 "pcm16". 서버가 정하는 값이므로 좁히지 않는다. */
  input_format: string;
  /** 한 바이너리 프레임의 길이(ms). 20ms · 16kHz mono → 320 샘플 · 640 바이트. */
  client_frame_ms: number;
}

/**
 * `GET /v1/config` 응답 전체.
 *
 * 인덱스 시그니처가 붙어 있는 것은 **모듈이 자기 섹션을 얹기 때문**이다(`stream` 이 그렇다).
 * 새 모듈이 붙어도 이 타입을 고치지 않고 읽을 수 있어야 한다.
 */
export interface ServerConfig {
  server_id: string;
  /** 서버가 실제로 고른 표시 언어. 요청한 로케일을 못 알아들었으면 다른 값이 온다. */
  locale: string;
  session: SessionDefaults;
  languages: LanguageOption[];
  profiles: ProfileView[];
  engines: EngineView[];
  llm: LlmView;
  implementations: Record<string, string[]>;
  routing: { policy: string; available: string[] };
  audio: AudioView;
  vad: VadView;
  audio_filter: AudioFilterView;
  turn: TurnView;
  speaker_id: SpeakerIdView;
  client: ClientView;
  stream: StreamView;
  /** `lang_learn` 모듈이 얹는 섹션. 그 모듈이 붙어 있지 않은 서버에서는 없다. */
  lang_learn?: LangLearnConfigView;
  /** `stt_training` 모듈이 얹는 섹션. 그 모듈이 붙어 있지 않은 서버에서는 없다. */
  stt_training?: SttTrainingConfigView;
  [section: string]: unknown;
}

/* ---- HTTP: 번역 결과 ------------------------------------------------------- */

/** 한 수신자에게 간 번역 한 벌. `audio_base64` 는 json 응답 모드에서만 붙는다. */
export interface DeliveryMeta {
  to: string;
  lang: string;
  text: string;
  content_type: string | null;
  sample_rate: number | null;
  duration: number | null;
  audio_bytes: number;
  audio_base64?: string;
}

/**
 * `/v1/translate/audio` 와 `/v1/translate/text?with_audio=true` 의 공통 응답.
 * 두 입구가 같은 모양으로 답하는 것은 서버가 `_segment_response()` 하나로 만들기 때문이다.
 */
export interface SegmentResponse {
  seg: number;
  from: string;
  source_lang: string;
  source_text: string;
  deliveries: DeliveryMeta[];
  engines: Record<string, string>;
  metrics: Record<string, unknown>;
}

/** `with_audio` 없이 부른 `/v1/translate/text` 의 응답. 세션 모델을 지나지 않는다. */
export interface TextTranslation {
  text: string;
  source_lang: string;
  target_lang: string;
  provider: string;
  model: string | null;
  elapsed_s: number;
}

/** 대화 맥락 한 턴. 한국어는 주어 생략이 많아 이것이 있어야 대명사가 맞는다. */
export interface ContextTurn {
  source: string;
  target: string;
}

/* ---- WS: 클라이언트 → 서버 -------------------------------------------------- */

/**
 * 연결 직후 딱 한 번 보내는 메시지.
 *
 * **빈 값은 넣지 않는다.** 서버는 없는 키에만 자기 기본값을 쓰므로, 빈 문자열을 보내면
 * 기본값 대신 빈 값이 적용되는 자리가 생긴다 (`streaming.py` 의 `_options` 를 볼 것).
 */
export interface StreamConfigMessage {
  type: 'config';
  source_lang: string;
  target_lang: string;
  /**
   * 오류 문구의 언어. 브라우저는 WS 핸드셰이크에 헤더를 못 붙여서 여기 싣지만,
   * 앱은 헤더도 붙일 수 있다. 둘 다 되면 이 값이 이긴다.
   */
  locale?: string;
  /**
   * 보낼 PCM 의 샘플레이트. 서버는 리샘플링을 조용히 해주지 않는다 —
   * `/v1/config` 의 `audio.stt_sample_rate` 와 다르면 `stream.sample_rate` 오류로 끊긴다.
   */
  sample_rate?: number;
  profile?: string;
  mode?: string;
  participants?: unknown;
  /** 발화자 참여자 id. 후보가 하나뿐인 단방향에서는 없어도 정해진다. */
  speaker?: string;
  stt_engine?: string;
  tts_engine?: string;
  voice?: string;
  speed?: number;
  response_format?: string;
  provider?: string;
  model?: string;
  style?: string;
  glossary?: Record<string, string>;
  /** false 면 TTS 를 건너뛴다. 텍스트만 필요할 때 지연이 크게 준다. */
  with_audio?: boolean;
}

export interface StreamControlMessage {
  type: 'control';
  /**
   * flush    지금까지 들어온 것을 강제로 한 세그먼트로 확정 (PTT 버튼을 뗐을 때)
   * cancel   진행 중인 세그먼트를 버린다
   * playback 실제 재생 상태 통지. 서버의 추정을 덮는다 (턴 정책용, 선택)
   */
  action: 'flush' | 'cancel' | 'playback';
  state?: 'start' | 'end';
}

export type StreamClientMessage = StreamConfigMessage | StreamControlMessage;

/* ---- WS: 서버 → 클라이언트 -------------------------------------------------- */

/**
 * 모든 이벤트에 붙는 라우팅.
 *
 * `to` 의 타입이 이벤트마다 다르다는 것이 규약이다. 발화자 쪽 이벤트(ready·vad·stt.*)는
 * 수신자 **배열**, 수신자 하나에 대한 이벤트(llm.*·tts.*)는 **문자열**이다.
 * 다중 기기에서는 자기 id 가 `to` 에 있는 것만 보면 된다.
 *
 * 세션이 열리기 전이거나 발화자를 아직 정할 수 없으면 아예 붙지 않는다 (`_route()`).
 */
export interface SpeakerRouted {
  from?: string;
  to?: string[];
}

export interface ListenerRouted {
  from?: string;
  to?: string;
}

export interface ReadyEvent extends SpeakerRouted {
  type: 'ready';
  session_id: string;
  participants: ParticipantSpec[];
  profile: string;
  mode: string;
  turn_policy: string;
  /** 서버가 확정한 입력 규격. 우리가 선언한 것과 다르면 여기 오기 전에 오류가 났을 것이다. */
  audio: {
    sample_rate: number;
    channels: number;
    format: string;
    frame_ms: number;
  };
  vad: { backend: string };
}

export interface VadEvent extends SpeakerRouted {
  type: 'vad';
  state: 'speech_start' | 'speech_end';
  at_ms: number;
  duration_ms?: number;
  speech_ms?: number;
  reason?: string;
  /** speech_end 에만 붙는다. true 면 min_speech_ms 에 못 미쳐 버려졌다 — 파이프라인이 돌지 않는다. */
  dropped?: boolean;
}

export interface SttEventBase extends SpeakerRouted {
  seg: number;
  lang: string;
  text: string;
}

export interface SttFinalEvent extends SttEventBase {
  type: 'stt.final';
}

/** 프로토콜에는 있지만 스트리밍 STT 엔진이 붙기 전(2단계)까지 오지 않는다. */
export interface SttPartialEvent extends SttEventBase {
  type: 'stt.partial';
}

export type SttEvent = SttFinalEvent | SttPartialEvent;

export interface LlmEventBase extends ListenerRouted {
  seg: number;
  lang: string;
  text: string;
}

export interface LlmFinalEvent extends LlmEventBase {
  type: 'llm.final';
}

/** 마찬가지로 2단계에서 같은 자리에 채워진다. */
export interface LlmDeltaEvent extends LlmEventBase {
  type: 'llm.delta';
}

export type LlmEvent = LlmFinalEvent | LlmDeltaEvent;

/**
 * 오디오가 뒤따른다는 예고. **바로 다음 바이너리 프레임이 이 청크의 오디오다.**
 * 서버가 송신 락으로 이 짝을 보장하므로 사이에 다른 이벤트가 끼지 않는다.
 */
export interface TtsChunkEvent extends ListenerRouted {
  type: 'tts.chunk';
  seg: number;
  seq: number;
  /** 합성된 오디오의 샘플레이트. 입력(16k)과 다르다. */
  sr: number | null;
  content_type: string | null;
  /** 초. 재생 시간 추정에 쓴다. */
  duration: number | null;
}

export interface TtsDoneEvent extends ListenerRouted {
  type: 'tts.done';
  seg: number;
}

/** barge_in 정책에서 사용자가 말을 시작했다 — 재생을 멈추라는 지시다. */
export interface TtsStopEvent extends SpeakerRouted {
  type: 'tts.stop';
}

export interface CancelledEvent extends SpeakerRouted {
  type: 'cancelled';
}

/**
 * 오류가 **아니다.** 화자 식별이 이 세그먼트를 처리하지 않기로 한 것이고,
 * 같은 사유가 뒤따르는 metrics 의 `skipped` 에도 실린다.
 * 관측값(유사도·임계값 등)이 그대로 얹혀 오므로 인덱스 시그니처를 둔다.
 */
export interface SpeakerRejectedEvent {
  type: 'speaker.rejected';
  seg: number;
  reason: string;
  [detail: string]: unknown;
}

/** 세그먼트 한 건의 지표. 키 목록은 엔진·설정에 따라 달라지므로 고정하지 않는다. */
export interface MetricsEvent {
  type: 'metrics';
  seg: number;
  from: string;
  to: string[];
  [metric: string]: unknown;
}

/**
 * WS 오류. `message` 는 **세션 로케일로 렌더된 문장**이라 그대로 보여주면 된다.
 * 분기는 `code` 로 한다.
 */
export interface StreamErrorEvent extends SpeakerRouted {
  type: 'error';
  code: string;
  message: string;
  params: Record<string, unknown>;
}

/** 지금 우리가 아는 이벤트 전부. `type` 으로 좁혀 쓴다. */
export type KnownStreamEvent =
  | ReadyEvent
  | VadEvent
  | SttEvent
  | LlmEvent
  | TtsChunkEvent
  | TtsDoneEvent
  | TtsStopEvent
  | CancelledEvent
  | SpeakerRejectedEvent
  | MetricsEvent
  | StreamErrorEvent;

/** 아는 이벤트의 `type` 값들. */
export type StreamEventType = KnownStreamEvent['type'];

/**
 * 모르는 이벤트. 서버가 단계를 늘려도 클라이언트가 깨지지 않게 그대로 흘려보낸다
 * (`streaming.py` 의 `_on_stage()` 마지막 줄이 그렇게 되어 있다).
 */
export interface UnknownStreamEvent {
  type: string;
  [key: string]: unknown;
}

/** 소켓에서 실제로 올라오는 것. 아는 것이거나, 아직 모르는 것이거나 둘 중 하나다. */
export type StreamEvent = KnownStreamEvent | UnknownStreamEvent;

/** `type` 에서 그 이벤트의 타입을 뽑는다. 핸들러 맵이 이것으로 만들어진다. */
export type StreamEventOf<K extends StreamEventType> = Extract<KnownStreamEvent, { type: K }>;

/* ---- lang_learn: 설정 -------------------------------------------------------
 *
 * 근거: orchestrator/app/modules/lang_learn/routes.py (HTTP), config/defaults.yaml
 * (lang_learn: 섹션), DESIGN.md §15 (프로토콜·설정 스키마).
 */

export interface LangLearnScheduleSlot {
  /** "HH:MM", 24시간제. */
  time: string;
  count: number;
}

/** 사용자별 학습 설정. `GET/PUT /v1/users/{id}/lang_learn/settings` 의 본문 그대로. */
export interface LangLearnSettings {
  schedule: LangLearnScheduleSlot[];
  target_lang: string;
  /** adaptive | manual — 값 목록을 앱에 두지 않는다. */
  level_mode: string;
  manual_level: string | null;
  /** immediate | summary | both */
  feedback_mode: string;
  show_text_for_repeat: boolean;
}

/** `/v1/config` 의 `lang_learn` 섹션 — WS 경로를 여기서 얻는다(하드코딩하지 않는다). */
export interface LangLearnConfigView {
  stream: { path: string; default_count: number };
  /** 적응형 난이도 단계 이름. 순서가 등급이다(낮은 인덱스가 쉬움). */
  levels: string[];
  /** 아무도 설정을 저장하지 않은 사용자가 받는 기본값. */
  defaults: LangLearnSettings;
  /** 세션당 문제 유형이 오가는 순서(`repeat`/`compose`가 이 순서를 반복한다). */
  answer_type_pattern: string[];
}

/** `GET /v1/users/{id}/lang_learn/history` 한 항목의 문제 하나. */
export interface LangLearnProblemRecord {
  idx: number;
  answer_type: string;
  problem_text: string;
  answer_text: string;
  grade: string;
  comment: string;
}

/** 과거 학습 세션 이력 한 건. 내부 점수는 프로토콜과 마찬가지로 나가지 않는다. */
export interface LangLearnHistorySession {
  id: string;
  created_at: string;
  target_lang: string;
  level: string;
  feedback_mode: string;
  problems: LangLearnProblemRecord[];
  summary_grade: string | null;
  summary_comment: string | null;
}

/* ---- lang_learn: WS 프로토콜 ------------------------------------------------
 *
 * 근거: orchestrator/app/modules/lang_learn/session.py. `/v1/stream`(번역)과 별개
 * 엔드포인트라 StreamEvent 계열과 타입을 공유하지 않는다 — 이벤트 이름은 같아도
 * (`ready`/`error`) 모양이 다르다.
 */

/** 접속 후 딱 한 번 보내는 메시지. 값이 없는 필드는 저장된 설정을 그대로 쓴다. */
export interface LangLearnStartMessage {
  type: 'start';
  user_id: string;
  /** 없으면 서버 기본값(`lang_learn.stream.default_count`). */
  count?: number;
  locale?: string;
}

/** 답변 — 텍스트면 이 메시지 하나, 음성이면 이 메시지 뒤에 오디오 바이너리가 따라붙는다. */
export type LangLearnAnswerMessage =
  | { type: 'answer'; idx: number; modality: 'text'; text: string }
  | { type: 'answer'; idx: number; modality: 'audio'; content_type: string; duration_s: number };

export type LangLearnClientMessage = LangLearnStartMessage | LangLearnAnswerMessage;

export interface LangLearnReadyEvent {
  type: 'ready';
  total: number;
  target_lang: string;
  level: string;
  feedback_mode: string;
}

/**
 * 문제 하나. `answer_type` 이 `repeat` 면 이 이벤트 뒤에 오디오 바이너리가 따라붙을 수
 * 있다(`audio_hint`). `text` 는 두 유형 모두에 있다 — `repeat` 에서 화면에 보여줄지는
 * 앱의 `show_text_for_repeat` 설정이 정한다(서버는 항상 보낸다).
 */
export interface LangLearnProblemEvent {
  type: 'problem';
  idx: number;
  total: number;
  answer_type: 'repeat' | 'compose';
  text: string;
  audio_hint: boolean;
}

export interface LangLearnAnswerReceivedEvent {
  type: 'answer.received';
  idx: number;
}

/** `feedback_mode` 가 immediate/both 일 때만 온다. 등급만 온다 — 점수는 서버에만 남는다. */
export interface LangLearnFeedbackEvent {
  type: 'feedback';
  idx: number;
  grade: string;
  comment: string;
}

/** `feedback_mode` 가 summary/both 일 때만, 마지막 문제 뒤에 온다. */
export interface LangLearnSessionSummaryEvent {
  type: 'session.summary';
  grade: string;
  comment: string;
}

export interface LangLearnSessionDoneEvent {
  type: 'session.done';
}

export interface LangLearnErrorEvent {
  type: 'error';
  code: string;
  message: string;
  params: Record<string, unknown>;
}

export type LangLearnEvent =
  | LangLearnReadyEvent
  | LangLearnProblemEvent
  | LangLearnAnswerReceivedEvent
  | LangLearnFeedbackEvent
  | LangLearnSessionSummaryEvent
  | LangLearnSessionDoneEvent
  | LangLearnErrorEvent;

export type LangLearnEventType = LangLearnEvent['type'];

export type LangLearnEventOf<K extends LangLearnEventType> = Extract<LangLearnEvent, { type: K }>;

/* ---- stt_training: STT 개인화 데이터 수집 -----------------------------------
 *
 * 근거: `PLAN_STT_PERSONALIZATION.md` 0단계(0-S3/0-S4/0-S5/0-S6), `DESIGN.md` §16.
 * ⚠️ 이 모듈은 아직 서버에 구현되지 않았다(2026-08-30 시점) — 아래 필드 이름은
 * 계획서 문장을 따라 정한 **추정 계약**이다. 서버가 실제로 붙으면
 * `MESSAGE_TO_SERVER.md`/`MESSAGE_TO_APP.md`로 맞춰보고 다르면 여기를 고친다.
 */

/** `/v1/config` 의 `stt_training` 섹션 — 언어 목록·목표 횟수를 하드코딩하지 않는다. */
export interface SttTrainingConfigView {
  languages: LanguageOption[];
  required_read_count: number;
  required_verify_count: number;
}

export interface SttTrainingProgress {
  done: number;
  required: number;
}

/** `GET /v1/users/{id}/stt_training/status`. */
export interface SttTrainingStatus {
  read: SttTrainingProgress;
  verify: SttTrainingProgress;
}

/** `GET /v1/users/{id}/stt_training/next_prompt` — 목표를 채웠으면 `done:true` 만 온다. */
export type SttTrainingNextPrompt =
  | { done: true }
  | { done: false; prompt_id: string; text: string; lang: string };

/**
 * `POST /v1/users/{id}/stt_training/read_sample` 요청.
 *
 * multipart 가 아니라 JSON+base64 다 — RN 의 `FormData` 는 메모리에 있는 바이너리를
 * 직접 담지 못하고 파일 `uri` 만 받는다(`src/api/stt_training.ts` 상단 주석 참고).
 * 서버의 `/v1/translate/text?with_audio=true` 응답이 이미 오디오를 base64 로 실어
 * 보내는 것과 같은 관례라 요청 쪽에도 그대로 적용했다.
 */
export interface SttTrainingReadSampleRequest {
  prompt_id: string;
  audio_base64: string;
  content_type: string;
}

/** `POST /v1/users/{id}/stt_training/read_sample` 응답 — 갱신된 낭독 진행도. */
export interface SttTrainingReadSampleResponse {
  read: SttTrainingProgress;
}

/** `POST /v1/users/{id}/stt_training/verify` 요청. 위와 같은 이유로 JSON+base64. */
export interface SttTrainingVerifyRequest {
  audio_base64: string;
  content_type: string;
}

/** `POST /v1/users/{id}/stt_training/verify` 응답 — STT 인식 결과와, 판정에 쓸 id. */
export interface SttTrainingVerifyResponse {
  sample_id: string;
  text: string;
}

/**
 * `POST /v1/users/{id}/stt_training/verify/{sample_id}/verdict` 요청.
 * `correct:false` 면 `corrected_text` 가 필수다 — 없이 보내면 서버가 400 으로 거절한다.
 */
export interface SttTrainingVerdictRequest {
  correct: boolean;
  corrected_text?: string;
}

export interface SttTrainingVerdictResponse {
  verify: SttTrainingProgress;
}
