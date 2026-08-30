/**
 * STT 학습(개인화) 화면 — `PLAN_STT_PERSONALIZATION.md` 0단계 앱 작업(0-A1~0-A4).
 *
 * **번역/언어학습과 목적이 다르다.** 이건 외국어 실력을 늘리는 화면이 아니라, 이 계정을
 * 쓰는 사람 목소리에 STT(음성 인식)를 맞추기 위해 데이터를 모으는 화면이다 — 그래서
 * "학습 세션"(외국어 문제풀이) 쪽이 아니라 "학습 로그인"과 같은 계정 단위 탭 묶음에 둔다
 * (서버쪽 권고, `MESSAGE_TO_APP.md` 2026-08-30 2차 답변).
 *
 * 두 갈래를 한 화면 안에서 전환한다.
 *
 *   낭독 교정   서버가 준 문장을 그대로 읽고 녹음 → 업로드 → (문장, 음성) 정답쌍으로 저장
 *   정오 판정   자유롭게 말한 음성을 녹음 → 업로드 → STT 인식 결과를 보고 맞다/틀리다
 *              판정 → 틀리면 정답 텍스트 입력(필수, §16 — 정답 없는 "틀렸다"는 안 받는다)
 *
 * ⚠️ **서버 API가 아직 없다**(2026-08-30 시점). `src/api/stt_training.ts` 의 계약은
 * 계획서 문장을 그대로 코드로 옮긴 추정치다 — 실제로 붙여보고 어긋나면 그 파일과
 * `src/api/types.ts` 만 고치면 되고, 이 화면은 그대로 두어도 되게 그 계층 뒤에 숨겼다.
 *
 * 녹음은 `ui/LearnScreen.tsx` 의 음성 답변과 같은 방식이다 — 실시간 스트리밍이 아니라
 * 한 번의 발화를 통째로 모았다가 WAV 로 감싼다. 다만 나르는 방식은 다르다 — `lang_learn`
 * 은 WS 바이너리 프레임이지만 여기는 HTTP 라서 JSON+base64 로 보낸다(RN 의 `FormData`
 * 가 메모리 바이너리를 직접 못 담는다 — `src/api/stt_training.ts` 상단 주석 참고).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, PermissionsAndroid, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { MicCapture } from '../audio/capture';
import { encodeBase64, encodeWav } from '../audio/pcm';
import {
  fetchConfig,
  getNextPrompt,
  getSttTrainingStatus,
  submitVerdict,
  uploadReadSample,
  uploadVerify,
} from '../src/api';
import type {
  ApiClient,
  ServerConfig,
  SttTrainingNextPrompt,
  SttTrainingStatus,
} from '../src/api';
import type { LoggedInUser } from './LoginScreen';
import { Button } from './Button';
import { ui } from './theme';
import type { Palette } from './theme';

type Mode = 'read' | 'verify';

/** `LearnScreen.tsx` 의 것과 같은 문구 — 화면마다 다시 짓지 않는다. */
async function requestMic(): Promise<string | null> {
  if (Platform.OS !== 'android') return null;
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
    title: '마이크 권한',
    message: '목소리를 서버에 보내 STT 를 이 계정에 맞추려면 마이크가 필요하다.',
    buttonPositive: '허용',
    buttonNegative: '거부',
  });
  if (result === PermissionsAndroid.RESULTS.GRANTED) return null;
  if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
    return '마이크 권한이 "다시 묻지 않음"으로 거부돼 있다. 기기의 설정 → 앱 → 권한에서 직접 켜야 한다.';
  }
  return '마이크 권한이 거부됐다. 권한을 허용해야 녹음할 수 있다.';
}

