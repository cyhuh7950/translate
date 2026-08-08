'use strict';
/*
 * PTT 웹 클라이언트.
 *
 * 이 파일에 목록이 없다. 언어·프로필·엔진·프로바이더·스타일·보이스·모드는 전부
 * GET /v1/config 응답으로 그리고, 기본값도 그 응답에서 온다. 문구는 locales/*.json 이다.
 * 그래서 서버 설정을 고치면 이 파일을 열지 않아도 화면이 따라 바뀐다.
 *
 * 오케스트레이터 주소와 API 키도 여기 없다. 같은 오리진의 /v1/ 로 보내면
 * nginx 가 오케스트레이터로 넘기면서 인증 헤더를 붙인다.
 */

/* ------------------------------------------------------------------ 도구 */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
};

const state = {
  locale: null,
  localeIndex: null,
  dict: {},
  fallbackDict: {},
  config: null,
  form: {},          // 사용자가 고른 값. 키는 API 파라미터 이름과 같다.
  inputMode: null,   // 지금 활성화된 입력 방식. 목록·기본값은 /v1/config 가 준다.
  stream: null,
  recorder: null,
  recording: false,
  busy: false,
  timer: null,
};

/* ------------------------------------------------------------------ 문구 */

/** 문구 조회. 없으면 기본어(en)로, 그것도 없으면 키를 그대로 보여준다. */
function t(key, vars) {
  let s = state.dict[key];
  if (s === undefined) s = state.fallbackDict[key];
  if (s === undefined) return key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/**
 * 카탈로그에 없으면 서버가 준 이름을 그대로 쓴다.
 *
 * 스타일·모드·엔진 종류처럼 "서버가 이름을 정하는 것"에 쓴다. 번역이 없다고
 * 항목이 사라지면 안 되기 때문이다 — 새 스타일을 설정에 추가하면 번역이 없어도 뜬다.
 */
function nameOf(key, raw) {
  const s = state.dict[key] !== undefined ? state.dict[key] : state.fallbackDict[key];
  return s === undefined ? raw : s;
}

function applyStaticText() {
  document.documentElement.lang = state.locale;
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of document.querySelectorAll('[data-i18n-title]')) {
    node.title = t(node.dataset.i18nTitle);
  }
  document.title = t('app.title');
}

