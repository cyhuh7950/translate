/**
 * 실시간 통역 화면 — 마이크로 말하면 번역된 음성이 나온다.
 *
 * 웹 클라이언트(`web/static/app.js` 의 handsfree 입력 방식)가 하는 일을 앱으로 옮긴 것이다.
 * 흐름은 웹과 같다.
 *
 *   권한 → GET /v1/config → WS 열기(config 전송) → ready → 마이크 캡처 시작
 *        → PCM16 20ms 프레임 …  → vad / stt / llm / tts.chunk(+오디오) / metrics
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
  PermissionsAndroid,
  Platform,
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
  StreamConfigMessage,
  StreamSession,
  WebSocketLike,
} from '../src/api';
import { Button } from './Button';
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
}: {
  colors: Palette;
  makeClient: () => ApiClient | null;
  locale: string;
  errorText: (err: unknown) => string;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [live, setLive] = useState<Live>('listening');
  const [ready, setReady] = useState('');
  const [error, setError] = useState('');
  const [notices, setNotices] = useState<string[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [level, setLevel] = useState(0);
  const [frames, setFrames] = useState(0);

  const sessionRef = useRef<StreamSession | null>(null);
  const captureRef = useRef<MicCapture | null>(null);
  const playerRef = useRef<TtsPlayer | null>(null);
  const playingRef = useRef(false);
  const frameCountRef = useRef(0);
  const levelAtRef = useRef(0);

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

  // 화면을 떠나면 마이크와 스피커를 놓는다. 이것이 없으면 마이크가 계속 열려 있다.
  useEffect(
    () => () => {
      teardown();
      if (playerRef.current) playerRef.current.dispose();
      playerRef.current = null;
    },
    [teardown],
  );

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
      await connect(client, config);
    } catch (err) {
      setError(errorText(err));
      teardown();
    }
  }

  async function connect(client: ApiClient, config: ServerConfig) {
    // 다시 연결할 때 앞선 재생기의 AudioContext 가 남지 않게 먼저 닫는다.
    if (playerRef.current) playerRef.current.dispose();

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

    // 빈 값은 넣지 않는다 — 서버는 없는 키에만 자기 기본값을 쓴다.
    const message: StreamConfigMessage = {
      type: 'config',
      source_lang: config.session.default_source_lang,
      target_lang: config.session.default_target_lang,
      sample_rate: config.audio.stt_sample_rate,
    };
    if (locale) message.locale = locale;

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
    await capture.start();
    setPhase('live');
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

      {phase === 'live' && (
        <View style={[ui.box, { borderColor: colors.border, backgroundColor: colors.field }]}>
          <Text style={[ui.boxTitle, { color: colors.dim }]}>상태</Text>
          <Text style={[styles.state, { color: live === 'speaking' ? colors.good : colors.fg }]}>
            {LIVE_LABEL[live]}
          </Text>
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
  meter: { height: 6, borderRadius: 3, overflow: 'hidden', marginBottom: 8 },
  meterFill: { height: 6 },
  source: { fontSize: 16, lineHeight: 23, marginTop: 2 },
  /** stt.partial 로 들어온 중간 결과는 흐리게 — 아직 확정이 아니라는 표시다. */
  partial: { opacity: 0.6 },
  target: { fontSize: 16, lineHeight: 23, marginTop: 8 },
});