export function SttTrainingScreen({
  colors,
  makeClient,
  errorText,
  user,
  config,
  onConfig,
}: {
  colors: Palette;
  makeClient: () => ApiClient | null;
  errorText: (err: unknown) => string;
  user: LoggedInUser | null;
  config: ServerConfig | null;
  onConfig: (config: ServerConfig) => void;
}) {
  const [mode, setMode] = useState<Mode>('read');
  const [status, setStatus] = useState<SttTrainingStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [prompt, setPrompt] = useState<SttTrainingNextPrompt | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);

  const [verifyResult, setVerifyResult] = useState<{ sampleId: string; text: string } | null>(null);
  const [correctedText, setCorrectedText] = useState('');
  const [showCorrection, setShowCorrection] = useState(false);

  const captureRef = useRef<MicCapture | null>(null);
  const recordedRef = useRef<Int16Array[]>([]);
  const audioSpecRef = useRef<{ sampleRate: number; channels: number } | null>(null);

  const load = useCallback(async () => {
    const client = makeClient();
    if (!client || !user) return;
    setError('');
    setLoading(true);
    try {
      const cfg = config ?? (await fetchConfig(client));
      if (config === null) onConfig(cfg);
      audioSpecRef.current = { sampleRate: cfg.audio.stt_sample_rate, channels: cfg.audio.stt_channels };
      setStatus(await getSttTrainingStatus(client, user.id));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [makeClient, user, config, onConfig, errorText]);

  const triedRef = useRef('');
  useEffect(() => {
    if (!user) {
      triedRef.current = '';
      return;
    }
    if (triedRef.current === user.id) return;
    triedRef.current = user.id;
    load();
  }, [user, load]);

  const loadPrompt = useCallback(async () => {
    const client = makeClient();
    if (!client || !user) return;
    setError('');
    setBusy(true);
    try {
      setPrompt(await getNextPrompt(client, user.id));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }, [makeClient, user, errorText]);

  // 낭독 탭에 들어오면 문장을 한 번 받아온다.
  useEffect(() => {
    if (mode === 'read' && user && prompt === null) loadPrompt();
  }, [mode, user, prompt, loadPrompt]);

  async function startRecording() {
    if (recording || busy) return;
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
        frameSamples: Math.round(spec.sampleRate * 0.1),
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

  /** 녹음을 멈추고 WAV 를 base64 로 감싸 돌려준다. 너무 짧으면(빈 발화) null. */
  function stopRecording(): string | null {
    const capture = captureRef.current;
    captureRef.current = null;
    setRecording(false);
    if (capture) capture.stop();

    const spec = audioSpecRef.current;
    const frames = recordedRef.current;
    recordedRef.current = [];
    if (!spec || frames.length === 0) return null;

    const totalSamples = frames.reduce((sum, f) => sum + f.length, 0);
    const pcm = new Int16Array(totalSamples);
    let at = 0;
    for (const frame of frames) {
      pcm.set(frame, at);
      at += frame.length;
    }
    const wav = encodeWav(pcm, spec.sampleRate, spec.channels);
    return encodeBase64(wav);
  }

  async function onReadStop() {
    const audioBase64 = stopRecording();
    if (audioBase64 === null || prompt === null || prompt.done) return;
    const client = makeClient();
    if (!client || !user) return;
    setBusy(true);
    setError('');
    try {
      const result = await uploadReadSample(client, user.id, {
        prompt_id: prompt.prompt_id,
        audio_base64: audioBase64,
        content_type: 'audio/wav',
      });
      setStatus(prev => (prev ? { ...prev, read: result.read } : prev));
      setPrompt(null); // 다음 문장을 새로 받아온다
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function onVerifyStop() {
    const audioBase64 = stopRecording();
    if (audioBase64 === null) return;
    const client = makeClient();
    if (!client || !user) return;
    setBusy(true);
    setError('');
    setVerifyResult(null);
    setShowCorrection(false);
    setCorrectedText('');
    try {
      const result = await uploadVerify(client, user.id, {
        audio_base64: audioBase64,
        content_type: 'audio/wav',
      });
      setVerifyResult({ sampleId: result.sample_id, text: result.text });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function onVerdict(correct: boolean) {
    const client = makeClient();
    if (!client || !user || !verifyResult) return;
    if (!correct && correctedText.trim() === '') {
      setShowCorrection(true);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await submitVerdict(client, user.id, verifyResult.sampleId, {
        correct,
        corrected_text: correct ? undefined : correctedText.trim(),
      });
      setStatus(prev => (prev ? { ...prev, verify: result.verify } : prev));
      setVerifyResult(null);
      setShowCorrection(false);
      setCorrectedText('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!user) {
    return (
      <View>
        <Text style={[ui.sub, { color: colors.dim }]}>
          STT 학습도 학습 로그인 계정으로 스코프된다. 먼저 로그인해야 이 화면을 쓸 수 있다.
        </Text>
      </View>
    );
  }

  return (
    <View>
      <Text style={[ui.sub, { color: colors.dim }]}>
        이 사람 목소리에 맞춰 음성 인식을 개선하기 위한 데이터를 모은다 — 외국어 학습과는
        무관하다. (서버 API 미확정 — 지금은 시범 연동이다.)
      </Text>

      <View style={ui.row}>
        <Button label="다시 불러오기" onPress={load} disabled={loading} colors={colors} />
      </View>

      {loading && (
        <View style={ui.busy}>
          <ActivityIndicator color={colors.accent} />
          <Text style={[ui.busyText, { color: colors.dim }]}>진행 상황을 받는 중…</Text>
        </View>
      )}

      {status && (
        <View style={[ui.box, { borderColor: colors.border, backgroundColor: colors.field }]}>
          <Text style={[ui.boxTitle, { color: colors.dim }]}>진행률</Text>
          <Text style={[ui.mono, { color: colors.fg }]}>
            {`낭독 교정   ${status.read.done} / ${status.read.required}`}
          </Text>
          <Text style={[ui.mono, { color: colors.fg }]}>
            {`정오 판정   ${status.verify.done} / ${status.verify.required}`}
          </Text>
        </View>
      )}

      <View style={styles.modeRow}>
        <ModeChip label="낭독 교정" active={mode === 'read'} onPress={() => setMode('read')} colors={colors} />
        <ModeChip label="정오 판정" active={mode === 'verify'} onPress={() => setMode('verify')} colors={colors} />
      </View>

      {error !== '' && (
        <View style={[ui.box, { borderColor: colors.bad, backgroundColor: colors.badBg }]}>
          <Text style={[ui.boxTitle, { color: colors.bad }]}>오류</Text>
          <Text style={[ui.mono, { color: colors.fg }]} selectable>
            {error}
          </Text>
        </View>
      )}

      {mode === 'read' && (
        <View style={[ui.box, { borderColor: colors.border, backgroundColor: colors.field }]}>
          {prompt === null && busy && (
            <View style={ui.busy}>
              <ActivityIndicator color={colors.accent} />
              <Text style={[ui.busyText, { color: colors.dim }]}>문장을 받는 중…</Text>
            </View>
          )}
          {prompt !== null && prompt.done && (
            <Text style={[ui.mono, { color: colors.good }]}>낭독 교정 목표를 채웠다 ✅</Text>
          )}
          {prompt !== null && !prompt.done && (
            <View>
              <Text style={[ui.boxTitle, { color: colors.dim }]}>이 문장을 그대로 읽는다</Text>
              <Text style={styles.promptText} selectable>
                {prompt.text}
              </Text>
              <Pressable
                onPress={recording ? onReadStop : startRecording}
                disabled={busy}
                style={({ pressed }) => [
                  styles.recordButton,
                  {
                    backgroundColor: recording ? colors.bad : colors.accent,
                    opacity: busy ? 0.5 : pressed ? 0.8 : 1,
                  },
                ]}>
                <Text style={styles.recordLabel}>
                  {recording ? '녹음 종료 (제출)' : '녹음 시작'}
                </Text>
              </Pressable>
            </View>
          )}
        </View>
      )}

      {mode === 'verify' && (
        <View style={[ui.box, { borderColor: colors.border, backgroundColor: colors.field }]}>
          <Text style={[ui.boxTitle, { color: colors.dim }]}>자유롭게 아무 말이나 한다</Text>

          {verifyResult === null && (
            <Pressable
              onPress={recording ? onVerifyStop : startRecording}
              disabled={busy}
              style={({ pressed }) => [
                styles.recordButton,
                {
                  backgroundColor: recording ? colors.bad : colors.accent,
                  opacity: busy ? 0.5 : pressed ? 0.8 : 1,
                },
              ]}>
              <Text style={styles.recordLabel}>{recording ? '녹음 종료 (제출)' : '녹음 시작'}</Text>
            </Pressable>
          )}

          {busy && verifyResult === null && (
            <View style={ui.busy}>
              <ActivityIndicator color={colors.accent} />
              <Text style={[ui.busyText, { color: colors.dim }]}>인식하는 중…</Text>
            </View>
          )}

          {verifyResult !== null && (
            <View>
              <Text style={[ui.boxTitle, { color: colors.dim }]}>인식 결과</Text>
              <Text style={styles.promptText} selectable>
                {verifyResult.text || '(빈 결과)'}
              </Text>
              <View style={ui.row}>
                <Button label="맞음" onPress={() => onVerdict(true)} disabled={busy} colors={colors} />
                <Button
                  label="틀림"
                  onPress={() => setShowCorrection(true)}
                  disabled={busy}
                  colors={colors}
                  tone="danger"
                />
              </View>
              {showCorrection && (
                <View>
                  <Text style={[ui.label, { color: colors.dim }]}>정답 텍스트 (필수)</Text>
                  <TextInput
                    style={[
                      ui.input,
                      { color: colors.fg, borderColor: colors.border, backgroundColor: colors.field },
                    ]}
                    value={correctedText}
                    onChangeText={setCorrectedText}
                    placeholder="실제로 말한 문장을 그대로 입력…"
                    placeholderTextColor={colors.dim}
                  />
                  <View style={ui.row}>
                    <Button
                      label="틀림으로 제출"
                      onPress={() => onVerdict(false)}
                      disabled={busy || correctedText.trim() === ''}
                      colors={colors}
                      tone="danger"
                    />
                  </View>
                </View>
              )}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function ModeChip({
  label,
  active,
  onPress,
  colors,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  colors: Palette;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          borderColor: active ? colors.accent : colors.border,
          backgroundColor: active ? colors.accent : 'transparent',
          opacity: pressed ? 0.7 : 1,
        },
      ]}>
      <Text style={[styles.chipText, active ? styles.chipTextOn : { color: colors.fg }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  modeRow: { flexDirection: 'row', gap: 8, marginTop: 16 },
  chip: { flex: 1, borderWidth: 1, borderRadius: 999, paddingVertical: 8, alignItems: 'center' },
  chipText: { fontSize: 14 },
  chipTextOn: { color: '#ffffff', fontWeight: '600' },
  promptText: { fontSize: 18, lineHeight: 25, marginTop: 4, marginBottom: 8 },
  recordButton: { borderRadius: 8, paddingVertical: 13, alignItems: 'center', marginTop: 4 },
  recordLabel: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
});