async function getJSON(url, options) {
  const res = await fetch(url, options);
  let body = null;
  try {
    body = await res.json();
  } catch (_) { /* 본문이 JSON 이 아닐 수 있다 */ }
  if (!res.ok) {
    const detail = (body && (body.detail || body.message)) || `HTTP ${res.status}`;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return body;
}

/* ------------------------------------------------------------- 로케일 결정 */

function storedLocale() {
  try { return localStorage.getItem('locale'); } catch (_) { return null; }
}

function rememberLocale(code) {
  try { localStorage.setItem('locale', code); } catch (_) { /* 사생활 모드 등 */ }
}

/** ?locale= > 사용자가 고른 값 > navigator.language > 카탈로그의 fallback */
function resolveLocale(index) {
  const known = index.locales.map((l) => l.code);
  const short = (v) => (v || '').replace('_', '-').split('-')[0].toLowerCase();
  const candidates = [
    new URLSearchParams(location.search).get('locale'),
    storedLocale(),
    navigator.language,
    ...(navigator.languages || []),
  ];
  for (const c of candidates) {
    const code = short(c);
    if (code && known.includes(code)) return code;
  }
  return index.fallback;
}

async function loadLocale(code) {
  const index = state.localeIndex;
  state.locale = code;
  state.fallbackDict = await getJSON(`locales/${index.fallback}.json`);
  state.dict = code === index.fallback ? state.fallbackDict : await getJSON(`locales/${code}.json`);
  applyStaticText();
}

function renderLocaleSwitcher() {
  const sel = $('#locale-select');
  sel.replaceChildren();
  for (const l of state.localeIndex.locales) {
    const opt = el('option');
    opt.value = l.code;
    opt.textContent = l.label;
    sel.appendChild(opt);
  }
  sel.value = state.locale;
  sel.addEventListener('change', async () => {
    const code = sel.value;
    rememberLocale(code);
    // URL 을 갱신해 두면 이 화면을 그대로 공유·새로고침할 수 있다.
    const url = new URL(location.href);
    url.searchParams.set('locale', code);
    history.replaceState(null, '', url);
    await loadLocale(code);
    // 서버가 주는 label(프로필·언어)도 로케일을 타므로 설정을 다시 받는다.
    await loadConfig();
  });
}

/* --------------------------------------------------------------- 설정 화면 */

async function loadConfig() {
  setStatus(t('status.loading'));
  state.config = await getJSON(`/v1/config?locale=${encodeURIComponent(state.locale)}`);
  const c = state.config;
  $('#server-info').textContent = t('server.info', {
    id: c.server_id,
    locale: c.locale || state.locale,
  });
  // 준비됨을 먼저 찍고 화면을 그린다 — 설정에 문제가 있으면 그 메시지가 남게.
  setStatus(t('status.ready'));
  renderSettings();
  renderInputModes();
  renderSpeakers();
}

function addSelect(parent, spec) {
  const wrap = el('label', 'field');
  const caption = el('span', 'field-label');
  caption.textContent = spec.label;
  const sel = el('select');
  sel.name = spec.name;

  for (const o of spec.options) {
    const opt = el('option');
    opt.value = o.value;
    opt.textContent = o.badge ? `${o.label} — ${o.badge}` : o.label;
    if (o.disabled) opt.disabled = true;
    if (o.title) opt.title = o.title;
    sel.appendChild(opt);
  }

  const wanted = spec.value;
  const usable = [...sel.options].filter((o) => !o.disabled);
  const match = usable.find((o) => o.value === wanted);
  sel.value = match ? wanted : (usable[0] ? usable[0].value : '');
  if (!usable.length) sel.disabled = true;

  // transient 는 서버로 나가지 않는 화면 전용 선택이다(입력 방식 등).
  if (!spec.transient) state.form[spec.name] = sel.value;
  sel.addEventListener('change', () => {
    if (!spec.transient) state.form[spec.name] = sel.value;
    if (spec.onChange) spec.onChange(sel.value);
    if (spec.rerender) renderSettings();
    if (!spec.transient) settingsChanged();
  });

  wrap.append(caption, sel);
  if (spec.hint) {
    const hint = el('span', 'field-hint');
    hint.textContent = spec.hint;
    wrap.appendChild(hint);
  }
  parent.appendChild(wrap);
}

function addCheckbox(parent, spec) {
  const wrap = el('label', 'field field-check');
  const box = el('input');
  box.type = 'checkbox';
  box.name = spec.name;
  box.checked = spec.value;
  state.form[spec.name] = box.checked;
  box.addEventListener('change', () => {
    state.form[spec.name] = box.checked;
    settingsChanged();
  });
  const caption = el('span', 'field-label');
  caption.textContent = spec.label;
  wrap.append(box, caption);
  parent.appendChild(wrap);
}

function addText(parent, spec) {
  const wrap = el('label', 'field');
  const caption = el('span', 'field-label');
  caption.textContent = spec.label;
  const input = el('input');
  input.type = 'text';
  input.name = spec.name;
  input.value = spec.value || '';
  if (spec.placeholder) input.placeholder = spec.placeholder;
  // 자유 입력은 서버로 나가는 설정이 아니다. 값은 부르는 쪽이 받아 둔다.
  input.addEventListener('input', () => { if (spec.onChange) spec.onChange(input.value); });
  wrap.append(caption, input);
  if (spec.hint) {
    const hint = el('span', 'field-hint');
    hint.textContent = spec.hint;
    wrap.appendChild(hint);
  }
  parent.appendChild(wrap);
  return input;
}

/** 첫 렌더에서는 서버 기본값을, 이후에는 사용자가 고른 값을 유지한다. */
function current(name, serverDefault) {
  return state.form[name] !== undefined ? state.form[name] : serverDefault;
}

function renderSettings() {
  const cfg = state.config;
  const box = $('#settings-fields');
  box.replaceChildren();

  // ── 번역 언어 ─────────────────────────────────────────────
  const languages = (cfg.languages || []).map((l) => ({ value: l.code, label: l.label || l.code }));
  if (!languages.length) setStatus(t('error.no_language'), 'error');

  addSelect(box, {
    name: 'source_lang',
    label: t('field.source_lang'),
    options: languages,
    value: current('source_lang', cfg.session.default_source_lang),
  });
  addSelect(box, {
    name: 'target_lang',
    label: t('field.target_lang'),
    options: languages,
    value: current('target_lang', cfg.session.default_target_lang),
  });

  // ── 세션 프로필 (단방향/양방향) ────────────────────────────
  // available:false 는 비활성화하고 이유를 툴팁으로 보여준다.
  if (cfg.session.allow_profile_override !== false) {
    const profiles = (cfg.profiles || []).map((p) => ({
      value: p.id,
      label: p.label || p.id,
      disabled: !p.available,
      badge: p.available ? '' : t('badge.unavailable'),
      title: p.reason || p.description || '',
    }));
    if (profiles.length) {
      addSelect(box, {
        name: 'profile',
        label: t('field.profile'),
        options: profiles,
        value: current('profile', cfg.session.default_profile),
      });
    }
    if (profiles.length && profiles.every((p) => p.disabled)) {
      setStatus(t('error.no_profile'), 'error');
    }
  }

  // ── 모드 ─────────────────────────────────────────────────
  // 모드 목록도 하드코딩하지 않는다. 엔진들이 지원한다고 신고한 것의 합집합이다.
  if (cfg.session.allow_mode_override !== false) {
    const modes = [...new Set((cfg.engines || []).flatMap((e) => e.modes || []))].sort();
    if (modes.length) {
      addSelect(box, {
        name: 'mode',
        label: t('field.mode'),
        options: modes.map((m) => ({ value: m, label: nameOf(`mode.${m}`, m) })),
        value: current('mode', cfg.session.default_mode),
        rerender: true,   // 모드가 바뀌면 쓸 수 있는 엔진이 달라진다
      });
    }
  }

  // ── 엔진 (종류별로 하나씩) ─────────────────────────────────
  // "stt/tts" 를 코드가 알지 못한다. 응답에 있는 kind 를 그대로 훑는다.
  const kinds = [...new Set((cfg.engines || []).map((e) => e.kind))].sort();
  const mode = state.form.mode || cfg.session.default_mode;
  for (const kind of kinds) {
    const engines = cfg.engines.filter((e) => e.kind === kind);
    const options = [
      { value: '', label: t('option.auto'), title: t('option.auto.hint') },
      ...engines.map((e) => {
        const unusable = !e.available ? t('badge.unavailable')
          : !e.ready ? t('badge.not_ready')
          : !(e.modes || []).includes(mode) ? (e.modes || []).join(', ')
          : '';
        return {
          value: e.id,
          label: e.model ? `${e.id} · ${e.model}` : e.id,
          disabled: Boolean(unusable),
          badge: unusable,
          title: e.error || (e.languages || []).join(' '),
        };
      }),
    ];
    addSelect(box, {
      name: `${kind}_engine`,     // API 파라미터 이름과 그대로 맞는다
      label: t('field.engine', { kind: nameOf(`kind.${kind}`, kind) }),
      options,
      value: current(`${kind}_engine`, ''),
      rerender: true,             // 엔진이 바뀌면 보이스 목록이 달라진다
    });
  }

  // ── 보이스 ───────────────────────────────────────────────
  // 목록은 엔진이 /info 로 신고한 것이다. 여기에 "F1, M2" 같은 값이 없다.
  const voiceCandidates = cfg.engines.filter((e) => {
    if (!(e.voices || []).length || !e.ready) return false;
    const chosen = state.form[`${e.kind}_engine`];
    return chosen ? chosen === e.id : true;
  });
  const voices = [...new Set(voiceCandidates.flatMap((e) => e.voices))];
  if (voices.length) {
    addSelect(box, {
      name: 'voice',
      label: t('field.voice'),
      options: [
        // 기본 보이스가 무엇인지도 엔진이 정한다. 비워 보내면 엔진 기본값이 쓰인다.
        { value: '', label: t('option.engine_default') },
        ...voices.map((v) => ({ value: v, label: v })),
      ],
      value: current('voice', ''),
    });
  } else {
    delete state.form.voice;
  }

  // ── LLM ──────────────────────────────────────────────────
  const providers = (cfg.llm.providers || []).map((p) => ({
    value: p.id,
    label: p.label || p.id,
    disabled: !p.available,
    badge: p.available ? (p.fast ? '⚡' : '') : t('badge.unavailable'),
    title: p.reason || p.default_model || '',
  }));
  if (providers.length) {
    addSelect(box, {
      name: 'provider',
      label: t('field.provider'),
      options: providers,
      value: current('provider', cfg.llm.default_provider),
    });
  }

  const styles = cfg.llm.styles || [];
  if (styles.length) {
    addSelect(box, {
      name: 'style',
      label: t('field.style'),
      options: styles.map((s) => ({ value: s, label: nameOf(`style.${s}`, s) })),
      value: current('style', cfg.llm.style),
    });
  }

  addCheckbox(box, {
    name: 'with_audio',
    label: t('field.with_audio'),
    value: current('with_audio', true),
  });
}

/* ------------------------------------------------------ 입력 방식 레지스트리 */

/*
 * 입력 방식은 오케스트레이터의 어댑터 레지스트리와 같은 방식으로 둔다.
 * 여기에는 **구현만** 있고 목록·순서·기본값은 /v1/config 의 client.input_modes 가 정한다.
 * 새 방식을 붙이는 일은 defineInputMode() 한 번 + 설정에 이름 추가로 끝나야 하고,
 * 선택 UI 를 그리는 코드는 열지 않는다.
 *
 * 이름 상수(PTT_MODE 등)는 "이 구현의 이름"이지 목록이 아니다.
 * 설정에서 이름을 빼면 그 방식은 화면에서 사라지고, 클라이언트가 모르는 이름은 무시된다.
 */

const inputModes = {};

function defineInputMode(name, impl) {
  inputModes[name] = impl;
}

function activeInput() {
  return inputModes[state.inputMode] || null;
}

/** 설정이 바뀌었다고 활성 입력 방식에 알린다 (핸즈프리는 세션을 다시 연다). */
function settingsChanged() {
  const impl = activeInput();
  if (impl && impl.settingsChanged) impl.settingsChanged();
  speakerSettingsChanged();
}

function showInputPanels(name) {
  for (const node of document.querySelectorAll('[data-input-mode]')) {
    node.hidden = node.dataset.inputMode !== name;
  }
}

function selectInputMode(name) {
  if (state.inputMode === name) {
    showInputPanels(name);
    const same = activeInput();
    if (same && same.refresh) same.refresh();
    return;
  }
  const previous = activeInput();
  if (previous && previous.exit) previous.exit();
  state.inputMode = name;
  showInputPanels(name);
  const impl = activeInput();
  if (impl && impl.enter) impl.enter();
}

function renderInputModes() {
  const client = state.config.client || {};
  const box = $('#input-mode');
  box.replaceChildren();

  // 서버가 준 목록 중 구현이 있는 것만. 순서는 서버가 준 그대로다.
  const names = (client.input_modes || []).filter((name) => name in inputModes);
  if (!names.length) {
    setStatus(t('error.no_input_mode'), 'error');
    return;
  }
  const fallback = names.includes(client.default_input_mode) ? client.default_input_mode : names[0];
  const wanted = names.includes(state.inputMode) ? state.inputMode : fallback;

  addSelect(box, {
    name: 'input_mode',
    transient: true,               // 서버로 나가는 값이 아니다
    label: t('field.input_mode'),
    options: names.map((name) => ({
      value: name,
      label: nameOf(`input_mode.${name}`, name),
      title: nameOf(`input_mode.${name}.hint`, ''),
    })),
    value: wanted,
    onChange: selectInputMode,
  });
  selectInputMode(wanted);
}

/* ----------------------------------------------------------------- 상태줄 */

function setStatus(text, kind) {
  const node = $('#status');
  node.textContent = text;
  node.className = kind ? `status ${kind}` : 'status';
}

/* --------------------------------------------------- 입력 방식 ① 누르고 말하기 */

const PTT_MODE = 'ptt';

function recorderSupported() {
  return typeof MediaRecorder !== 'undefined'
    && Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

async function micStream() {
  if (state.stream && state.stream.active) return state.stream;
  // 스피커 소리가 마이크로 되돌아오는 것을 브라우저 단에서 한 번 막는다.
  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  return state.stream;
}

/** MediaRecorder 가 고른 컨테이너에서 확장자를 뽑는다. 포맷 목록을 코드에 두지 않기 위해. */
function extensionOf(mimeType) {
  const sub = String(mimeType || '').split(';')[0].split('/')[1] || 'bin';
  return sub.replace(/^x-/, '');
}

/** 마이크를 놓아준다. 브라우저의 "녹음 중" 표시가 남지 않게 트랙까지 멈춘다. */
function releaseMic() {
  if (!state.stream) return;
  for (const track of state.stream.getTracks()) {
    try { track.stop(); } catch (_) { /* 이미 멈춘 경우 */ }
  }
  state.stream = null;
}

async function startRecording() {
  if (state.inputMode !== PTT_MODE) return;   // 다른 입력 방식일 때 스페이스바가 끼어들지 않게
  if (state.recording || state.busy) return;
  try {
    const stream = await micStream();
    const chunks = [];
    const recorder = new MediaRecorder(stream);
    recorder.addEventListener('dataavailable', (e) => { if (e.data.size) chunks.push(e.data); });
    recorder.addEventListener('stop', () => {
      const blob = new Blob(chunks, { type: recorder.mimeType });
      if (blob.size) translate(blob, `ptt.${extensionOf(recorder.mimeType)}`);
    });
    recorder.start();
    state.recorder = recorder;
    state.recording = true;
    $('#ptt').classList.add('is-recording');
    $('.ptt-label').textContent = t('ptt.recording');
    setStatus(t('status.recording'), 'busy');
  } catch (err) {
    setStatus(t('error.mic', { message: err.message }), 'error');
  }
}

function stopRecording() {
  if (!state.recording) return;
  state.recording = false;
  $('#ptt').classList.remove('is-recording');
  $('.ptt-label').textContent = t('ptt.hold');
  try { state.recorder.stop(); } catch (_) { /* 이미 멈춘 경우 */ }
}

defineInputMode(PTT_MODE, {
  enter() {
    $('#ptt').disabled = !recorderSupported();
    if (!recorderSupported()) {
      setStatus(t(window.isSecureContext === false ? 'error.insecure' : 'error.no_recorder'), 'error');
    }
  },
  exit() {
    stopRecording();
    releaseMicIfIdle();     // 화자 등록이 녹음 중이면 마이크를 빼앗지 않는다
  },
  refresh() {
    $('.ptt-label').textContent = t(state.recording ? 'ptt.recording' : 'ptt.hold');
  },
});

/* ------------------------------------------------------------------ 전송 */

async function translate(blob, filename) {
  if (state.busy) return;
  state.busy = true;
  $('#ptt').disabled = true;

  const form = new FormData();
  form.append('file', blob, filename);
  // 빈 값은 아예 보내지 않는다. 그래야 서버가 자기 기본값을 쓴다.
  const put = (k, v) => { if (v !== undefined && v !== null && v !== '') form.append(k, String(v)); };
  for (const [key, value] of Object.entries(state.form)) {
    if (key === 'with_audio') continue;
    put(key, value);
  }
  form.append('with_audio', state.form.with_audio ? 'true' : 'false');

  const started = Date.now();
  state.timer = setInterval(() => {
    setStatus(t('status.sending', { seconds: Math.round((Date.now() - started) / 1000) }), 'busy');
  }, 250);

  try {
    const result = await getJSON('/v1/translate/audio', { method: 'POST', body: form });
    renderTurn(result);
    if (result.source_text) {
      setStatus(t('status.done', { ms: result.metrics ? result.metrics.total_ms : '?' }));
    } else {
      setStatus(t('status.empty'), 'error');
    }
  } catch (err) {
    setStatus(t('error.request', { message: err.message }), 'error');
  } finally {
    clearInterval(state.timer);
    state.busy = false;
    $('#ptt').disabled = !recorderSupported();
  }
}

/* ------------------------------------------------------------------ 결과 */

function base64ToBlob(b64, type) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: type || 'application/octet-stream' });
}

