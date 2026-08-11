/**
 * 설정 화면이 그릴 폼의 **모델**. 그리는 코드(`SettingsScreen.tsx`)와 떼어 둔 이유가 둘 있다.
 *
 *   1. **여기에 목록이 하나도 없다는 것이 눈으로 확인돼야 한다.** 언어 코드도, 프로필
 *      이름도, 모드 이름도, 엔진 이름도 이 파일에 없다 — 전부 `/v1/config` 응답에서
 *      만든다. 서버에 항목이 하나 늘면 앱을 고치지 않아도 화면에 늘어난다.
 *   2. **고른 값이 실제로 WS `config` 메시지에 실리는지를 렌더 없이 테스트할 수 있다.**
 *      화면만 있고 반영은 안 되는 것을 잡으려는 것이 이 파일의 목적 절반이다.
 *
 * 규칙은 웹 클라이언트(`web/static/app.js` 의 `renderSettings`)에서 가져왔다. DOM 코드를
 * 옮긴 것이 아니라 **같은 규칙을 RN 쪽에서 다시 쓴 것**이다. 특히 두 가지가 같다.
 *
 *   - `available: false` 는 고를 수 없게 하고 이유(`reason`/`error`)를 함께 보여준다.
 *     그 문장은 서버가 요청 로케일로 렌더한 것이라 앱이 손대지 않는다.
 *   - 고르려던 값이 고를 수 없으면 **첫 번째 고를 수 있는 값으로 물러난다.**
 *     쓸 수 없는 프로필로 세션을 열어 서버에 거절당하는 일을 만들지 않기 위해서다.
 */

import type { ServerConfig, StreamConfigMessage } from '../src/api';
import { implemented } from './inputMode';

/* ---- 사용자가 고른 것 -------------------------------------------------------- */

/**
 * 고른 값. 키는 **WS `config` 메시지의 필드 이름 그대로**다 (`source_lang`, `profile`,
 * `<kind>_engine` …). 값 목록이 아니라 필드 이름이므로 서버 설정과 무관하게 고정이고,
 * 그나마도 `<kind>_engine` 은 응답의 `engines[].kind` 에서 만들어진다.
 *
 * 비어 있는 값(`''`)은 "서버가 알아서"라는 뜻이라 메시지에 싣지 않는다 — 서버는 **없는
 * 키에만** 자기 기본값을 쓰기 때문이다 (`streaming.py` 의 `_options`).
 */
export type Settings = Record<string, string>;

/* ---- 폼 모델 ---------------------------------------------------------------- */

export interface SettingOption {
  value: string;
  label: string;
  /** false 면 고를 수 없다. 이유는 `note` 에 있다. */
  usable: boolean;
  /** 곁들일 한 줄 — 못 고르는 이유(서버 문장)이거나 설명이다. */
  note: string;
}

export interface SettingField {
  /** WS `config` 메시지의 필드 이름과 같다. `transient` 면 나가지 않으므로 예외다. */
  name: string;
  label: string;
  /** 'choice' 는 목록에서 고르고, 'text' 는 직접 적는다. */
  kind: 'choice' | 'text';
  options: SettingOption[];
  /** 지금 쓰이는 값. 고를 수 없는 값을 들고 있으면 첫 번째 고를 수 있는 값으로 물러난 뒤다. */
  value: string;
  /** true 면 화면 전용 — 서버로 나가지 않는다 (입력 방식). */
  transient: boolean;
  /** 비워 뒀을 때 무엇이 쓰이는지 ('text' 전용). */
  placeholder: string;
}

/** "서버가 알아서" 를 뜻하는 값. 이 값이면 메시지에 키를 넣지 않는다. */
const AUTO = '';

function option(value: string, label: string, usable = true, note = ''): SettingOption {
  return { value, label, usable, note };
}

/** 첫 렌더에서는 서버 기본값을, 이후에는 사용자가 고른 값을 쓴다 (웹의 `current()`). */
function chosen(form: Settings, name: string, fallback: string): string {
  const value = form[name];
  return value === undefined ? fallback : value;
}

/** 고를 수 없는 값을 들고 있으면 첫 번째 고를 수 있는 값으로 (웹의 `addSelect` 와 같다). */
function settle(options: SettingOption[], wanted: string): string {
  const usable = options.filter(o => o.usable);
  if (usable.some(o => o.value === wanted)) return wanted;
  const first = usable[0];
  return first ? first.value : '';
}

