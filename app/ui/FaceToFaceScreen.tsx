/**
 * 통역모드 — 마주 보고 쓰는 화면.
 *
 * 기기를 테이블에 눕혀두고 두 사람이 마주 앉아 쓴다. 위쪽 절반은 180도 돌려 그려서
 * 맞은편 사람이 제 방향으로 읽는다. 아래쪽 절반이 "나"다.
 *
 *   위(상대)      영어 텍스트가 거꾸로 그려진다 — 상대가 보기엔 똑바로다
 *   ────────────────────────────────
 *   아래(나)      한국어 텍스트가 똑바로 그려진다
 *   언어설정   한국어 ⇄ 영어
 *
 * **말하는 쪽을 어떻게 아는가.** 서버는 세션을 열 때(`config` 메시지) 딱 한 번 발화자를
 * 정하고, 세션 도중에 바꿀 메시지가 없다(`control` 은 flush/cancel/playback 뿐).
 * 그래서 이 화면은 **누른 쪽이 바뀔 때마다 세션을 다시 연다** — `oneway` 프로필을
 * source/target 언어를 맞바꿔 새로 여는 것뿐이라 서버를 고칠 필요가 없다. 같은 쪽을
 * 연달아 누르면 세션을 그대로 두고 캡처만 다시 연다(`LiveScreen` 의 PTT 와 같다).
 *
 * **자동(목소리로 화자 구분)은 아직 없다.** 서버에 `twoway_voice` 프로필이 이미 있지만
 * 화자 등록(voice print)이 앱에 없어 이번 범위에서는 뺐다 — 다음 차례.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { PermissionsAndroid, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { MicCapture } from '../audio/capture';
import { TtsPlayer } from '../audio/playback';
import { authHeaders, fetchConfig, frameSamples, openStream, streamUrl } from '../src/api';
import type { ApiClient, ModelsResponse, ServerConfig, StreamSession, WebSocketLike } from '../src/api';
import { chosenLanguages, streamConfig } from './settings';
import type { Settings } from './settings';
import { ui } from './theme';
import type { Palette } from './theme';

type Side = 'top' | 'bottom';
type Phase = 'idle' | 'permission' | 'connecting' | 'ready' | 'live';

/** 마이크 권한. `LiveScreen.tsx` 의 것과 같다 — 화면마다 문구를 다시 짓지 않는다. */
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

function otherSide(side: Side): Side {
  return side === 'top' ? 'bottom' : 'top';
}