/**
 * 지연 표시. 키를 나열하지 않고 응답에 있는 것을 그대로 훑는다.
 * `llm_ms.speaker` 처럼 참여자별로 붙는 키가 있어서 앞부분만 문구로 바꾼다.
 */
function formatMetrics(metrics) {
  return Object.entries(metrics || {})
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([key, value]) => {
      const [base, sub] = key.split('.');
      const unit = base.endsWith('_ms') ? ' ms' : base.endsWith('_s') ? ' s' : '';
      const name = nameOf(`metric.${base}`, base);
      return `${name}${sub ? ` (${sub})` : ''} ${value}${unit}`;
    })
    .join(' · ');
}

function renderTurn(data) {
  const node = $('#turn-template').content.cloneNode(true);
  const turn = node.querySelector('.turn');
  const deliveries = data.deliveries || [];

  // from/to 는 응답에 항상 들어 있다 — 양방향으로 확장돼도 화면이 그대로 쓰인다.
  turn.querySelector('.route').textContent = t('result.route', {
    from: `${data.from} · ${data.source_lang}`,
    to: deliveries.map((d) => `${d.to} · ${d.lang}`).join(', ') || '—',
  });
  turn.querySelector('.clock').textContent = new Date().toLocaleTimeString(state.locale);
  turn.querySelector('.source .text').textContent = data.source_text || '—';

  // 화자 식별이 이 발화를 처리하지 않기로 했으면 그 사실이 먼저 보여야 한다.
  // 사유 코드는 metrics.skipped 에 실려 온다 (WS 는 speaker.rejected 로 같은 것을 준다).
  const skipped = (data.metrics || {}).skipped;
  if (skipped) {
    const note = turn.querySelector('.skipped');
    note.textContent = skippedText(skipped, data.metrics);
    note.hidden = false;
    turn.classList.add('is-skipped');
  }

  const box = turn.querySelector('.deliveries');
  let first = true;
  for (const d of deliveries) {
    const item = $('#delivery-template').content.cloneNode(true);
    const label = item.querySelector('.line-label');
    label.textContent = `${t('result.translation')} → ${d.to}`;
    item.querySelector('.text').textContent = d.text || '—';
    const player = item.querySelector('.player');
    if (d.audio_base64) {
      player.src = URL.createObjectURL(base64ToBlob(d.audio_base64, d.content_type));
    } else {
      player.remove();
    }
    box.appendChild(item);
    // 붙인 다음에 재생한다. PTT 를 뗀 직후라 사용자 제스처로 인정돼 자동재생이 통과한다.
    if (first && d.audio_base64) {
      player.play().catch(() => { /* 막히면 사용자가 재생 버튼을 누르면 된다 */ });
    }
    first = false;
  }

  const engines = Object.entries(data.engines || {}).map(([k, v]) => `${k}=${v}`).join(' · ');
  turn.querySelector('.engines').textContent = engines ? `${t('result.engines')}: ${engines}` : '';
  turn.querySelector('.metrics').textContent = formatMetrics(data.metrics);

  const list = $('#history');
  list.prepend(node);
  $('#history-empty').hidden = true;
}

/* -------------------------------------------------- 입력 방식 ② 핸즈프리(WS) */

/*
 * 마이크를 계속 흘려보내고 **서버 VAD** 가 발화를 끊는다.
 *
 * PTT 는 버튼을 누르고 있는 동안 전부 녹음돼서 무음까지 인식에 들어갔다
 * (실측 10.74초 녹음에 실제 발화 2초). 말이 끝나는 순간 서버가 끊으면
 * STT 에 들어가는 오디오가 그만큼 줄고, 줄어든 만큼 그대로 시간이 준다.
 *
 * 프로토콜은 orchestrator/app/streaming.py 가 정답이다.
 *
 *   보낸다  {"type":"config", ...}  → 바이너리 PCM16 프레임 → {"type":"control", ...}
 *   받는다  ready / vad / stt.partial / stt.final / llm.delta / llm.final /
 *           tts.chunk(+바이너리) / tts.done / tts.stop / cancelled / metrics / error
 *
 * stt.partial 과 llm.delta 는 스트리밍 엔진이 없어 지금 서버가 보내지 않는다.
 * 핸들러는 미리 있다 — 2단계에서 서버가 채우면 이 파일을 고치지 않아도 화면에 흐른다.
 */

const HANDSFREE_MODE = 'handsfree';

// 워크릿 파일과 그 안에서 등록한 프로세서 이름. registerProcessor 가 정적 문자열만
// 받으므로 capture-worklet.js 의 PROCESSOR_NAME 과 같은 값이어야 한다.
const CAPTURE_WORKLET_URL = 'capture-worklet.js';
const CAPTURE_PROCESSOR = 'capture-processor';