/**
 * `/v1/config` 응답과 지금까지 고른 값으로 폼 전체를 만든다.
 *
 * 순서는 위에서부터 통역에 직접 영향이 큰 것 순이다. **한 항목도 조건 없이 그리지 않는다** —
 * 응답에 없거나(프로바이더가 없는 서버), 서버가 막아둔 것(`allow_*_override: false`)은
 * 아예 나타나지 않는다.
 */
export function buildFields(config: ServerConfig, form: Settings): SettingField[] {
  const fields: SettingField[] = [];

  const choice = (
    name: string,
    label: string,
    options: SettingOption[],
    fallback: string,
    transient = false,
  ) => {
    if (options.length === 0) return;
    fields.push({
      name,
      label,
      kind: 'choice',
      options,
      value: settle(options, chosen(form, name, fallback)),
      transient,
      placeholder: '',
    });
  };

  // ── 번역 언어 ──────────────────────────────────────────────
  // `label` 은 서버가 요청 로케일로 이미 렌더해 보낸 표시 이름이다. 값으로는 `code` 를 쓴다.
  const languages = (config.languages || []).map(l => option(l.code, l.label || l.code));
  choice('source_lang', '사용어 — 내가 말하는 언어', languages, config.session.default_source_lang);
  choice('target_lang', '목표어 — 번역해 들려줄 언어', languages, config.session.default_target_lang);

  // ── 세션 프로필 ────────────────────────────────────────────
  // 서버가 바꾸지 못하게 해두면(`allow_profile_override: false`) 항목 자체를 만들지 않는다.
  if (config.session.allow_profile_override !== false) {
    choice(
      'profile',
      '세션 프로필',
      (config.profiles || []).map(p =>
        option(
          p.id,
          p.label || p.id,
          p.available,
          // 못 고르는 이유가 있으면 그것이 먼저다. 서버가 렌더한 문장을 그대로 쓴다.
          p.available ? p.description || '' : p.reason || p.description || '',
        ),
      ),
      config.session.default_profile,
    );
  }

  // ── 모드 ──────────────────────────────────────────────────
  // 목록을 코드에 두지 않는다. 엔진들이 지원한다고 신고한 것(`engines[].modes`)의 합집합이다.
  if (config.session.allow_mode_override !== false) {
    const modes = Array.from(new Set((config.engines || []).flatMap(e => e.modes || []))).sort();
    choice('mode', '모드', modes.map(m => option(m, m)), config.session.default_mode);
  }

  // 엔진을 거를 때 쓸 모드. 위에서 만들어졌으면 그 값이고, 막혀 있으면 서버 기본값이다.
  const modeField = fields.find(f => f.name === 'mode');
  const mode = modeField ? modeField.value : config.session.default_mode;

  // ── 입력 방식 ──────────────────────────────────────────────
  // 화면 전용이다. 서버는 이런 키를 읽지 않는다 (웹에서도 transient 로 둔다).
  // **실시간 화면이 이 값을 따른다** — 누르고 말하기면 버튼을 누르는 동안만 캡처한다.
  //
  // 목록·순서·기본값은 서버가 주지만, 앱에 구현이 없는 이름은 걸러낸다. 고를 수는 있는데
  // 고르면 아무 일도 안 하는 항목을 만들지 않기 위해서다 (웹의 `renderInputModes` 가
  // `name in inputModes` 로 거르는 것과 같은 규칙이다). 구현 목록은 `ui/inputMode.ts` 에 있다.
  const client = config.client;
  if (client) {
    choice(
      'input_mode',
      '입력 방식',
      (client.input_modes || []).filter(implemented).map(m => option(m, m)),
      client.default_input_mode,
      true,
    );
  }

  // ── 엔진 (종류별로 하나씩) ──────────────────────────────────
  // "stt"/"tts" 를 이 코드가 알지 못한다. 응답에 실제로 있는 `kind` 를 훑는다.
  const kinds = Array.from(new Set((config.engines || []).map(e => e.kind))).sort();
  for (const kind of kinds) {
    const options = [option(AUTO, '자동', true, '서버의 라우팅 정책이 고른다')];
    for (const engine of config.engines) {
      if (engine.kind !== kind) continue;
      const modes = engine.modes || [];
      const blocked = !engine.available
        ? '사용 불가'
        : !engine.ready
        ? '준비 안 됨'
        : !modes.includes(mode)
        ? `${mode} 모드에서 못 쓴다 (${modes.join(', ')})`
        : '';
      const detail = engine.error || (engine.languages || []).join(' ');
      options.push(
        option(
          engine.id,
          engine.model ? `${engine.id} · ${engine.model}` : engine.id,
          blocked === '',
          blocked === '' ? detail : detail ? `${blocked} — ${detail}` : blocked,
        ),
      );
    }
    // 이름이 API 파라미터와 그대로 맞는다 (`stt_engine`, `tts_engine`, …).
    choice(`${kind}_engine`, `${kind} 엔진`, options, AUTO);
  }

  // ── LLM ───────────────────────────────────────────────────
  // 응답에 있는 것만 노출한다. 프로바이더가 없는 서버면 이 두 항목이 아예 없다.
  const providers = config.llm ? config.llm.providers || [] : [];
  if (providers.length > 0) {
    choice(
      'provider',
      'LLM 프로바이더',
      providers.map(p =>
        option(p.id, p.label || p.id, p.available, p.available ? p.default_model || '' : p.reason || ''),
      ),
      config.llm.default_provider,
    );

    // 모델 **목록**은 응답에 없다 — 프로바이더가 알려주는 것은 `default_model` 하나뿐이다.
    // 그래서 자유 입력으로 두고, 비워 뒀을 때 무엇이 쓰이는지만 자리표시로 보여준다.
    const providerField = fields.find(f => f.name === 'provider');
    const picked = providers.find(p => p.id === (providerField ? providerField.value : ''));
    const fallbackModel = picked ? picked.default_model : null;
    fields.push({
      name: 'model',
      label: 'LLM 모델',
      kind: 'text',
      options: [],
      value: chosen(form, 'model', ''),
      transient: false,
      placeholder: fallbackModel ? `비워 두면 ${fallbackModel}` : '비워 두면 서버가 정한다',
    });
  }

  return fields;
}

