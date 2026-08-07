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

  state.form[spec.name] = sel.value;
  sel.addEventListener('change', () => {
    state.form[spec.name] = sel.value;
    if (spec.rerender) renderSettings();
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
  box.addEventListener('change', () => { state.form[spec.name] = box.checked; });
  const caption = el('span', 'field-label');
  caption.textContent = spec.label;
  wrap.append(box, caption);
  parent.appendChild(wrap);
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

/* ----------------------------------------------------------------- 상태줄 */

function setStatus(text, kind) {
  const node = $('#status');
  node.textContent = text;
  node.className = kind ? `status ${kind}` : 'status';
}

/* ------------------------------------------------------------------ 녹음 */

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

async function startRecording() {
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

  // 스페이스바 홀드. 입력 요소에 포커스가 있을 때는 방해하지 않는다.
  const typing = (target) => /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName);
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

  $('#file-input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) translate(file, file.name);
    e.target.value = '';
  });

  $('#history-clear').addEventListener('click', () => {
    $('#history').replaceChildren();
    $('#history-empty').hidden = false;
  });

  $('#settings-toggle').addEventListener('click', () => {
    $('#settings').classList.toggle('collapsed');
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

  if (recorderSupported()) {
    $('#ptt').disabled = false;
  } else {
    setStatus(t(window.isSecureContext === false ? 'error.insecure' : 'error.no_recorder'), 'error');
  }

  try {
    await loadConfig();
  } catch (err) {
    setStatus(t('error.config', { message: err.message }), 'error');
  }

  document.documentElement.removeAttribute('data-loading');
}

boot();