// 레벨 미터의 표시 범위(dBFS). 화면 표현일 뿐이라 프로토콜과도 설정과도 무관하다.
const LEVEL_FLOOR_DB = 60;

const hf = {
  ws: null,
  ctx: null,          // 캡처용 AudioContext (stt_sample_rate)
  node: null,         // AudioWorkletNode
  source: null,
  sink: null,         // 무음 게인 — 워크릿이 돌려면 그래프가 목적지에 닿아야 한다
  play: null,         // 재생용 AudioContext (TTS 샘플레이트는 여기서 리샘플된다)
  playAt: 0,          // 다음 청크를 붙일 시각
  playChain: Promise.resolve(),
  sources: [],
  playing: false,
  pendingChunk: null, // tts.chunk 메타. 바로 다음 바이너리 프레임이 이 청크의 오디오다
  running: false,
  ready: false,
  turns: new Map(),   // seg → 화면 항목
  levelPending: false,
};

function handsfreeSupported() {
  return typeof AudioWorkletNode !== 'undefined'
    && typeof WebSocket !== 'undefined'
    && Boolean(window.AudioContext || window.webkitAudioContext)
    && Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

/** 표시 상태. 문구는 handsfree.state.<이름> 으로 카탈로그에서 온다. */
function hfState(name) {
  const box = $('#hf-state');
  if (!box) return;
  box.dataset.state = name;
  box.querySelector('.hf-state-text').textContent = t(`handsfree.state.${name}`);
}

function hfButton() {
  const button = $('#hf-toggle');
  button.querySelector('.hf-label').textContent = t(hf.running ? 'handsfree.stop' : 'handsfree.start');
  button.classList.toggle('is-recording', hf.running);
  button.disabled = !handsfreeSupported();
}

function audioContextAt(rate) {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  try {
    return rate ? new Ctor({ sampleRate: rate }) : new Ctor();
  } catch (_) {
    // 샘플레이트 지정을 받지 않는 브라우저. 워크릿이 리샘플해서 맞춘다.
    return new Ctor();
  }
}

/** 페이지가 https 면 wss:, http 면 ws:. 경로는 /v1/config 의 stream.path 다. */
function streamUrl(path) {
  const url = new URL(path, location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/**
 * 첫 메시지. 필드 이름은 streaming.py 의 _configure() 가 읽는 것과 같다.
 * state.form 의 키가 이미 API 파라미터 이름이라 그대로 실린다(PTT 의 FormData 와 같은 규칙).
 */
function hfConfigMessage(sampleRate) {
  const msg = { type: 'config', sample_rate: sampleRate };
  for (const [key, value] of Object.entries(state.form)) {
    if (key === 'with_audio') continue;
    if (value === undefined || value === null || value === '') continue;  // 빈 값은 서버 기본값
    msg[key] = value;
  }
  msg.with_audio = Boolean(state.form.with_audio);
  return msg;
}

function hfSend(payload) {
  if (!hf.ws || hf.ws.readyState !== WebSocket.OPEN) return;
  hf.ws.send(JSON.stringify(payload));
}

async function hfStart() {
  if (hf.running) return;
  if (!state.config) { setStatus(t('error.config', { message: '' }), 'error'); return; }

  hf.running = true;
  hfButton();
  hfState('connecting');
  setStatus('');

  const cfg = state.config;
  const rate = Number(cfg.audio.stt_sample_rate);
  const frameMs = Number(cfg.stream.client_frame_ms);

  try {
    const mic = await micStream();
    hf.ctx = audioContextAt(rate);
    if (hf.ctx.state === 'suspended') await hf.ctx.resume();
    await hf.ctx.audioWorklet.addModule(CAPTURE_WORKLET_URL);

    hf.node = new AudioWorkletNode(hf.ctx, CAPTURE_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      // 규격은 전부 서버가 준 값이다. 워크릿 안에도 숫자가 없다.
      processorOptions: { targetSampleRate: rate, frameMs },
    });
    hf.node.port.onmessage = (event) => hfFrame(event.data);

    hf.source = hf.ctx.createMediaStreamSource(mic);
    // 워크릿은 목적지까지 연결돼 있어야 process() 가 불린다. 게인 0 으로 소리는 죽인다.
    hf.sink = hf.ctx.createGain();
    hf.sink.gain.value = 0;
    hf.source.connect(hf.node);
    hf.node.connect(hf.sink);
    hf.sink.connect(hf.ctx.destination);
  } catch (err) {
    setStatus(t('error.mic', { message: err.message }), 'error');
    hfStop();
    return;
  }

  try {
    hf.ws = new WebSocket(streamUrl(cfg.stream.path));
    hf.ws.binaryType = 'arraybuffer';
  } catch (err) {
    setStatus(t('error.stream', { message: err.message }), 'error');
    hfStop();
    return;
  }

  hf.ws.addEventListener('open', () => hfSend(hfConfigMessage(rate)));
  hf.ws.addEventListener('message', (event) => {
    if (typeof event.data === 'string') hfEvent(event.data);
    else hfAudio(event.data);
  });
  // WebSocket 의 error 이벤트에는 이유가 없다(브라우저가 감춘다). 이유는 서버가
  // error 이벤트로 주고, 그마저 못 받으면 바로 뒤따르는 close 가 알린다.
  hf.ws.addEventListener('close', () => {
    if (!hf.running) return;
    setStatus(t('error.stream_closed'), 'error');
    hfStop();
  });
}

function hfStop() {
  hf.running = false;
  hf.ready = false;
  hf.pendingChunk = null;
  hfStopPlayback();

  if (hf.node) {
    try { hf.node.port.postMessage('stop'); } catch (_) { /* 이미 닫힘 */ }
    try { hf.node.port.onmessage = null; } catch (_) { /* 무시 */ }
    try { hf.node.disconnect(); } catch (_) { /* 무시 */ }
  }
  for (const node of [hf.source, hf.sink]) {
    if (node) { try { node.disconnect(); } catch (_) { /* 무시 */ } }
  }
  if (hf.ctx) { try { hf.ctx.close(); } catch (_) { /* 무시 */ } }
  hf.node = hf.source = hf.sink = hf.ctx = null;

  if (hf.ws) {
    const ws = hf.ws;
    hf.ws = null;                       // close 핸들러가 다시 들어오지 않게 먼저 끊는다
    try { ws.close(); } catch (_) { /* 무시 */ }
  }

  releaseMicIfIdle();       // 화자 등록이 녹음 중이면 마이크를 빼앗지 않는다
  hf.turns.clear();
  const bar = $('#hf-level');
  if (bar) bar.style.width = '0%';
  hfState('idle');
  hfButton();
}

/* ---- 마이크 프레임 ------------------------------------------------------- */

function hfFrame(buffer) {
  hfLevel(buffer);
  if (!hf.ready || !hf.ws || hf.ws.readyState !== WebSocket.OPEN) return;
  hf.ws.send(buffer);
}

/** 지금 마이크가 듣고 있는지 눈으로 보이게. 보내는 프레임에서 그대로 계산한다. */
function hfLevel(buffer) {
  const pcm = new Int16Array(buffer);
  if (!pcm.length) return;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 1) sum += pcm[i] * pcm[i];
  const rms = Math.sqrt(sum / pcm.length) / 0x8000;
  const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  const ratio = Math.max(0, Math.min(1, (db + LEVEL_FLOOR_DB) / LEVEL_FLOOR_DB));
  if (hf.levelPending) return;
  hf.levelPending = true;
  requestAnimationFrame(() => {
    hf.levelPending = false;
    const bar = $('#hf-level');
    if (bar) bar.style.width = `${Math.round(ratio * 100)}%`;
  });
}

/* ---- 이벤트 -------------------------------------------------------------- */

function hfEvent(raw) {
  let msg = null;
  try {
    msg = JSON.parse(raw);
  } catch (err) {
    setStatus(t('error.stream', { message: err.message }), 'error');
    return;
  }
  const handler = hfHandlers[msg.type];
  // 모르는 이벤트는 조용히 흘려보낸다. 서버가 단계를 늘려도 클라이언트가 깨지지 않게.
  if (handler) handler(msg);
}

/** tts.chunk 바로 뒤에 오는 바이너리 프레임. 순서는 서버가 락으로 보장한다. */
function hfAudio(buffer) {
  const meta = hf.pendingChunk;
  hf.pendingChunk = null;
  if (!meta) return;
  hfEnqueue(buffer, meta);
}

const hfHandlers = {
  ready(msg) {
    hf.ready = true;
    hfState('listening');
    // 참여자 id 는 세션을 연 서버가 여기서 알려준다. 화자 등록 화면이 쓰는 것과
    // 같은 값이므로 그대로 받아 둔다 (등록 id 는 이 id 와 같아야 대조가 된다).
    adoptParticipants(msg);
    // 서버가 확정한 입력 규격. 우리가 선언한 것과 다르면 서버가 오류를 냈을 것이다.
    const audio = msg.audio || {};
    setStatus(t('handsfree.connected', {
      rate: audio.sample_rate,
      format: audio.format,
      vad: (msg.vad || {}).backend,
    }));
  },

  vad(msg) {
    if (msg.state === 'speech_start') {
      hfState('speaking');
      return;
    }
    // speech_end. dropped 면 min_speech_ms 에 못 미쳐 버려진 것이라 파이프라인이 돌지 않는다.
    if (msg.dropped) {
      hfState('listening');
      setStatus(t('handsfree.too_short'));
      return;
    }
    hfState('processing');
  },

  'stt.partial': (msg) => hfSource(msg),      // 지금은 서버가 보내지 않는다 (2단계)
  'stt.final': (msg) => hfSource(msg),

  'llm.delta': (msg) => hfTarget(msg, true),  // 지금은 서버가 보내지 않는다 (2단계)
  'llm.final': (msg) => hfTarget(msg, false),

  // 오류가 아니다. 화자 식별이 이 세그먼트를 처리하지 않기로 한 것이고,
  // 같은 사유가 뒤따르는 metrics 의 skipped 에도 실린다.
  'speaker.rejected': (msg) => {
    const entry = hfTurn(msg.seg);
    const note = entry.turn.querySelector('.skipped');
    note.textContent = skippedText(msg.reason, msg);
    note.hidden = false;
    entry.turn.classList.add('is-skipped');
    entry.turn.querySelector('.source .text').textContent = '—';
    hfRoute(entry);
    if (!hf.playing) hfState('listening');
  },

  'tts.chunk': (msg) => { hf.pendingChunk = msg; },

  'tts.done': () => {
    if (!hf.playing) hfState('listening');
  },

  // barge_in 정책에서 사용자가 말을 시작하면 서버가 재생 중단을 지시한다.
  'tts.stop': () => hfStopPlayback(),

  cancelled: () => {
    hfStopPlayback();
    hfState('listening');
  },

  metrics(msg) {
    const entry = hfTurn(msg.seg);
    const shown = { ...msg };
    for (const key of ['type', 'seg', 'from', 'to']) delete shown[key];
    entry.turn.querySelector('.metrics').textContent = formatMetrics(shown);
    if (!hf.playing) hfState('listening');
  },

  error(msg) {
    setStatus(t('error.stream', { message: msg.message || msg.code || '' }), 'error');
  },
};

/* ---- 화면 ---------------------------------------------------------------- */

/**
 * 세그먼트 하나 = 이력 항목 하나. PTT 와 같은 틀을 쓴다.
 * from/to 는 항상 채운다 — 2단계 양방향에서 화면을 다시 짜지 않기 위해서다.
 */
function hfTurn(seg) {
  let entry = hf.turns.get(seg);
  if (entry) return entry;

  const fragment = $('#turn-template').content.cloneNode(true);
  const turn = fragment.querySelector('.turn');
  turn.querySelector('.clock').textContent = new Date().toLocaleTimeString(state.locale);
  turn.querySelector('.source .text').textContent = '…';
  entry = { turn, from: '', sourceLang: '', tos: new Map(), deliveries: new Map() };
  hf.turns.set(seg, entry);

  $('#history').prepend(fragment);
  $('#history-empty').hidden = true;
  return entry;
}

function hfRoute(entry) {
  const to = [...entry.tos]
    .map(([id, lang]) => (lang ? `${id} · ${lang}` : id))
    .join(', ');
  entry.turn.querySelector('.route').textContent = t('result.route', {
    from: entry.sourceLang ? `${entry.from} · ${entry.sourceLang}` : entry.from || '—',
    to: to || '—',
  });
}

function hfSource(msg) {
  const entry = hfTurn(msg.seg);
  entry.from = msg.from || entry.from;
  entry.sourceLang = msg.lang || entry.sourceLang;
  // 발화자 쪽 이벤트의 to 는 수신자 id **배열**이다 (streaming.py 의 from/to 규약).
  for (const id of msg.to || []) {
    if (!entry.tos.has(id)) entry.tos.set(id, '');
  }
  entry.turn.querySelector('.source .text').textContent = msg.text || '—';
  hfRoute(entry);
}

function hfDelivery(entry, to) {
  let delivery = entry.deliveries.get(to);
  if (delivery) return delivery;

  const fragment = $('#delivery-template').content.cloneNode(true);
  const line = fragment.querySelector('.delivery');
  line.querySelector('.line-label').textContent = `${t('result.translation')} → ${to}`;
  const player = line.querySelector('.player');
  player.hidden = true;                      // 오디오가 오면 그때 붙인다
  entry.turn.querySelector('.deliveries').appendChild(fragment);

  delivery = { line, player, text: '', chunks: 0 };
  entry.deliveries.set(to, delivery);
  return delivery;
}

/** 수신자 하나에 대한 이벤트라 to 는 문자열이다. delta 면 이어 붙이고 final 이면 확정한다. */
function hfTarget(msg, append) {
  const entry = hfTurn(msg.seg);
  const delivery = hfDelivery(entry, msg.to);
  delivery.text = append ? delivery.text + (msg.text || '') : (msg.text || '');
  delivery.line.querySelector('.text').textContent = delivery.text || '—';
  if (msg.lang) {
    entry.tos.set(msg.to, msg.lang);
    hfRoute(entry);
  }
}

/* ---- 재생 ---------------------------------------------------------------- */

function hfPlayContext() {
  if (!hf.play) hf.play = audioContextAt(0);
  return hf.play;
}

function decodeAudio(ctx, bytes) {
  return new Promise((resolve, reject) => {
    // 콜백만 받는 브라우저가 있어 둘 다 건다.
    const maybe = ctx.decodeAudioData(bytes, resolve, reject);
    if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject);
  });
}

