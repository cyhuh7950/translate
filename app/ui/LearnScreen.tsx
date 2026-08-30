/**
 * 언어 학습 세션 화면 (`DESIGN.md` §15, `PLAN_LANG_LEARN.md` 앱 작업 4번).
 *
 * 흐름은 `orchestrator/app/modules/lang_learn/session.py` 그대로다.
 *
 *   WS 접속(`/v1/config` 의 `lang_learn.stream.path`) → start(user_id, count) → ready
 *   → problem(반복: repeat 는 TTS 오디오 + `show_text_for_repeat` 설정에 따라 텍스트,
 *     compose 는 텍스트만) → 답변(음성 또는 텍스트) → answer.received → feedback(있으면)
 *   → … count 만큼 반복 … → session.summary(있으면) → session.done
 *
 * **번역 스트림(`LiveScreen`)과 프로토콜이 다르다.** 여기는 세그먼트를 계속 흘리는 것이
 * 아니라 문제 하나에 답 하나가 오가는 요청-응답이라, 음성 답변도 프레임을 실시간으로
 * 보내지 않고 녹음이 끝난 뒤 한 번에(WAV로 감싸) 보낸다 — `src/api/langlearn.ts` 와
 * `audio/pcm.ts` 의 `encodeWav` 를 볼 것.
 *
 * **학습 로그인이 먼저다.** `user` 가 없으면(`LoginScreen` 에서 로그인 전) 세션을 열 수
 * 없다 — 번역 기능과 달리 이 화면은 그 계정으로 스코프된다.
 */

import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { PermissionsAndroid, Platform } from 'react-native';

import { MicCapture } from '../audio/capture';
import { encodeWav } from '../audio/pcm';
import { TtsPlayer } from '../audio/playback';
import {
  authHeaders,
  fetchConfig,
  getLangLearnSettings,
  openLangLearnStream,
  streamUrl,
} from '../src/api';
import type {
  ApiClient,
  LangLearnConfigView,
  LangLearnEventOf,
  LangLearnSession,
  LangLearnSettings,
  ServerConfig,
  WebSocketLike,
} from '../src/api';
import type { LoggedInUser } from './LoginScreen';
import { Button } from './Button';
import { ui } from './theme';
import type { Palette } from './theme';

/** 끝난 문제 하나 — 이력 표시용. `grade` 가 빈 문자열이면 이 세션은 요약만 준다. */
interface HistoryItem {
  idx: number;
  answerType: string;
  problemText: string;
  answerDisplay: string;
  grade: string;
  comment: string;
}

type Phase = 'idle' | 'connecting' | 'active' | 'finished';

/** `LiveScreen`/`FaceToFaceScreen` 의 것과 같은 문구 — 안드로이드에서만 물어본다. */
async function requestMic(): Promise<string | null> {
  if (Platform.OS !== 'android') return null;
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
    title: '마이크 권한',
    message: '음성으로 답하려면 마이크가 필요하다.',
    buttonPositive: '허용',
    buttonNegative: '거부',
  });
  if (result === PermissionsAndroid.RESULTS.GRANTED) return null;
  if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
    return '마이크 권한이 "다시 묻지 않음"으로 거부돼 있다. 기기의 설정 → 앱 → 권한에서 직접 켜야 한다.';
  }
  return '마이크 권한이 거부됐다. 텍스트로 답하거나 권한을 허용해야 한다.';
}

