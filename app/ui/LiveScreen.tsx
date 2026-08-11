/**
 * 실시간 통역 화면 — 마이크로 말하면 번역된 음성이 나온다.
 *
 * 웹 클라이언트(`web/static/app.js` 의 handsfree 입력 방식)가 하는 일을 앱으로 옮긴 것이다.
 * 흐름은 웹과 같다.
 *
 *   권한 → GET /v1/config → WS 열기(config 전송) → ready → 마이크 캡처 시작
 *        → PCM16 20ms 프레임 …  → vad / stt / llm / tts.chunk(+오디오) / metrics
 *
 * **입력 방식(`input_mode`)을 따른다.** 설정 화면이 고른 값이고 목록은 `/v1/config` 의
 * `client.input_modes` 에서 온다. 구현은 `ui/inputMode.ts` 에 있고, 이 화면이 보는 것은
 * "누르는 동안만 캡처하는가" 하나뿐이다.
 *
 *   핸즈프리   ready 뒤에 캡처를 시작해 계속 흘려보낸다. 발화 경계는 서버 VAD 가 잡는다
 *   누르고 말하기  연결만 해두고, 버튼을 **누르는 동안만** 캡처한다. 떼면 캡처를 멈추고
 *              `control/flush` 를 보내 서버가 그 자리에서 세그먼트를 확정하게 한다
 *              (`streaming.py` 의 `_drain_vad(force=True)`). 누르지 않는 동안에는 프레임이
 *              하나도 나가지 않으므로 배경 소음이 VAD·STT 에 닿지 않는다
 *
 * 세션 `mode` 와는 다른 축이다 — 그쪽은 서버가 어느 엔진·경로를 쓰는지이고 설정 화면이
 * 이미 보낸다. 이 화면은 마이크를 어떻게 다루는지만 정한다.
 *
 * **숫자가 없다.** 샘플레이트·채널·프레임 길이·WS 경로·언어는 전부 `/v1/config` 에서 온다.
 * 화면에 남은 상수는 레벨 미터와 이력 길이 — 프로토콜과 무관한 표시 전용이다.
 *
 * **오류 문구를 앱이 만들지 않는다.** 서버가 준 `error.message` 를 그대로 띄운다.
 * 앱이 만드는 문장은 서버까지 가지 못한 것들(권한 거부·주소 누락·오디오 디코딩)뿐이다.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  PermissionsAndroid,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { MicCapture } from '../audio/capture';
import { frameLevel } from '../audio/pcm';
import { TtsPlayer } from '../audio/playback';
import { authHeaders, fetchConfig, frameSamples, openStream, streamUrl } from '../src/api';
import type {
  ApiClient,
  LlmEvent,
  MetricsEvent,
  ServerConfig,
  SttEvent,
  StreamSession,
  WebSocketLike,
} from '../src/api';
import { Button } from './Button';
import { holdsToTalk } from './inputMode';
import { chosenInputMode, streamConfig } from './settings';
import type { Settings } from './settings';
import { ui } from './theme';
import type { Palette } from './theme';

/* ---- 표시 전용 상수 ---------------------------------------------------------
 *
 * 프로토콜과도 서버 설정과도 무관하다. 레벨 미터의 표시 범위와, 화면에 남겨 둘 이력의 길이.
 */

const LEVEL_FLOOR_DB = 60;
/** 레벨·프레임 수를 화면에 반영하는 간격. 20ms 마다 setState 하면 화면이 못 따라온다. */
const LEVEL_INTERVAL_MS = 100;
const MAX_TURNS = 20;

/* ---- 화면 상태 -------------------------------------------------------------- */

type Phase = 'idle' | 'permission' | 'connecting' | 'live';

/** 세션이 열린 뒤의 표시 상태. 웹의 `hfState()` 와 같은 값들이다. */
type Live = 'listening' | 'speaking' | 'processing' | 'playing';

const LIVE_LABEL: Record<Live, string> = {
  listening: '대기 중 — 말해 보세요',
  speaking: '말하는 중',
  processing: '처리 중…',
  playing: '재생 중',
};

interface Delivery {
  to: string;
  lang: string;
  text: string;
}