/** 컨테이너를 못 알아보면 원시 PCM16 으로 본다. 샘플레이트는 청크 메타(sr)가 준다. */
function pcm16Buffer(ctx, bytes, rate) {
  const pcm = new Int16Array(bytes);
  const buffer = ctx.createBuffer(1, pcm.length, rate || ctx.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i += 1) channel[i] = pcm[i] / 0x8000;
  return buffer;
}

/**
 * 청크를 큐에 넣어 순서대로 끊김 없이 잇는다.
 *
 * 디코딩이 비동기라 그냥 두면 순서가 뒤집힌다. 프라미스 체인으로 한 줄로 세우고,
 * 재생 시각은 이전 청크의 끝에 붙인다(seq 순서 = 도착 순서 = 체인 순서).
 */
function hfEnqueue(bytes, meta) {
  hf.playChain = hf.playChain.then(async () => {
    if (!hf.running) return;
    const ctx = hfPlayContext();
    if (ctx.state === 'suspended') await ctx.resume();

    const raw = bytes.slice(0);              // decodeAudioData 가 원본을 비워버린다
    let buffer = null;
    try {
      buffer = await decodeAudio(ctx, bytes);
    } catch (_) {
      buffer = pcm16Buffer(ctx, raw, Number(meta.sr));
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const at = Math.max(ctx.currentTime, hf.playAt);
    source.start(at);
    hf.playAt = at + buffer.duration;
    hf.sources.push(source);
    source.addEventListener('ended', () => {
      hf.sources = hf.sources.filter((s) => s !== source);
      if (!hf.sources.length) hfPlaybackEnded();
    });
    hfPlaybackStarted();

    hfAttachPlayer(meta, raw);
  }).catch(() => { /* 한 청크가 깨져도 다음 청크는 계속 간다 */ });
}

/** 다시 듣기용. 청크가 여럿이면 이어붙일 수 없으므로 플레이어를 붙이지 않는다. */
function hfAttachPlayer(meta, raw) {
  const entry = hf.turns.get(meta.seg);
  if (!entry) return;
  const delivery = entry.deliveries.get(meta.to);
  if (!delivery) return;
  delivery.chunks += 1;
  if (delivery.chunks > 1) {
    delivery.player.hidden = true;
    delivery.player.removeAttribute('src');
    return;
  }
  delivery.player.src = URL.createObjectURL(
    new Blob([raw], { type: meta.content_type || 'application/octet-stream' })
  );
  delivery.player.hidden = false;
}

function hfPlaybackStarted() {
  if (hf.playing) return;
  hf.playing = true;
  hfState('playing');
  // 서버는 스피커를 볼 수 없어 보낸 오디오 길이로 재생 구간을 추정한다.
  // 실제 재생 상태를 알려주면 그 추정을 덮는다 (half_duplex 턴 정책).
  hfSend({ type: 'control', action: 'playback', state: 'start' });
}

function hfPlaybackEnded() {
  if (!hf.playing) return;
  hf.playing = false;
  hf.playAt = 0;
  hfSend({ type: 'control', action: 'playback', state: 'end' });
  if (hf.running) hfState('listening');
}

function hfStopPlayback() {
  for (const source of hf.sources) {
    try { source.stop(); } catch (_) { /* 이미 끝난 경우 */ }
  }
  hf.sources = [];
  hf.playChain = Promise.resolve();
  hf.playAt = 0;
  hfPlaybackEnded();
}

defineInputMode(HANDSFREE_MODE, {
  enter() {
    hfButton();
    hfState('idle');
    if (!handsfreeSupported()) {
      setStatus(t(window.isSecureContext === false ? 'error.insecure' : 'error.no_worklet'), 'error');
    }
  },
  exit() {
    hfStop();
  },
  refresh() {
    hfButton();
    hfState($('#hf-state') ? $('#hf-state').dataset.state : 'idle');
  },
  settingsChanged() {
    // config 는 최초 1회만 받는다("already_configured"). 바뀐 설정으로 다시 연다.
    if (!hf.running) return;
    hfStop();
    setStatus(t('handsfree.restarting'));
    hfStart();
  },
});

/* --------------------------------------------------- 화자 등록 (voice print) */

/*
 * 목소리를 등록해 두면 서버가 "누가 말했는지"를 목소리로 가른다.
 *
 * 여기에도 목록이 없다.
 *   · 정책 목록·임계값·등록 수·저장소 상태는 /v1/config 의 speaker_id 가 준다
 *   · 참여자 id 는 세션을 여는 서버가 준다 (스트림의 ready)
 *   · 문구는 locales/*.json 이고, 없는 이름은 서버가 준 코드를 그대로 보여준다
 *
 * ★ 등록 id 는 **참여자 id 와 같아야** 대조가 된다. 프로필이 바뀌면 참여자 id 도
 *   바뀌므로(oneway 는 speaker/listener, twoway_voice 는 a/b), 지금 고른 설정으로
 *   서버가 만들 세션의 참여자를 그대로 보여주고 그 중에서 고르게 한다.
 */

// 참여자를 물어보는 짧은 세션의 대기 한도. 프로토콜과 무관한 화면 사정이다.
const PARTICIPANT_PROBE_MS = 5000;

const spk = {
  clips: [],          // 아직 올리지 않은 녹음/파일 {id, label, filename, blob, url}
  seq: 0,
  recorder: null,
  recording: false,
  participants: [],   // 지금 설정으로 열릴 세션의 참여자. 서버가 준 그대로다
  profile: '',        // 그 참여자를 만든 프로필. 서버가 확정한 이름이다
  probeKey: null,     // 어떤 설정으로 물어본 결과인지
  probing: false,
  choice: null,       // 등록 대상 참여자 id
  name: '',           // 표시 이름 (비우면 서버가 id 를 쓴다)
  policy: null,       // 관리 영역에서 고른 정책 — 누르기 전에는 적용되지 않는다
  list: null,         // GET /v1/speakers 응답
};

function speakerConfig() {
  return (state.config && state.config.speaker_id) || null;
}

function speakerMessage(node, text, kind) {
  if (!node) return;
  node.textContent = text;
  node.className = kind ? `status ${kind}` : 'status';
}

/** 거부 사유. 코드는 서버가 정하고 문구는 카탈로그에서 온다 — 없으면 코드를 그대로. */
function skippedText(reason, detail) {
  const text = nameOf(`skipped.${reason}`, reason);
  const similarity = detail ? detail.speaker_similarity : undefined;
  if (similarity === undefined || similarity === null) return text;
  return `${text} (${t('speakers.similarity', { value: similarity })})`;
}

/* ---- 상태 ---------------------------------------------------------------- */

function renderSpeakers() {
  const info = speakerConfig();
  const panel = $('#speakers');
  const toggle = $('#speakers-toggle');
  if (!panel || !toggle) return;

  // 서버가 화자 식별을 내보내지 않으면 이 화면은 존재하지 않는다.
  if (!info) {
    panel.hidden = true;
    toggle.hidden = true;
    return;
  }
  panel.hidden = false;
  toggle.hidden = false;

  renderSpeakerState();
  renderPolicyField();
  renderSpeakerForm();
  renderSpeakerList();
  renderClips();
  enrollButton();
  if (!panel.classList.contains('collapsed')) openSpeakers();
}

function renderSpeakerState() {
  const info = speakerConfig();
  if (!info) return;
  // 목록을 받아 뒀으면 그쪽이 더 최신이다 (등록·삭제 직후).
  const live = spk.list;
  const count = live ? live.count : info.enrolled;
  const auto = live ? live.auto_enroll : info.auto_enroll;
  const policy = live ? live.policy : info.policy;

  $('#speaker-state').textContent = t('speakers.state', {
    count,
    auto: t(auto ? 'speakers.auto_enroll.on' : 'speakers.auto_enroll.off'),
    policy: nameOf(`policy.${policy}`, policy),
  });

  const error = (live ? live.error : info.store_error) || '';
  const box = $('#speaker-store-error');
  box.textContent = error ? t('speakers.store_error', { message: error }) : '';
  box.hidden = !error;
}

/* ---- 참여자 -------------------------------------------------------------- */

/** 참여자 구성을 정하는 값들. 하나라도 바뀌면 id·언어가 달라진다. */
function participantKey() {
  return [
    state.form.profile || '',
    state.form.mode || '',
    state.form.source_lang || '',
    state.form.target_lang || '',
  ].join('|');
}

/**
 * 참여자 id 를 서버에 물어본다.
 *
 * 프로필별 참여자 목록을 클라이언트에 두지 않기 위해서다 — 세션을 만드는 쪽이 곧
 * 정답이므로 스트림을 열어 ready 만 받고 바로 닫는다. 오디오는 한 프레임도 보내지
 * 않으므로 엔진도 마이크도 건드리지 않는다.
 */
function probeParticipants() {
  const cfg = state.config;
  if (!cfg || !cfg.stream || !cfg.stream.path || typeof WebSocket === 'undefined') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let ws = null;
    let timer = null;
    try {
      ws = new WebSocket(streamUrl(cfg.stream.path));
    } catch (_) {
      resolve(null);
      return;
    }
    const finish = (value) => {
      clearTimeout(timer);
      try { ws.close(); } catch (_) { /* 이미 닫힘 */ }
      resolve(value);                     // 두 번째부터는 무시된다
    };
    timer = setTimeout(() => finish(null), PARTICIPANT_PROBE_MS);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify(hfConfigMessage(Number(cfg.audio.stt_sample_rate))));
    });
    ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let msg = null;
      try { msg = JSON.parse(event.data); } catch (_) { return; }
      if (msg.type === 'ready') finish(msg);
      else if (msg.type === 'error') finish(null);
    });
    ws.addEventListener('close', () => finish(null));
    ws.addEventListener('error', () => finish(null));
  });
}