export function LearnScreen({
  colors,
  makeClient,
  locale,
  errorText,
  user,
  onConfig,
}: {
  colors: Palette;
  makeClient: () => ApiClient | null;
  locale: string;
  errorText: (err: unknown) => string;
  /** 학습 로그인 계정. 없으면 세션을 열 수 없다. */
  user: LoggedInUser | null;
  onConfig?: (config: ServerConfig) => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [countInput, setCountInput] = useState('');
  const [settings, setSettings] = useState<LangLearnSettings | null>(null);

  const [total, setTotal] = useState(0);
  const [level, setLevel] = useState('');
  const [targetLang, setTargetLang] = useState('');
  const [feedbackMode, setFeedbackMode] = useState('');

  const [problem, setProblem] = useState<LangLearnEventOf<'problem'> | null>(null);
  const [answerText, setAnswerText] = useState('');
  const [waiting, setWaiting] = useState(false); // 답을 보내고 채점을 기다리는 중
  const [feedback, setFeedback] = useState<LangLearnEventOf<'feedback'> | null>(null);
  const [summary, setSummary] = useState<LangLearnEventOf<'session.summary'> | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [recording, setRecording] = useState(false);

  const sessionRef = useRef<LangLearnSession | null>(null);
  const playerRef = useRef<TtsPlayer | null>(null);
  const captureRef = useRef<MicCapture | null>(null);
  const recordedRef = useRef<Int16Array[]>([]);
  const audioSpecRef = useRef<{ sampleRate: number; channels: number } | null>(null);
  /** feedback 이 안 오는 모드(summary 전용)에서, 다음 문제가 오기 전에 이력에 채워 넣을 것. */
  const pendingRef = useRef<{ problem: LangLearnEventOf<'problem'>; answerDisplay: string } | null>(null);

  const flushPending = useCallback((grade: string, comment: string) => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    setHistory(prev => [
      {
        idx: pending.problem.idx,
        answerType: pending.problem.answer_type,
        problemText: pending.problem.text,
        answerDisplay: pending.answerDisplay,
        grade,
        comment,
      },
      ...prev,
    ]);
  }, []);

  const teardown = useCallback(() => {
    if (captureRef.current) {
      captureRef.current.stop();
      captureRef.current = null;
    }
    if (playerRef.current) {
      playerRef.current.dispose();
      playerRef.current = null;
    }
    // 먼저 비우고 나서 닫는다 — `close()` 가 `onclose` 를 동기로 부르는 소켓(테스트의
    // 가짜 소켓이 그렇다)에서도, 그 핸들러가 "우리가 닫은 것"과 진짜 예기치 않은 종료를
    // `sessionRef.current` 로 구분하기 때문이다.
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) session.close();
    setRecording(false);
    setWaiting(false);
  }, []);

  async function onStart() {
    if (phase === 'connecting' || phase === 'active') return;
    const client = makeClient();
    if (!client) {
      setError('서버 주소를 입력하세요.');
      return;
    }
    if (!user) {
      setError('먼저 "학습 로그인" 탭에서 로그인하세요.');
      return;
    }

    setError('');
    setProblem(null);
    setFeedback(null);
    setSummary(null);
    setHistory([]);
    pendingRef.current = null;
    setPhase('connecting');

    try {
      const config = await fetchConfig(client);
      if (onConfig) onConfig(config);
      const langLearn = config.lang_learn;
      if (!langLearn) throw new Error('서버가 언어 학습 기능(lang_learn)을 지원하지 않는다.');

      const userSettings = await getLangLearnSettings(client, user.id);
      setSettings(userSettings);
      audioSpecRef.current = { sampleRate: config.audio.stt_sample_rate, channels: config.audio.stt_channels };

      const denied = await requestMic();
      // 권한이 없어도 세션은 연다 — 텍스트로 답할 수 있으니 마이크 권한이 필수는 아니다.
      if (denied) setError(denied);

      connect(client, langLearn, user, countInput.trim());
    } catch (err) {
      setError(errorText(err));
      setPhase('idle');
    }
  }

  function connect(
    client: ApiClient,
    langLearn: LangLearnConfigView,
    loggedIn: LoggedInUser,
    countText: string,
  ) {
    const parsedCount = Number.parseInt(countText, 10);
    const count = Number.isFinite(parsedCount) && parsedCount > 0 ? parsedCount : undefined;

    const player = new TtsPlayer({
      onWarning: message => setError(message),
    });
    playerRef.current = player;

    const headers = authHeaders(client);
    const session = openLangLearnStream({
      url: streamUrl(client.baseUrl, langLearn.stream.path),
      webSocket: (url, protocols) =>
        new WebSocket(url, protocols, { headers }) as unknown as WebSocketLike,
      start: { type: 'start', user_id: loggedIn.id, count, locale },
      handlers: {
        ready: event => {
          setTotal(event.total);
          setLevel(event.level);
          setTargetLang(event.target_lang);
          setFeedbackMode(event.feedback_mode);
          setPhase('active');
        },
        problem: event => {
          // summary 전용 모드에서는 feedback 이 안 오므로, 다음 문제가 뜨기 전에 지난
          // 문제를 등급 없이 이력에 채워 넣는다.
          flushPending('', '');
          setProblem(event);
          setWaiting(false);
          setFeedback(null);
          setAnswerText('');
        },
        'answer.received': () => setWaiting(true),
        feedback: event => {
          setFeedback(event);
          flushPending(event.grade, event.comment);
          setWaiting(false);
        },
        'session.summary': event => {
          flushPending('', '');
          setSummary(event);
        },
        'session.done': () => {
          flushPending('', '');
          setPhase('finished');
          teardown();
        },
        error: event => {
          setError(event.message);
          teardown();
          setPhase('idle');
        },
      },
      onAudio: (_problemEvent, audio) => {
        if (playerRef.current) playerRef.current.enqueue(audio, null);
      },
      onSocketError: () => setError('WebSocket 오류가 났다.'),
      onWarning: () => {},
      onClose: info => {
        if (!sessionRef.current) return; // 우리가 닫은 것이다
        setError(`세션이 닫혔다 (code=${info.code ?? '-'}, reason=${info.reason || '-'}).`);
        teardown();
        setPhase('idle');
      },
    });
    sessionRef.current = session;
  }

  function onStop() {
    teardown();
    setPhase('idle');
  }

  function submitText() {
    const session = sessionRef.current;
    const current = problem;
    if (!session || !current || waiting) return;
    const text = answerText.trim();
    if (!text) return;
    pendingRef.current = { problem: current, answerDisplay: text };
    session.answerText(current.idx, text);
    setWaiting(true);
  }

  async function startRecording() {
    if (recording || waiting || !problem) return;
    const spec = audioSpecRef.current;
    if (!spec) return;
    const denied = await requestMic();
    if (denied) {
      setError(denied);
      return;
    }
    setError('');
    recordedRef.current = [];
    const capture = new MicCapture(
      {
        sampleRate: spec.sampleRate,
        channels: spec.channels,
        frameSamples: Math.round(spec.sampleRate * 0.1), // 100ms 단위 — 실시간 전송이 아니라 모았다 보내므로 길이가 자유롭다
      },
      {
        onFrame: frame => recordedRef.current.push(new Int16Array(frame)),
        onNotice: () => {},
        onError: setError,
      },
    );
    captureRef.current = capture;
    try {
      await capture.start();
    } catch (err) {
      setError(errorText(err));
      captureRef.current = null;
      return;
    }
    setRecording(true);
  }

  function stopRecording() {
    const capture = captureRef.current;
    captureRef.current = null;
    setRecording(false);
    if (capture) capture.stop();

    const spec = audioSpecRef.current;
    const session = sessionRef.current;
    const current = problem;
    const frames = recordedRef.current;
    recordedRef.current = [];
    if (!spec || !session || !current || frames.length === 0) return;

    const totalSamples = frames.reduce((sum, f) => sum + f.length, 0);
    const pcm = new Int16Array(totalSamples);
    let at = 0;
    for (const frame of frames) {
      pcm.set(frame, at);
      at += frame.length;
    }
    const wav = encodeWav(pcm, spec.sampleRate, spec.channels);
    const durationS = totalSamples / spec.sampleRate;

    pendingRef.current = { problem: current, answerDisplay: '(음성 답변)' };
    session.answerAudio(current.idx, wav, 'audio/wav', durationS);
    setWaiting(true);
  }

  if (!user) {
    return (
      <View>
        <Text style={[ui.sub, { color: colors.dim }]}>
          언어 학습 세션은 학습 로그인 계정으로 스코프된다. 먼저 "학습 로그인" 탭에서
          로그인해야 이 화면을 쓸 수 있다.
        </Text>
      </View>
    );
  }

  const busy = phase === 'connecting';

  return (
    <View>
      <Text style={[ui.sub, { color: colors.dim }]}>
        WS 접속 → 문제 → 답변(음성/텍스트) → 피드백을 count 만큼 반복한다. 경로·기본
        문제 수는 전부 /v1/config 의 lang_learn 섹션에서 온다.
      </Text>

      {phase === 'idle' && (
        <View>
          <Text style={[ui.label, { color: colors.dim }]}>문제 수 (비우면 서버 기본값)</Text>
          <TextInput
            style={[ui.input, { color: colors.fg, borderColor: colors.border, backgroundColor: colors.field }]}
            value={countInput}
            onChangeText={setCountInput}
            placeholder={settings ? String(settings.schedule[0]?.count ?? '') : ''}
            placeholderTextColor={colors.dim}
            keyboardType="number-pad"
          />
          <View style={ui.row}>
            <Button label="학습 시작" onPress={onStart} disabled={busy} colors={colors} />
          </View>
        </View>
      )}

      {busy && (
        <View style={ui.busy}>
          <ActivityIndicator color={colors.accent} />
          <Text style={[ui.busyText, { color: colors.dim }]}>서버에 연결하는 중…</Text>
        </View>
      )}

      {(phase === 'active' || phase === 'finished') && (
        <View style={ui.row}>
          <Button label="세션 중단" onPress={onStop} disabled={false} colors={colors} tone="danger" />
        </View>
      )}

      {phase === 'active' && total > 0 && (
        <View style={[ui.box, { borderColor: colors.border, backgroundColor: colors.field }]}>
          <Text style={[ui.boxTitle, { color: colors.dim }]}>세션</Text>
          <Text style={[ui.mono, { color: colors.fg }]}>
            {`총 ${total}문제 · ${targetLang} · 난이도 ${level} · 피드백 ${feedbackMode}`}
          </Text>
        </View>
      )}

      {problem && (
        <View style={[ui.box, { borderColor: colors.border, backgroundColor: colors.field }]}>
          <Text style={[ui.boxTitle, { color: colors.dim }]}>
            {`문제 ${problem.idx + 1}/${problem.total} · ${problem.answer_type === 'repeat' ? '듣고 따라 말하기' : '뜻 보고 작문하기'}`}
          </Text>
          {(problem.answer_type === 'compose' || (settings?.show_text_for_repeat ?? false)) && (
            <Text style={[styles.problemText, { color: colors.fg }]} selectable>
              {problem.text}
            </Text>
          )}
          {problem.answer_type === 'repeat' && !(settings?.show_text_for_repeat ?? false) && (
            <Text style={[ui.mono, { color: colors.dim }]}>텍스트는 숨김 — 들리는 대로 따라 말한다.</Text>
          )}

          {waiting ? (
            <View style={ui.busy}>
              <ActivityIndicator color={colors.accent} />
              <Text style={[ui.busyText, { color: colors.dim }]}>채점하는 중…</Text>
            </View>
          ) : (
            <View>
              <Pressable
                onPress={recording ? stopRecording : startRecording}
                style={({ pressed }) => [
                  styles.recordButton,
                  {
                    backgroundColor: recording ? colors.bad : colors.accent,
                    opacity: pressed ? 0.8 : 1,
                  },
                ]}>
                <Text style={styles.recordLabel}>
                  {recording ? '녹음 종료 (답변 전송)' : '녹음 시작 (음성으로 답하기)'}
                </Text>
              </Pressable>

              <Text style={[ui.label, { color: colors.dim }]}>또는 텍스트로 답하기</Text>
              <TextInput
                style={[
                  ui.input,
                  ui.multiline,
                  { color: colors.fg, borderColor: colors.border, backgroundColor: colors.field },
                ]}
                value={answerText}
                onChangeText={setAnswerText}
                placeholder="답을 입력…"
                placeholderTextColor={colors.dim}
                multiline
                editable={!recording}
              />
              <View style={ui.row}>
                <Button
                  label="답변 제출"
                  onPress={submitText}
                  disabled={recording || answerText.trim() === ''}
                  colors={colors}
                />
              </View>
            </View>
          )}
        </View>
      )}

      {feedback && (
        <View style={[ui.box, { borderColor: colors.border, backgroundColor: colors.field }]}>
          <Text style={[ui.boxTitle, { color: colors.dim }]}>피드백</Text>
          <Text style={[styles.grade, { color: colors.accent }]}>{feedback.grade}</Text>
          <Text style={[ui.mono, { color: colors.fg }]} selectable>
            {feedback.comment}
          </Text>
        </View>
      )}

      {summary && (
        <View style={[ui.box, { borderColor: colors.good, backgroundColor: colors.field }]}>
          <Text style={[ui.boxTitle, { color: colors.good }]}>총평</Text>
          <Text style={[styles.grade, { color: colors.good }]}>{summary.grade}</Text>
          <Text style={[ui.mono, { color: colors.fg }]} selectable>
            {summary.comment}
          </Text>
        </View>
      )}

      {phase === 'finished' && (
        <Text style={[ui.sub, styles.finishedNote, { color: colors.dim }]}>
          세션이 끝났다 ("session.done"). 다시 시작하려면 위에서 "학습 시작"을 누른다.
        </Text>
      )}

      {error !== '' && (
        <View style={[ui.box, { borderColor: colors.bad, backgroundColor: colors.badBg }]}>
          <Text style={[ui.boxTitle, { color: colors.bad }]}>오류</Text>
          <Text style={[ui.mono, { color: colors.fg }]} selectable>
            {error}
          </Text>
        </View>
      )}

      {history.length > 0 && (
        <View style={[ui.box, { borderColor: colors.border, backgroundColor: colors.field }]}>
          <Text style={[ui.boxTitle, { color: colors.dim }]}>지난 문제</Text>
          {history.map(item => (
            <View key={item.idx} style={styles.historyItem}>
              <Text style={[ui.mono, { color: colors.dim }]}>
                {`#${item.idx + 1} (${item.answerType})${item.grade ? ` · ${item.grade}` : ''}`}
              </Text>
              <Text style={[ui.mono, { color: colors.fg }]} selectable>
                {item.problemText}
              </Text>
              <Text style={[ui.mono, { color: colors.accent }]} selectable>
                {`→ ${item.answerDisplay}`}
              </Text>
              {item.comment !== '' && (
                <Text style={[ui.mono, { color: colors.dim }]} selectable>
                  {item.comment}
                </Text>
              )}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  problemText: { fontSize: 18, lineHeight: 25, marginTop: 4, marginBottom: 8 },
  recordButton: { borderRadius: 8, paddingVertical: 13, alignItems: 'center', marginTop: 8 },
  recordLabel: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  grade: { fontSize: 20, fontWeight: '700', marginBottom: 4 },
  historyItem: { marginTop: 8, gap: 2 },
  finishedNote: { marginTop: 12 },
});