export function FaceToFaceScreen({
  colors,
  makeClient,
  locale,
  errorText,
  form,
  models = null,
  onConfig,
}: {
  colors: Palette;
  makeClient: () => ApiClient | null;
  locale: string;
  errorText: (err: unknown) => string;
  /** 설정 화면에서 고른 언어를 처음 열 때 한 번 가져온다 (§10 과 같은 기본값 규칙). */
  form: Settings;
  models?: ModelsResponse | null;
  onConfig?: (config: ServerConfig) => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [pressingSide, setPressingSide] = useState<Side | null>(null);
  const [error, setError] = useState('');
  const [lang, setLang] = useState<{ top: string; bottom: string }>({ top: '', bottom: '' });
  const [text, setText] = useState<{ top: string; bottom: string }>({ top: '', bottom: '' });
  /**
   * 상대에게 나간 번역문 — 말한 쪽 자신에게도 작게 보여준다("내 말이 이렇게 전달됐다"
   * 확인용). 듣는 쪽의 큰 텍스트(`text`)와 같은 값이지만 표시 크기·위치가 다르다.
   */
  const [translated, setTranslated] = useState<{ top: string; bottom: string }>({ top: '', bottom: '' });

  const sessionRef = useRef<StreamSession | null>(null);
  const captureRef = useRef<MicCapture | null>(null);
  const playerRef = useRef<TtsPlayer | null>(null);
  const pressingRef = useRef<Side | null>(null);
  const sendingRef = useRef(false);
  /** 지금 열려 있는 세션이 발화자로 삼은 쪽. null 이면 세션이 없다. */
  const speakerSideRef = useRef<Side | null>(null);
  const langRef = useRef({ top: '', bottom: '' });
  const langsResolvedRef = useRef(false);

  const setSideText = useCallback((side: Side, value: string) => {
    setText(prev => ({ ...prev, [side]: value }));
  }, []);

  const teardownSession = useCallback(() => {
    sendingRef.current = false;
    if (captureRef.current) {
      captureRef.current.stop();
      captureRef.current = null;
    }
    if (playerRef.current) playerRef.current.dispose();
    playerRef.current = null;
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    speakerSideRef.current = null;
  }, []);

  // 화면을 떠나면 마이크와 세션을 놓는다 — LiveScreen 과 같은 이유다.
  useEffect(() => teardownSession, [teardownSession]);

  /** 발화자가 `side` 인 세션을 새로 연다. 기존 세션이 있으면 먼저 닫는다. */
  async function openSessionFor(client: ApiClient, side: Side): Promise<void> {
    teardownSession();

    const config = await fetchConfig(client);
    if (onConfig) onConfig(config);

    if (!langsResolvedRef.current) {
      const chosen = chosenLanguages(config, form);
      langRef.current = { bottom: chosen.source, top: chosen.target };
      setLang(langRef.current);
      langsResolvedRef.current = true;
    }

    const speakerLang = langRef.current[side];
    const listenerLang = langRef.current[otherSide(side)];
    const listener = otherSide(side);

    const player = new TtsPlayer({
      onPlayingChange: playing => {
        if (sessionRef.current) sessionRef.current.playback(playing ? 'start' : 'end');
      },
      onWarning: () => {},
      onChunk: () => {},
    });
    playerRef.current = player;

    // 설정 화면에서 고른 엔진·프로바이더·모델은 그대로 쓴다 — 프로필과 언어만
    // 이 화면이 덮어쓴다(둘 다 이 화면 고유의 규칙이라 `form` 에 넣어두지 않는다).
    const message = {
      ...streamConfig(config, form, locale, models),
      source_lang: speakerLang,
      target_lang: listenerLang,
      profile: 'oneway',
    };
    const headers = authHeaders(client);

    const session = openStream({
      url: streamUrl(client.baseUrl, config.stream.path),
      webSocket: (url, protocols) =>
        new WebSocket(url, protocols, { headers }) as unknown as WebSocketLike,
      config: message,
      handlers: {
        'stt.final': event => setSideText(side, event.text || ''),
        'llm.final': event => {
          setSideText(listener, event.text || '');
          setTranslated(prev => ({ ...prev, [side]: event.text || '' }));
        },
        'speaker.rejected': event => setError(`건너뜀 — ${event.reason}`),
        error: event => setError(event.message),
      },
      onAudio: (chunk, audio) => player.enqueue(audio, chunk.sr),
      onWarning: () => {},
      onSocketError: () => setError('WebSocket 오류가 났다.'),
      onClose: info => {
        if (!sessionRef.current) return; // 우리가 닫은 것이다
        setError(`스트림이 닫혔다 (code=${info.code ?? '-'}, reason=${info.reason || '-'}).`);
        teardownSession();
        setPhase('idle');
      },
    });
    sessionRef.current = session;
    speakerSideRef.current = side;

    await session.whenReady();

    const capture = new MicCapture(
      {
        sampleRate: config.audio.stt_sample_rate,
        channels: config.audio.stt_channels,
        frameSamples: frameSamples(config),
      },
      {
        onFrame: frame => {
          if (!sendingRef.current) return;
          session.sendAudio(frame);
        },
        onNotice: () => {},
        onError: setError,
      },
    );
    captureRef.current = capture;
  }

  async function onPressIn(side: Side) {
    if (pressingRef.current) return; // 이미 한쪽을 누르고 있다
    pressingRef.current = side;
    setPressingSide(side);
    setError('');

    const client = makeClient();
    if (!client) {
      setError('서버 주소를 입력하세요.');
      pressingRef.current = null;
      setPressingSide(null);
      return;
    }

    if (phase === 'idle') {
      setPhase('permission');
      const denied = await requestMic();
      if (denied) {
        setError(denied);
        setPhase('idle');
        pressingRef.current = null;
        setPressingSide(null);
        return;
      }
    }

    if (speakerSideRef.current !== side) {
      setPhase('connecting');
      try {
        await openSessionFor(client, side);
      } catch (err) {
        setError(errorText(err));
        setPhase('idle');
        pressingRef.current = null;
        setPressingSide(null);
        return;
      }
    }

    if (pressingRef.current !== side) {
      // 여는 사이에 이미 뗐다.
      return;
    }

    const capture = captureRef.current;
    if (!capture) return;
    try {
      await capture.start();
    } catch (err) {
      setError(errorText(err));
      pressingRef.current = null;
      setPressingSide(null);
      return;
    }
    if (pressingRef.current !== side) {
      capture.stop();
      return;
    }
    sendingRef.current = true;
    setPhase('live');
  }

  function onPressOut(side: Side) {
    if (pressingRef.current !== side) return;
    pressingRef.current = null;
    setPressingSide(null);

    const wasSending = sendingRef.current;
    sendingRef.current = false;
    if (captureRef.current) captureRef.current.stop();
    if (wasSending && sessionRef.current) sessionRef.current.flush();
    setPhase(sessionRef.current ? 'ready' : 'idle');
  }

  const busy = phase === 'permission' || phase === 'connecting';
  const langFor = (side: Side) => lang[side] || (side === 'bottom' ? '…' : '…');

  return (
    <View style={styles.root}>
      <Pane
        side="top"
        text={text.top}
        translated={translated.top}
        pressing={pressingSide === 'top'}
        busy={busy && pressingSide === 'top'}
        disabled={busy && pressingSide !== 'top'}
        colors={colors}
        onPressIn={() => onPressIn('top')}
        onPressOut={() => onPressOut('top')}
      />

      <Pressable
        testID="lang-swap"
        style={[styles.footer, { borderColor: colors.border, backgroundColor: colors.field }]}
        onPress={() => {
          if (phase === 'live' || busy) return; // 대화 중에는 언어를 바꾸지 않는다
          setLang(prev => {
            const swapped = { top: prev.bottom, bottom: prev.top };
            langRef.current = swapped;
            return swapped;
          });
        }}>
        <Text style={[ui.mono, { color: colors.dim }]}>
          {`언어설정   ${langFor('bottom')} ⇄ ${langFor('top')}`}
        </Text>
      </Pressable>

      {error !== '' && (
        <View style={[styles.errorBox, { borderColor: colors.bad, backgroundColor: colors.badBg }]}>
          <Text style={[ui.mono, { color: colors.bad }]} selectable>
            {error}
          </Text>
        </View>
      )}

      <Pane
        side="bottom"
        text={text.bottom}
        translated={translated.bottom}
        pressing={pressingSide === 'bottom'}
        busy={busy && pressingSide === 'bottom'}
        disabled={busy && pressingSide !== 'bottom'}
        colors={colors}
        onPressIn={() => onPressIn('bottom')}
        onPressOut={() => onPressOut('bottom')}
      />
    </View>
  );
}

/** 화면 반쪽. `side="top"` 이면 180도 돌려 그린다. */
function Pane({
  side,
  text,
  translated,
  pressing,
  busy,
  disabled,
  colors,
  onPressIn,
  onPressOut,
}: {
  side: Side;
  text: string;
  /** 이 쪽이 말해서 상대에게 나간 번역문. 없으면(아직 말한 적 없으면) 아무것도 안 그린다. */
  translated: string;
  pressing: boolean;
  busy: boolean;
  disabled: boolean;
  colors: Palette;
  onPressIn: () => void;
  onPressOut: () => void;
}) {
  return (
    <Pressable
      testID={`pane:${side}`}
      style={[
        styles.pane,
        side === 'top' ? styles.rotated : null,
        {
          backgroundColor: pressing ? colors.field : colors.bg,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
      onPressIn={onPressIn}
      onPressOut={onPressOut}>
      <Text style={[styles.hint, { color: colors.dim }]}>
        {busy ? '연결하는 중…' : pressing ? '듣는 중 — 손을 떼면 번역한다' : '누르고 말하기'}
      </Text>
      <Text style={[styles.paneText, { color: colors.fg }]} selectable>
        {text || '…'}
      </Text>
      {translated !== '' && (
        <Text style={[styles.translatedText, { color: colors.dim }]} selectable>
          {`→ ${translated}`}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  pane: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20, gap: 10 },
  rotated: { transform: [{ rotate: '180deg' }] },
  hint: { fontSize: 12 },
  paneText: { fontSize: 22, lineHeight: 30, textAlign: 'center' },
  translatedText: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
  footer: { borderTopWidth: 1, borderBottomWidth: 1, paddingVertical: 10, alignItems: 'center' },
  errorBox: { borderWidth: 1, padding: 10 },
});