/** ready 이벤트에서 참여자를 받아 둔다. 핸즈프리가 열릴 때도 같은 것이 온다. */
function adoptParticipants(ready) {
  spk.participants = ready.participants || [];
  spk.profile = ready.profile || '';   // 서버가 실제로 고른 프로필. 화면의 이름도 이것을 따른다
  spk.probeKey = participantKey();
  renderSpeakerForm();
  renderSpeakerList();               // "참여자에 없음" 표시가 달라진다
}

async function refreshParticipants() {
  const key = participantKey();
  if (spk.probing || spk.probeKey === key) return;
  spk.probing = true;
  spk.probeKey = key;
  let ready = null;
  try {
    ready = await probeParticipants();
  } finally {
    spk.probing = false;
  }
  if (spk.probeKey !== key) return;   // 그 사이 설정이 또 바뀌었다
  if (ready) {
    adoptParticipants(ready);
    return;
  }
  spk.probeKey = null;                // 다음에 다시 물어본다
  spk.participants = [];
  spk.profile = '';
  renderSpeakerForm();
  renderSpeakerList();
}

/** 프로필·언어가 바뀌면 참여자도 바뀐다. 열려 있을 때만 다시 물어본다. */
function speakerSettingsChanged() {
  const panel = $('#speakers');
  if (!panel || panel.hidden) return;
  if (panel.classList.contains('collapsed')) {
    spk.probeKey = null;              // 다음에 열 때 다시 물어본다
    return;
  }
  refreshParticipants();
}