/** 세그먼트 하나 = 이력 항목 하나. */
interface Turn {
  seg: number;
  from: string;
  sourceLang: string;
  sourceText: string;
  /** stt.partial 로 들어온 중간 결과인가. */
  partial: boolean;
  deliveries: Delivery[];
  metrics: string;
  /** speaker.rejected — 오류가 아니라 "이 세그먼트를 처리하지 않았다"는 뜻이다. */
  skipped: string;
}

function emptyTurn(seg: number): Turn {
  return {
    seg,
    from: '',
    sourceLang: '',
    sourceText: '…',
    partial: false,
    deliveries: [],
    metrics: '',
    skipped: '',
  };
}

/**
 * 지표를 한 줄로. 키 목록을 앱이 갖지 않는다 — 서버가 보낸 것을 그대로 편다
 * (`stt_ms`, `llm_ms.<수신자>`, `tts_ms.<수신자>`, `total_ms`, `audio_duration_s` …).
 * 단위만 이름 끝을 보고 붙인다 — 웹의 `formatMetrics()` 와 같은 규칙이다.
 */
function formatMetrics(event: MetricsEvent): string {
  const parts: string[] = [];
  for (const key of Object.keys(event)) {
    if (key === 'type' || key === 'seg' || key === 'from' || key === 'to') continue;
    const value = (event as Record<string, unknown>)[key];
    if (value === null || value === undefined || value === '') continue;
    const base = key.split('.')[0] || key;
    const unit = base.endsWith('_ms') ? ' ms' : base.endsWith('_s') ? ' s' : '';
    parts.push(`${key} ${String(value)}${unit}`);
  }
  return parts.join(' · ');
}

/**
 * 마이크 권한. 거부되면 **왜** 안 되는지 화면에 띄울 문장을 돌려준다.
 * 안드로이드에서만 물어본다 — iOS 는 아직 다루지 않는다(Mac 이 없다).
 */
async function requestMic(): Promise<string | null> {
  if (Platform.OS !== 'android') return null;
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
    title: '마이크 권한',
    message: '말한 것을 서버로 보내 통역하려면 마이크가 필요하다.',
    buttonPositive: '허용',
    buttonNegative: '거부',
  });
  if (result === PermissionsAndroid.RESULTS.GRANTED) return null;
  if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
    return '마이크 권한이 "다시 묻지 않음"으로 거부돼 있다. 기기의 설정 → 앱 → 권한에서 직접 켜야 이 화면이 돈다.';
  }
  return '마이크 권한이 거부됐다. 권한 없이는 캡처를 시작할 수 없다.';
}

/* ---- 화면 ------------------------------------------------------------------- */