/* ---- 고른 값을 실제로 쓴다 --------------------------------------------------- */

/**
 * 서버로 나갈 값만 추린 것. 비어 있는 값은 빠진다 — 서버는 **없는 키에만** 자기 기본값을
 * 쓰므로, 빈 문자열을 보내면 기본값 대신 빈 값이 적용되는 자리가 생긴다.
 */
export function resolvedSettings(config: ServerConfig, form: Settings): Settings {
  const values: Settings = {};
  for (const field of buildFields(config, form)) {
    if (field.transient) continue;
    const value = field.value.trim();
    if (value !== '') values[field.name] = value;
  }
  return values;
}

/**
 * 지금 고른 입력 방식. 서버로 나가지 않는 값이라 `resolvedSettings()` 에는 없다.
 *
 * 고를 수 없는 값으로 물러나는 규칙(`settle`)을 그대로 타므로, 서버가 목록을 바꿔 고른
 * 값이 더는 없으면 첫 번째로 고를 수 있는 값이 나온다. 항목 자체가 없으면(응답에 `client`
 * 절이 없거나 앱에 구현이 하나도 없으면) 빈 문자열이고, 그때는 연속 캡처가 유지된다.
 */
export function chosenInputMode(config: ServerConfig, form: Settings): string {
  const field = buildFields(config, form).find(f => f.name === 'input_mode');
  return field ? field.value : '';
}

/** 지금 고른 번역 언어. 아직 고른 것이 없으면 서버의 세션 기본값이다. */
export function chosenLanguages(
  config: ServerConfig,
  form: Settings,
): { source: string; target: string } {
  const values = resolvedSettings(config, form);
  return {
    source: values.source_lang || config.session.default_source_lang,
    target: values.target_lang || config.session.default_target_lang,
  };
}

/**
 * 세션을 열 때 보낼 WS `config` 메시지. **설정 화면이 실제로 쓰이는 지점이 여기다.**
 *
 * 언어·샘플레이트를 뺀 나머지는 이름 그대로 얹는다. 키를 열거하지 않는 이유는 엔진 종류가
 * 서버 설정에서 오기 때문이다 — `<kind>_engine` 이라는 이름을 컴파일 시점에 알 수 없다.
 * 서버는 자기가 아는 키만 읽고 나머지는 조용히 무시한다(`streaming.py` 의 `_options`).
 * 그래서 캐스팅이 한 번 필요하다.
 */
export function streamConfig(
  config: ServerConfig,
  form: Settings,
  locale: string,
): StreamConfigMessage {
  const values = resolvedSettings(config, form);

  const message: StreamConfigMessage = {
    type: 'config',
    source_lang: values.source_lang || config.session.default_source_lang,
    target_lang: values.target_lang || config.session.default_target_lang,
    // 마이크 규격은 고르는 것이 아니다. 서버가 정한 값을 그대로 되돌려 선언한다.
    sample_rate: config.audio.stt_sample_rate,
  };
  if (locale) message.locale = locale;

  const extra = message as unknown as Record<string, unknown>;
  for (const name of Object.keys(values)) {
    if (name === 'source_lang' || name === 'target_lang') continue;
    extra[name] = values[name];
  }
  return message;
}