/* ---- 등록 폼 -------------------------------------------------------------- */

/** 말할 수 있는 참여자만. 듣기만 하는 자리에 목소리를 등록할 이유가 없다. */
function speakerCandidates() {
  return spk.participants.filter((p) => p.input);
}

function renderSpeakerForm() {
  const box = $('#speaker-form');
  const line = $('#speaker-participants');
  if (!box || !line || !state.config) return;
  box.replaceChildren();

  const candidates = speakerCandidates();
  // 참여자를 준 것이 서버이므로 프로필 이름도 서버가 확정한 것을 쓴다. 그래야
  // "이 프로필의 참여자"라는 두 값이 어긋나지 않는다.
  const profileId = (candidates.length && spk.profile) || state.form.profile || '';
  const profile = (state.config.profiles || []).find((p) => p.id === profileId);
  const profileLabel = (profile && profile.label) || profileId;

  if (candidates.length) {
    // 등록 id 와 참여자 id 가 같은 것이라는 사실을 여기서 드러낸다.
    line.textContent = t('speakers.participants', {
      profile: profileLabel,
      ids: candidates.map((p) => t('speakers.participant', { id: p.id, lang: p.lang })).join(', '),
    });
    if (!candidates.some((p) => p.id === spk.choice)) spk.choice = candidates[0].id;
    addSelect(box, {
      name: 'speaker_id',
      transient: true,                // 번역 요청에 실리는 값이 아니다
      label: t('speakers.field.speaker'),
      hint: t('speakers.field.speaker.hint'),
      options: candidates.map((p) => ({
        value: p.id,
        label: t('speakers.participant', { id: p.id, lang: p.lang }),
      })),
      value: spk.choice,
      onChange: (value) => { spk.choice = value; },
    });
  } else {
    // 서버에 물어보지 못했다. 목록을 지어내지 않고 id 를 직접 받는다.
    line.textContent = t('speakers.participants.unknown', { profile: profileLabel });
    addText(box, {
      name: 'speaker_id',
      label: t('speakers.field.id'),
      hint: t('speakers.field.id.hint'),
      value: spk.choice || '',
      onChange: (value) => { spk.choice = value.trim(); },
    });
  }

  addText(box, {
    name: 'name',
    label: t('speakers.field.name'),
    hint: t('speakers.field.name.hint'),
    value: spk.name,
    placeholder: spk.choice || '',
    onChange: (value) => { spk.name = value; },
  });
}

/* ---- 클립 ---------------------------------------------------------------- */

function addClip(blob, spec) {
  spk.seq += 1;
  const n = spk.seq;
  const ext = (spec && spec.ext) || 'bin';
  spk.clips.push({
    id: n,
    label: (spec && spec.label) || t('speakers.clip.recorded', { n }),
    filename: (spec && spec.filename) || `enroll-${n}.${ext}`,
    blob,
    url: URL.createObjectURL(blob),
  });
  renderClips();
}

function removeClip(id) {
  const keep = [];
  for (const clip of spk.clips) {
    if (clip.id === id) URL.revokeObjectURL(clip.url);
    else keep.push(clip);
  }
  spk.clips = keep;
  renderClips();
}

function clearClips() {
  for (const clip of spk.clips) URL.revokeObjectURL(clip.url);
  spk.clips = [];
  renderClips();
}

function renderClips() {
  const list = $('#enroll-clips');
  if (!list) return;
  list.replaceChildren();

  for (const clip of spk.clips) {
    const node = $('#clip-template').content.cloneNode(true);
    node.querySelector('.clip-name').textContent = t('speakers.clip', {
      name: clip.label,
      kb: Math.max(1, Math.round(clip.blob.size / 1024)),
    });
    node.querySelector('.player').src = clip.url;
    const remove = node.querySelector('.clip-remove');
    remove.textContent = t('speakers.clip.remove');
    remove.addEventListener('click', () => removeClip(clip.id));
    list.appendChild(node);
  }

  $('#enroll-clips-title').textContent =
    spk.clips.length ? t('speakers.clips', { count: spk.clips.length }) : '';
  $('#enroll-submit').disabled = !spk.clips.length;
  $('#enroll-clear').disabled = !spk.clips.length;
}

function enrollButton() {
  const button = $('#enroll-record');
  if (!button) return;
  button.textContent = t(spk.recording ? 'speakers.recording' : 'speakers.record');
  button.classList.toggle('is-recording', spk.recording);
  button.disabled = !recorderSupported();
}

/** 다른 곳이 마이크를 쓰고 있으면 놓지 않는다. */
function releaseMicIfIdle() {
  if (state.recording || spk.recording || hf.running) return;
  releaseMic();
}

async function toggleEnrollRecording() {
  const message = $('#enroll-message');
  if (spk.recording) {
    spk.recording = false;
    try { spk.recorder.stop(); } catch (_) { /* 이미 멈춘 경우 */ }
    enrollButton();
    speakerMessage(message, '');
    return;
  }
  try {
    const stream = await micStream();
    const chunks = [];
    const recorder = new MediaRecorder(stream);
    recorder.addEventListener('dataavailable', (e) => { if (e.data.size) chunks.push(e.data); });
    recorder.addEventListener('stop', () => {
      const blob = new Blob(chunks, { type: recorder.mimeType });
      if (blob.size) addClip(blob, { ext: extensionOf(recorder.mimeType) });
      releaseMicIfIdle();
    });
    recorder.start();
    spk.recorder = recorder;
    spk.recording = true;
    enrollButton();
    speakerMessage(message, t('speakers.recording.hint'), 'busy');
  } catch (err) {
    speakerMessage(message, t('error.mic', { message: err.message }), 'error');
  }
}

/* ---- 등록 ---------------------------------------------------------------- */

async function enrollVoice() {
  const message = $('#enroll-message');
  const id = (spk.choice || '').trim();
  if (!id) { speakerMessage(message, t('speakers.need_speaker'), 'error'); return; }
  if (!spk.clips.length) { speakerMessage(message, t('speakers.need_clips'), 'error'); return; }

  const form = new FormData();
  form.append('speaker_id', id);
  if (spk.name.trim()) form.append('name', spk.name.trim());
  // 화자 임베딩 엔진을 고르는 데 쓰인다. 설정에서 고른 모드를 그대로 따른다.
  if (state.form.mode) form.append('mode', state.form.mode);
  for (const clip of spk.clips) form.append('files', clip.blob, clip.filename);

  const button = $('#enroll-submit');
  button.disabled = true;
  speakerMessage(message, t('speakers.enrolling', { count: spk.clips.length }), 'busy');

  try {
    const result = await getJSON('/v1/speakers/enroll', { method: 'POST', body: form });
    const person = result.speaker || {};
    const lines = [t('speakers.enrolled', {
      name: person.name || id,
      id: person.id || id,
      count: person.utterances || spk.clips.length,
    })];

    // 올린 클립들이 서로 얼마나 닮았는지. 임계값보다 낮으면 다른 사람의 목소리가
    // 섞였다는 뜻이라 그대로 등록해두면 대조가 어긋난다.
    const spread = result.min_pairwise_similarity;
    const threshold = result.threshold;
    let kind = '';
    if (spread !== null && spread !== undefined) {
      if (threshold !== null && threshold !== undefined && Number(spread) < Number(threshold)) {
        lines.push(t('speakers.quality.low', { similarity: spread, threshold }));
        kind = 'warn';
      } else {
        lines.push(t('speakers.quality.ok', { similarity: spread }));
      }
    }
    speakerMessage(message, lines.join(' '), kind);

    clearClips();
    spk.name = '';
    await refreshSpeakerList();
    renderSpeakerForm();
  } catch (err) {
    speakerMessage(message, t('speakers.error', { message: err.message }), 'error');
  } finally {
    button.disabled = !spk.clips.length;
  }
}