export function LiveScreen({
  colors,
  makeClient,
  locale,
  errorText,
  form,
  onConfig,
}: {
  colors: Palette;
  makeClient: () => ApiClient | null;
  locale: string;
  errorText: (err: unknown) => string;
  /**
   * 설정 화면에서 고른 값. **세션이 이 값으로 열린다** — 비어 있으면 서버 기본값이다.
   * 매번 새로 받은 `/v1/config` 위에 얹으므로, 서버가 목록을 바꿔 고른 값이 더는 쓸 수
   * 없게 되면 `streamConfig()` 가 고를 수 있는 값으로 물러난다.
   */
  form: Settings;
  /** 여기서 받아온 설정을 App 에 돌려준다 — 설정 화면이 같은 응답을 쓴다. */
  onConfig?: (config: ServerConfig) => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [live, setLive] = useState<Live>('listening');
  const [ready, setReady] = useState('');
  const [error, setError] = useState('');
  const [notices, setNotices] = useState<string[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [level, setLevel] = useState(0);
  const [frames, setFrames] = useState(0);
  /** 세션을 연 입력 방식의 이름. 서버가 준 이름 그대로 화면에 띄운다. */
  const [inputMode, setInputMode] = useState('');
  /** 그 방식이 "누르는 동안만 캡처"인가. 이 값 하나로 화면과 캡처가 갈린다. */
  const [holdToTalk, setHoldToTalk] = useState(false);
  /** 지금 버튼을 누르고 있는가 (표시용). 판단은 `pressingRef` 로 한다. */
  const [pressing, setPressing] = useState(false);

  const sessionRef = useRef<StreamSession | null>(null);
  const captureRef = useRef<MicCapture | null>(null);
  const playerRef = useRef<TtsPlayer | null>(null);
  const playingRef = useRef(false);
  const frameCountRef = useRef(0);
  const levelAtRef = useRef(0);
  /**
   * 프레임을 보내도 되는가.
   *
   * 누르고 말하기의 안전장치다. 캡처를 멈춰도 네이티브가 이미 올려보낸 버퍼가 뒤늦게
   * 도착할 수 있는데, 이 문이 닫혀 있으면 그것도 나가지 않는다. 핸즈프리에서는 캡처를
   * 시작할 때 열어두고 끝까지 열려 있다.
   */
  const sendingRef = useRef(false);
  /** 버튼을 누르고 있는가. 렌더를 기다리지 않는 판단은 전부 이 값으로 한다. */
  const pressingRef = useRef(false);

  const addNotice = useCallback((message: string) => {
    setNotices(prev => (prev.includes(message) ? prev : [message, ...prev].slice(0, MAX_TURNS)));
  }, []);

  /** 세그먼트 하나를 고쳐 쓴다. 없으면 새로 만들어 맨 앞에 둔다(최신이 위). */
  const upsertTurn = useCallback((seg: number, update: (turn: Turn) => Turn) => {
    setTurns(prev => {
      const index = prev.findIndex(t => t.seg === seg);
      if (index >= 0) {
        const next = prev.slice();
        next[index] = update(next[index] as Turn);
        return next;
      }
      return [update(emptyTurn(seg)), ...prev].slice(0, MAX_TURNS);
    });
  }, []);

  /** 재생 중이 아니면 "대기 중"으로 되돌린다 — 웹의 `if (!hf.playing)` 과 같다. */
  const settle = useCallback(() => {
    if (!playingRef.current) setLive('listening');
  }, []);

  const teardown = useCallback(() => {
    // 문을 먼저 닫는다. 아래에서 캡처를 멈추는 사이에 올라온 버퍼도 나가지 않게.
    sendingRef.current = false;
    pressingRef.current = false;
    setPressing(false);
    if (captureRef.current) {
      captureRef.current.stop();
      captureRef.current = null;
    }
    if (playerRef.current) playerRef.current.stop();
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    playingRef.current = false;
    setPhase('idle');
    setLevel(0);
  }, []);

  /**
   * 버튼에서 손을 뗀 것과 같은 처리. 누르고 말하기에서만 의미가 있다.
   *
   * **`onPressOut` 하나에 기대지 않는다.** RN 의 `Pressability` 는 손가락이 버튼 밖으로
   * 나가거나(LEAVE_PRESS_RECT) 스크롤이 응답자를 가져가면(RESPONDER_TERMINATED) 그때도
   * `onPressOut` 을 부르지만, **언마운트로 사라질 때는 부르지 않는다**(`reset()` 이 설정을
   * 얼려버린다). 그 두 자리를 따로 막아 뒀다 — 앱이 뒤로 넘어가면 아래 `AppState` 가
   * 여기를 부르고, 화면이 사라지면 `teardown()` 이 마이크를 놓는다. 그러지 않으면 화면이
   * 없는데 마이크가 계속 도는 사고가 난다.
   */
  const release = useCallback(() => {
    if (!pressingRef.current) return;
    pressingRef.current = false;
    setPressing(false);

    // 캡처가 실제로 시작됐을 때만 flush 한다. 시작도 못 한 채로 확정을 요구하지 않는다.
    const wasSending = sendingRef.current;
    sendingRef.current = false;
    if (captureRef.current) captureRef.current.stop();
    setLevel(0);
    if (wasSending && sessionRef.current) sessionRef.current.flush();
  }, []);

  // 화면을 떠나면 마이크와 스피커를 놓는다. 이것이 없으면 마이크가 계속 열려 있다.
  useEffect(
    () => () => {
      teardown();
      if (playerRef.current) playerRef.current.dispose();
      playerRef.current = null;
    },
    [teardown],
  );

  // 누른 채로 앱이 뒤로 넘어가면 `onPressOut` 이 오지 않는다. 그때도 손을 뗀 것으로 본다 —
  // 화면이 안 보이는 동안 마이크가 도는 것이 이 방식에서 가장 나쁜 실패다.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') release();
    });
    return () => subscription.remove();
  }, [release]);

  async function onConnect() {
    const client = makeClient();
    if (!client) {
      setError('서버 주소를 입력하세요.');
      return;
    }

    setError('');
    setNotices([]);
    setTurns([]);
    setReady('');
    setFrames(0);
    frameCountRef.current = 0;

    setPhase('permission');
    const denied = await requestMic();
    if (denied) {
      setError(denied);
      setPhase('idle');
      return;
    }

    setPhase('connecting');
    try {
      const config = await fetchConfig(client);
      if (onConfig) onConfig(config);
      await connect(client, config);
    } catch (err) {
      setError(errorText(err));
      teardown();
    }
  }

  async function connect(client: ApiClient, config: ServerConfig) {
    // 다시 연결할 때 앞선 재생기의 AudioContext 가 남지 않게 먼저 닫는다.
    if (playerRef.current) playerRef.current.dispose();

    // **입력 방식은 세션을 열 때 정해진다.** 설정 화면에서 고른 값을 방금 받은 응답 위에
    // 얹은 것이라, 서버가 목록을 바꿔 고른 값이 더는 없으면 고를 수 있는 값으로 물러난다.
    const modeName = chosenInputMode(config, form);
    const hold = holdsToTalk(modeName);
    setInputMode(modeName);
    setHoldToTalk(hold);
    pressingRef.current = false;
    setPressing(false);
    sendingRef.current = false;

    const player = new TtsPlayer({
      onPlayingChange: playing => {
        playingRef.current = playing;
        setLive(playing ? 'playing' : 'listening');
        // 서버는 스피커를 볼 수 없어 보낸 오디오 길이로 재생 구간을 추정한다.
        // 실제 상태를 알려주면 그 추정을 덮는다 (half_duplex 턴 정책).
        if (sessionRef.current) sessionRef.current.playback(playing ? 'start' : 'end');
      },
      onWarning: addNotice,
      onChunk: info =>
        addNotice(
          `TTS 오디오 ${info.container} ${info.sampleRate}Hz ${info.channels}ch · ${info.seconds.toFixed(2)}s`,
        ),
    });
    playerRef.current = player;

    // **설정 화면에서 고른 값이 여기로 들어온다.** 고르지 않은 것은 서버 기본값이고,
    // 빈 값은 아예 넣지 않는다 — 서버는 없는 키에만 자기 기본값을 쓴다.
    const message = streamConfig(config, form, locale);

    // 인증 헤더는 여기서 붙인다. 브라우저와 달리 앱은 WS 핸드셰이크에 헤더를 실을 수 있다.
    const headers = authHeaders(client);

    const session = openStream({
      url: streamUrl(client.baseUrl, config.stream.path),
      webSocket: (url, protocols) =>
        // RN 의 WebSocket 은 세 번째 인자로 핸드셰이크 헤더를 받는다 — 브라우저는 못 하는
        // 일이고, 그래서 웹 클라이언트는 nginx 가 인증을 주입한다. 앱은 직접 붙인다.
        //
        // 캐스팅이 여기 하나 있는 이유: RN 의 전역 WebSocket 타입 선언에 `binaryType` 이
        // 빠져 있다(런타임에는 있고, stream.ts 가 'arraybuffer' 로 세팅한다). `fetch` 쪽은
        // 캐스팅 없이 맞아떨어졌지만 이쪽은 RN 선언이 실제보다 좁다.
        new WebSocket(url, protocols, { headers }) as unknown as WebSocketLike,
      config: message,
      handlers: {
        ready: event => {
          setReady(
            [
              `session       ${event.session_id}`,
              `프로필 / 모드   ${event.profile} / ${event.mode}  (턴 ${event.turn_policy})`,
              `서버 확정 규격  ${event.audio.sample_rate}Hz ${event.audio.channels}ch` +
                ` ${event.audio.format} · ${event.audio.frame_ms}ms`,
              `VAD           ${event.vad.backend}`,
            ].join('\n'),
          );
          setLive('listening');
        },

        vad: event => {
          if (event.state === 'speech_start') {
            setLive('speaking');
            return;
          }
          // dropped 면 min_speech_ms 에 못 미쳐 버려진 것이라 파이프라인이 돌지 않는다.
          if (event.dropped) {
            addNotice('발화가 너무 짧아 버려졌다 (vad.min_speech_ms).');
            settle();
            return;
          }
          setLive('processing');
        },

        // stt.partial / llm.delta 는 지금 서버가 보내지 않는다 (2단계).
        // 핸들러를 미리 둬서 서버가 채우면 이 파일을 고치지 않아도 화면에 흐르게 한다.
        'stt.partial': event => onStt(event, true),
        'stt.final': event => onStt(event, false),
        'llm.delta': event => onLlm(event, true),
        'llm.final': event => onLlm(event, false),

        'speaker.rejected': event => {
          upsertTurn(event.seg, turn => ({ ...turn, skipped: event.reason, sourceText: '—' }));
          settle();
        },

        'tts.done': () => settle(),
        // barge_in 정책에서 사용자가 말을 시작하면 서버가 재생 중단을 지시한다.
        'tts.stop': () => player.stop(),
        cancelled: () => {
          player.stop();
          settle();
        },

        metrics: event => {
          upsertTurn(event.seg, turn => ({ ...turn, metrics: formatMetrics(event) }));
          settle();
        },

        // 서버가 세션 로케일로 렌더한 문장이다. 그대로 띄운다.
        error: event => setError(event.message),
      },
      onAudio: (chunk, audio) => player.enqueue(audio, chunk.sr),
      onWarning: addNotice,
      onSocketError: () => addNotice('WebSocket 오류. 이유는 서버의 error 이벤트나 종료 코드를 볼 것.'),
      onClose: info => {
        if (!sessionRef.current) return; // 우리가 끊은 것이다
        addNotice(`스트림이 닫혔다 (code=${info.code ?? '-'}, reason=${info.reason || '-'}).`);
        teardown();
      },
    });
    sessionRef.current = session;

    // ready 전에는 마이크를 흘려보내지 않는다 — 서버가 config 를 거절하면 소켓이 닫힌다.
    await session.whenReady();

    const capture = new MicCapture(
      {
        sampleRate: config.audio.stt_sample_rate,
        channels: config.audio.stt_channels,
        frameSamples: frameSamples(config),
      },
      {
        onFrame: frame => {
          // 누르고 말하기에서 버튼을 뗀 뒤 뒤늦게 올라온 버퍼는 여기서 멈춘다.
          if (!sendingRef.current) return;
          session.sendAudio(frame);
          frameCountRef.current += 1;
          const now = Date.now();
          if (now - levelAtRef.current < LEVEL_INTERVAL_MS) return;
          levelAtRef.current = now;
          setLevel(frameLevel(frame, LEVEL_FLOOR_DB));
          setFrames(frameCountRef.current);
        },
        onNotice: addNotice,
        onError: setError,
      },
    );
    captureRef.current = capture;

    // 여기가 두 방식이 갈리는 유일한 자리다. 누르고 말하기는 마이크를 열지 않은 채로 산다 —
    // 버튼을 누를 때 `press()` 가 연다.
    if (!hold) {
      await capture.start();
      sendingRef.current = true;
    }
    setPhase('live');
  }

  /**
   * 버튼을 눌렀다. 마이크를 열고, 열린 뒤에야 프레임을 내보낸다.
   *
   * `start()` 는 비동기라 **여는 사이에 손을 뗄 수 있다.** 그때는 열자마자 닫고 문을 열지
   * 않는다 — 그래서 짧게 눌렀다 뗀 오터치에서도 프레임이 새지 않고, 캡처가 시작도 못 한
   * 상태에서 flush 가 나가지도 않는다.
   */
  async function press() {
    if (phase !== 'live' || !holdToTalk) return;
    if (pressingRef.current) return; // 손가락이 나갔다 들어오면 onPressIn 이 다시 온다
    pressingRef.current = true;
    setPressing(true);

    const capture = captureRef.current;
    if (!capture) return;
    try {
      await capture.start();
    } catch (err) {
      // 문장은 라이브러리가 준 것을 그대로 나른다 (`MicCapture` 가 그렇게 던진다).
      setError(errorText(err));
      pressingRef.current = false;
      setPressing(false);
      capture.stop();
      return;
    }
    if (!pressingRef.current) {
      // 여는 사이에 이미 뗐다. 문은 한 번도 열리지 않았으므로 flush 도 하지 않는다.
      capture.stop();
      return;
    }
    sendingRef.current = true;
  }

  function onStt(event: SttEvent, partial: boolean) {
    upsertTurn(event.seg, turn => ({
      ...turn,
      from: event.from || turn.from,
      sourceLang: event.lang || turn.sourceLang,
      sourceText: event.text || turn.sourceText,
      partial,
    }));
  }

  /** 수신자 하나에 대한 이벤트라 `to` 는 문자열이다. delta 면 이어 붙이고 final 이면 확정한다. */
  function onLlm(event: LlmEvent, append: boolean) {
    upsertTurn(event.seg, turn => {
      const to = event.to || '';
      const deliveries = turn.deliveries.slice();
      const index = deliveries.findIndex(d => d.to === to);
      const before = index >= 0 ? (deliveries[index] as Delivery) : { to, lang: '', text: '' };
      const next: Delivery = {
        to,
        lang: event.lang || before.lang,
        text: append ? before.text + (event.text || '') : event.text || '',
      };
      if (index >= 0) deliveries[index] = next;
      else deliveries.push(next);
      return { ...turn, deliveries };
    });
  }

  const busy = phase === 'permission' || phase === 'connecting';

  /**
   * 상태 한 줄. 누르고 말하기에서 대기 중일 때는 "말해 보세요"가 거짓이 된다 —
   * 버튼을 눌러야 마이크가 열리므로 그 사실을 그대로 쓴다.
   */
  const stateLabel =
    holdToTalk && live === 'listening'
      ? pressing
        ? '듣는 중'
        : '대기 중 — 버튼을 누르고 말하세요'
      : LIVE_LABEL[live];

  return (
    <View>
      <Text style={[ui.sub, { color: colors.dim }]}>
        마이크 → PCM16 프레임 → WS → 원문 · 번역문 · 번역 음성. 규격은 전부 /v1/config 에서 온다.
      </Text>

      <View style={ui.row}>
        {phase === 'live' ? (
          <Button label="연결 끊기" onPress={teardown} disabled={false} colors={colors} tone="danger" />
        ) : (
          <Button label="통역 시작" onPress={onConnect} disabled={busy} colors={colors} />
        )}
      </View>

      {busy && (
        <View style={ui.busy}>
          <ActivityIndicator color={colors.accent} />
          <Text style={[ui.busyText, { color: colors.dim }]}>
            {phase === 'permission' ? '마이크 권한을 묻는 중…' : '서버에 연결하는 중…'}
          </Text>
        </View>
      )}

      {/*
        누르고 말하기의 버튼. 연결돼 있을 때만 나온다.

        `onPressIn`/`onPressOut` 이 누름/뗌이다. 손가락이 버튼 밖으로 미끄러지거나 스크롤이
        터치를 가져가도 `onPressOut` 은 오지만(RN 의 `Pressability`), 언마운트에서는 오지
        않는다 — 그쪽은 `release()` 의 주석대로 화면 정리에서 막는다.
      */}
      {phase === 'live' && holdToTalk && (
        <Pressable
          testID="ptt"
          onPressIn={press}
          onPressOut={release}
          style={({ pressed }) => [
            styles.ptt,
            {
              backgroundColor: pressing ? colors.good : colors.accent,
              borderColor: pressing ? colors.good : colors.border,
              opacity: pressed || pressing ? 1 : 0.9,
            },
          ]}>
          <Text style={styles.pttLabel}>
            {pressing ? '듣는 중 — 손을 떼면 번역한다' : '누르고 말하기'}
          </Text>
          <Text style={styles.pttHint}>
            {pressing
              ? '떼는 순간 지금까지 들은 것을 한 세그먼트로 확정한다'
              : '누르고 있는 동안에만 마이크가 열린다'}
          </Text>
        </Pressable>
      )}

      {phase === 'live' && (
        <View style={[ui.box, { borderColor: colors.border, backgroundColor: colors.field }]}>
          <Text style={[ui.boxTitle, { color: colors.dim }]}>상태</Text>
          <Text style={[styles.state, { color: live === 'speaking' ? colors.good : colors.fg }]}>
            {stateLabel}
          </Text>
          {/*
            어떤 입력 방식으로 열렸고 지금 버튼이 어떤 상태인지. 이름은 서버가 준 것 그대로다.
            핸즈프리에서도 방식 이름은 보여준다 — 왜 계속 듣고 있는지가 화면에 있어야 한다.
          */}
          {inputMode !== '' && (
            <Text style={[ui.mono, { color: colors.dim }]}>
              {`입력 방식 ${inputMode}${holdToTalk ? (pressing ? ' · 누르는 중' : ' · 대기 (버튼을 누르고 말한다)') : ' · 연속 캡처'}`}
            </Text>
          )}
          {/* 마이크가 실제로 듣고 있는지, 프레임이 실제로 나가고 있는지. */}
          <View style={[styles.meter, { backgroundColor: colors.border }]}>
            <View
              style={[
                styles.meterFill,
                { backgroundColor: colors.accent, width: `${Math.round(level * 100)}%` },
              ]}
            />
          </View>
          <Text style={[ui.mono, { color: colors.dim }]}>보낸 프레임 {frames}</Text>
        </View>
      )}

      {/* 서버가 준 오류 문장을 그대로. 앱은 여기에 문구를 보태지 않는다. */}
      {error !== '' && (
        <View style={[ui.box, { borderColor: colors.bad, backgroundColor: colors.badBg }]}>
          <Text style={[ui.boxTitle, { color: colors.bad }]}>오류</Text>
          <Text style={[ui.mono, { color: colors.fg }]} selectable>
            {error}
          </Text>
        </View>
      )}

      {ready !== '' && (
        <View style={[ui.box, { borderColor: colors.border, backgroundColor: colors.field }]}>
          <Text style={[ui.boxTitle, { color: colors.dim }]}>세션</Text>
          <Text style={[ui.mono, { color: colors.fg }]} selectable>
            {ready}
          </Text>
        </View>
      )}

      {turns.map(turn => (
        <View
          key={turn.seg}
          style={[ui.box, { borderColor: colors.border, backgroundColor: colors.field }]}>
          <Text style={[ui.boxTitle, { color: colors.dim }]}>
            {`SEG ${turn.seg}${turn.from ? `  ${turn.from}` : ''}${
              turn.sourceLang ? ` · ${turn.sourceLang}` : ''
            }`}
          </Text>

          {turn.skipped !== '' && (
            <Text style={[ui.mono, { color: colors.bad }]} selectable>
              {`건너뜀 — ${turn.skipped}`}
            </Text>
          )}

          <Text
            style={[styles.source, { color: colors.fg }, turn.partial ? styles.partial : null]}
            selectable>
            {turn.sourceText}
          </Text>

          {turn.deliveries.map(delivery => (
            <Text key={delivery.to} style={[styles.target, { color: colors.accent }]} selectable>
              {`→ ${delivery.to}${delivery.lang ? ` · ${delivery.lang}` : ''}\n${delivery.text || '…'}`}
            </Text>
          ))}

          {turn.metrics !== '' && (
            <Text style={[ui.mono, { color: colors.dim }]} selectable>
              {turn.metrics}
            </Text>
          )}
        </View>
      ))}

      {notices.length > 0 && (
        <View style={[ui.box, { borderColor: colors.border, backgroundColor: colors.field }]}>
          <Text style={[ui.boxTitle, { color: colors.dim }]}>기록</Text>
          {notices.map(notice => (
            <Text key={notice} style={[ui.mono, { color: colors.dim }]} selectable>
              {notice}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

/* ---- 이 화면에만 있는 모양 --------------------------------------------------- */

const styles = StyleSheet.create({
  state: { fontSize: 16, fontWeight: '600', marginBottom: 8 },
  /** 손가락으로 눌러야 하는 버튼이라 크게 둔다. 누르는 동안 색이 바뀐다. */
  ptt: {
    marginTop: 16,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 26,
    alignItems: 'center',
    gap: 6,
  },
  pttLabel: { color: '#ffffff', fontSize: 17, fontWeight: '700' },
  pttHint: { color: '#ffffff', fontSize: 12, opacity: 0.85 },
  meter: { height: 6, borderRadius: 3, overflow: 'hidden', marginBottom: 8 },
  meterFill: { height: 6 },
  source: { fontSize: 16, lineHeight: 23, marginTop: 2 },
  /** stt.partial 로 들어온 중간 결과는 흐리게 — 아직 확정이 아니라는 표시다. */
  partial: { opacity: 0.6 },
  target: { fontSize: 16, lineHeight: 23, marginTop: 8 },
});