/* ---- 등록 목록 ------------------------------------------------------------ */

async function refreshSpeakerList() {
  try {
    spk.list = await getJSON('/v1/speakers');
  } catch (err) {
    spk.list = null;
    speakerMessage($('#enroll-message'), t('speakers.error', { message: err.message }), 'error');
  }
  renderSpeakerState();
  renderSpeakerList();
}

function renderSpeakerList() {
  const list = $('#speaker-list');
  if (!list) return;
  const people = (spk.list && spk.list.speakers) || [];
  const known = new Set(spk.participants.map((p) => p.id));
  list.replaceChildren();

  for (const person of people) {
    const node = $('#speaker-template').content.cloneNode(true);
    node.querySelector('.speaker-name').textContent = person.name || person.id;
    node.querySelector('.speaker-id').textContent = person.id;

    const meta = [t('speakers.meta', {
      count: person.utterances,
      engine: [person.engine, person.model].filter(Boolean).join(' ') || '—',
      updated: person.updated_at
        ? new Date(person.updated_at).toLocaleString(state.locale)
        : '—',
    })];
    // 등록 id 가 지금 세션의 참여자 중에 없으면 이 목소리는 대조에 쓰이지 않는다.
    // 두 id 가 같은 것이라는 사실이 가장 잘 드러나는 자리다.
    const stray = known.size > 0 && !known.has(person.id);
    if (stray) meta.push(t('speakers.unused'));
    node.querySelector('.speaker-meta').textContent = meta.join(' · ');
    if (stray) node.querySelector('.speaker').classList.add('unused');

    const remove = node.querySelector('.speaker-delete');
    remove.textContent = t('speakers.delete');
    remove.addEventListener('click', () => deleteSpeaker(person.id));
    list.appendChild(node);
  }

  $('#speaker-empty').hidden = people.length > 0;
}

async function deleteSpeaker(id) {
  const message = $('#enroll-message');
  try {
    await getJSON(`/v1/speakers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    speakerMessage(message, t('speakers.deleted', { id }));
  } catch (err) {
    speakerMessage(message, t('speakers.error', { message: err.message }), 'error');
  }
  await refreshSpeakerList();
}

/* ---- 정책 (서버 전역) ------------------------------------------------------ */

/*
 * 이 브라우저의 설정이 아니라 **서버의 설정**이다. /v1/admin/config 는 즉시
 * 전역에 적용되므로, 고르는 것만으로는 아무 일도 일어나지 않게 두고 따로 누르게 한다.
 */

function renderPolicyField() {
  const info = speakerConfig();
  const box = $('#policy-field');
  if (!info || !box) return;
  box.replaceChildren();

  const policies = info.policies || [];
  const server = (spk.list && spk.list.policy) || info.policy;
  if (!policies.length) {
    $('#policy-desc').textContent = '';
    return;
  }
  if (!policies.includes(spk.policy)) {
    spk.policy = policies.includes(server) ? server : policies[0];
  }

  addSelect(box, {
    name: 'speaker_policy',
    transient: true,             // 번역 요청에 실리지 않는다 — 서버 전역 설정이다
    label: t('speakers.policy.field'),
    options: policies.map((p) => ({ value: p, label: nameOf(`policy.${p}`, p) })),
    value: spk.policy,
    onChange: (value) => { spk.policy = value; describePolicy(); },
  });
  describePolicy();
}

function describePolicy() {
  $('#policy-desc').textContent = nameOf(`policy.${spk.policy}.desc`, '');
}

async function applyPolicy() {
  const message = $('#policy-message');
  const info = speakerConfig();
  if (!info || !spk.policy) return;

  const server = (spk.list && spk.list.policy) || info.policy;
  if (spk.policy === server) {
    speakerMessage(message, t('speakers.policy.unchanged'));
    return;
  }

  const button = $('#policy-apply');
  button.disabled = true;
  try {
    await getJSON('/v1/admin/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speaker_id: { policy: spk.policy } }),
    });
    // 전역이라는 사실을 결과 문구에서 한 번 더 말한다.
    speakerMessage(message, t('speakers.policy.applied', {
      policy: nameOf(`policy.${spk.policy}`, spk.policy),
    }), 'warn');
    await loadConfig();
    await refreshSpeakerList();
  } catch (err) {
    speakerMessage(message, t('speakers.error', { message: err.message }), 'error');
  } finally {
    button.disabled = false;
  }
}

/* ---- 패널 ---------------------------------------------------------------- */

function openSpeakers() {
  refreshSpeakerList();
  refreshParticipants();
}

function wireSpeakers() {
  $('#speakers-toggle').addEventListener('click', () => {
    const panel = $('#speakers');
    const collapsed = panel.classList.toggle('collapsed');
    if (!collapsed) openSpeakers();
  });

  $('#enroll-record').addEventListener('click', toggleEnrollRecording);

  $('#enroll-file').addEventListener('change', (e) => {
    for (const file of e.target.files || []) {
      addClip(file, { label: file.name, filename: file.name });
    }
    e.target.value = '';
  });

  $('#enroll-clear').addEventListener('click', clearClips);
  $('#enroll-submit').addEventListener('click', enrollVoice);
  $('#policy-apply').addEventListener('click', applyPolicy);
}

/* ------------------------------------------------------------------ 입력 */

function wireControls() {
  const ptt = $('#ptt');

  // 마우스·터치·펜 모두 pointer 이벤트 하나로 처리된다.
  ptt.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (ptt.setPointerCapture) ptt.setPointerCapture(e.pointerId);
    startRecording();
  });
  for (const type of ['pointerup', 'pointercancel']) {
    ptt.addEventListener(type, (e) => { e.preventDefault(); stopRecording(); });
  }
  ptt.addEventListener('contextmenu', (e) => e.preventDefault());

  // 스페이스바 홀드. 입력 요소에 포커스가 있거나 data-no-ptt 영역 안이면 방해하지 않는다
  // (화자 등록 패널이 그 표시를 달고 있다 — 거기서 스페이스는 그 화면의 버튼용이다).
  const typing = (target) => !target
    || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)
    || Boolean(target.closest && target.closest('[data-no-ptt]'));
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || typing(e.target)) return;
    e.preventDefault();
    startRecording();
  });
  document.addEventListener('keyup', (e) => {
    if (e.code !== 'Space' || typing(e.target)) return;
    e.preventDefault();
    stopRecording();
  });
  // 창을 벗어난 채로 키를 떼면 keyup 이 오지 않는다.
  window.addEventListener('blur', stopRecording);

  // 핸즈프리는 토글이다. 누르고 있을 필요가 없다는 것이 이 방식의 요점이다.
  $('#hf-toggle').addEventListener('click', () => {
    if (hf.running) hfStop();
    else hfStart();
  });

  $('#file-input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) translate(file, file.name);
    e.target.value = '';
  });

  $('#history-clear').addEventListener('click', () => {
    $('#history').replaceChildren();
    $('#history-empty').hidden = false;
    hf.turns.clear();          // 지운 DOM 을 계속 갱신하지 않게
  });

  $('#settings-toggle').addEventListener('click', () => {
    $('#settings').classList.toggle('collapsed');
  });

  wireSpeakers();

  // 페이지를 떠날 때 소켓과 마이크를 확실히 놓는다. bfcache 로 돌아오면 다시 켜면 된다.
  window.addEventListener('pagehide', () => {
    const impl = activeInput();
    if (impl && impl.exit) impl.exit();
  });
}

/* ------------------------------------------------------------------ 기동 */

async function boot() {
  try {
    state.localeIndex = await getJSON('locales/index.json');
    await loadLocale(resolveLocale(state.localeIndex));
    renderLocaleSwitcher();
  } catch (err) {
    // 카탈로그를 못 읽은 상황이라 문구도 없다. t() 가 키를 그대로 돌려주면 원문 오류를 보여준다.
    const message = t('error.locales', { message: err.message });
    setStatus(message === 'error.locales' ? err.message : message, 'error');
    return;
  }

  wireControls();

  // 입력 방식별 사용 가능 여부는 각 구현의 enter() 가 판단한다.
  // 어느 것을 켤지는 /v1/config 가 정하므로 여기서 고르지 않는다.
  try {
    await loadConfig();
  } catch (err) {
    setStatus(t('error.config', { message: err.message }), 'error');
  }

  document.documentElement.removeAttribute('data-loading');
}

boot();
