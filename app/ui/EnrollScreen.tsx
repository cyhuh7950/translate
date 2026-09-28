/**
 * 화자 등록 화면 — 자기 목소리를 등록해 배경 소음·다른 사람 말소리를 걸러낸다.
 *
 * 서버·웹 클라이언트에는 이미 있는 기능이다(`web/static/app.js` 의 `enrollVoice` /
 * `toggleEnrollRecording` / `speakerCandidates`). 이 화면은 그 규칙을 RN 으로 옮긴 것이지
 * DOM 코드를 그대로 가져온 것이 아니다.
 *
 *   GET /v1/speakers          등록된 화자 목록 (임베딩 벡터는 절대 없다)
 *   POST /v1/speakers/enroll  클립들의 평균 임베딩을 등록 (같은 id 는 대체)
 *   DELETE /v1/speakers/{id}  즉시 삭제
 *
 * **참여자 후보는 지금 고른 세션 프로필에서 나온다** (`/v1/config` 의
 * `profiles[].participants`). 등록 id 는 참여자 id 와 같아야 대조가 된다 — 프로필이
 * 바뀌면 참여자 id 도 바뀐다(oneway 는 speaker/listener, twoway_voice 는 a/b 식).
 * 프로필이 참여자를 주지 않으면(빈 배열) 자유 입력으로 id 를 받는다 — 웹의
 * `speakerCandidates()` 와 같은 규칙이다.
 *
 * **녹음은 `audio/capture.ts` 의 `MicCapture` 를 그대로 쓴다.** 새 캡처 코드를 만들지
 * 않는다 — `LiveScreen` 의 PTT 패턴(누르는 동안 프레임을 모으고, 떼면 클립 하나로
 * 확정)을 그대로 따르되, 여기서는 버튼이 토글이다(누르면 시작, 다시 누르면 그 클립을
 * 마친다). 오디오 라이브러리를 늦게 부르는 것도 `MicCapture` 가 이미 해주므로 이 화면은
 * 신경 쓸 필요가 없다(`audio/module.ts`).
 *
 * **클립을 WAV 로 인코딩해 올린다.** 캡처는 PCM16 프레임을 주지만 서버는 파일을 받으므로
 * `audio/pcm.ts` 의 `concatPcm16()` + `encodeWav()` 로 감싼다. RN 의 `Blob` 은 다른
 * `Blob`/문자열로만 만들 수 있어(원시 바이트를 감쌀 수 없다) 인메모리 WAV 를 그대로
 * 물릴 수 없다 — 그래서 base64 로 인코딩해 `data:audio/wav;base64,...` URI 로 감싸
 * `{uri, name, type}` 형태로 올린다. RN 의 네트워킹 계층이 `data:` URI 를 파일 소스로
 * 읽어준다(`RequestBodyUtil.getFileInputStream`, 안드로이드 기준 — iOS 는 아직 다루지
 * 않는다). 새 네이티브 의존성 없이 되는 방법이라 이 방식을 골랐다.
 *
 * **오류·경고 문구는 서버 것을 그대로.** 등록 시 `min_pairwise_similarity` 가
 * `threshold` 보다 낮으면 서버가 `warning` 에 문장을 렌더해 보낸다 — 앱은 그대로 보여주고
 * 스스로 문구를 만들지 않는다.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { MicCapture } from '../audio/capture';
import { bytesToBase64, concatPcm16, encodeWav } from '../audio/pcm';
import {
  deleteSpeaker,
  enrollSpeaker,
  fetchConfig,
  fetchSpeakers,
  frameSamples,
} from '../src/api';
import type {
  ApiClient,
  ParticipantSpec,
  ServerConfig,
  SpeakersResponse,
} from '../src/api';
import { Button } from './Button';
import type { Settings } from './settings';
import { ui } from './theme';
import type { Palette } from './theme';

/** 녹음해 아직 올리지 않은 클립 하나. */
interface Clip {
  id: number;
  seconds: number;
  /** WAV 로 이미 인코딩해 둔다 — 등록 누를 때 다시 계산하지 않는다. */
  wav: ArrayBuffer;
}

/** 지금 고른 세션으로 열릴 프로필 id. 설정에서 고르지 않았으면 서버 기본값이다. */
function currentProfileId(config: ServerConfig, form: Settings): string {
  return form.profile || config.session.default_profile || '';
}

/** 말할 수 있는 참여자만. 듣기만 하는 자리에 목소리를 등록할 이유가 없다(웹과 같은 규칙). */
function speakerCandidates(config: ServerConfig, form: Settings): ParticipantSpec[] {
  const profile = config.profiles.find(p => p.id === currentProfileId(config, form));
  if (!profile || !profile.participants || profile.participants.length === 0) return [];
  return profile.participants.filter(p => p.input);
}

export function EnrollScreen({
  colors,
  makeClient,
  errorText,
  config,
  onConfig,
  form,
}: {
  colors: Palette;
  makeClient: () => ApiClient | null;
  errorText: (err: unknown) => string;
  /** App 이 들고 있는 `/v1/config` 응답 — 다른 화면과 같은 것을 본다. */
  config: ServerConfig | null;
  onConfig: (config: ServerConfig) => void;
  /** 설정 화면에서 고른 값. 참여자 후보와 `mode`(화자 임베딩 엔진 라우팅용)를 여기서 가져온다. */
  form: Settings;
}) {
  const [error, setError] = useState('');
  const [configBusy, setConfigBusy] = useState(false);

  const [speakerId, setSpeakerId] = useState('');
  const [name, setName] = useState('');
  const [clips, setClips] = useState<Clip[]>([]);
  const [recording, setRecording] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resultMessage, setResultMessage] = useState('');
  const [resultWarning, setResultWarning] = useState('');

  const [speakers, setSpeakers] = useState<SpeakersResponse | null>(null);
  const [listError, setListError] = useState('');

  const captureRef = useRef<MicCapture | null>(null);
  const framesRef = useRef<ArrayBuffer[]>([]);
  const startingRef = useRef(false);
  const seqRef = useRef(0);

  /* ---- 설정 · 목록 불러오기 ---------------------------------------------------- */

  const loadConfig = useCallback(async () => {
    const client = makeClient();
    if (!client) {
      setError('서버 주소를 입력하세요.');
      return;
    }
    setConfigBusy(true);
    setError('');
    try {
      onConfig(await fetchConfig(client));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setConfigBusy(false);
    }
  }, [makeClient, onConfig, errorText]);

  const loadSpeakers = useCallback(async () => {
    const client = makeClient();
    if (!client) {
      setListError('서버 주소를 입력하세요.');
      return;
    }
    try {
      setSpeakers(await fetchSpeakers(client));
      setListError('');
    } catch (err) {
      setListError(errorText(err));
    }
  }, [makeClient, errorText]);

  // 탭에 들어오면 한 번은 알아서 받아온다 — 설정 화면과 같은 규칙이다.
  const triedRef = useRef(false);
  useEffect(() => {
    if (triedRef.current) return;
    triedRef.current = true;
    if (config === null) loadConfig();
    loadSpeakers();
  }, [config, loadConfig, loadSpeakers]);

  // 화면을 떠나면 녹음 중이던 마이크를 놓는다 — LiveScreen 의 teardown 과 같은 이유다.
  useEffect(
    () => () => {
      if (captureRef.current) {
        captureRef.current.stop();
        captureRef.current = null;
      }
    },
    [],
  );

  /* ---- 참여자 후보 -------------------------------------------------------------- */

  const candidates = config ? speakerCandidates(config, form) : [];
  // 고를 수 없는 후보를 들고 있으면 첫 번째로 물러난다 — settings.ts 의 settle() 과 같은 규칙.
  const effectiveSpeakerId =
    candidates.length > 0
      ? candidates.some(p => p.id === speakerId)
        ? speakerId
        : candidates[0]!.id
      : speakerId;

  /* ---- 녹음 ---------------------------------------------------------------- */

  function stopRecording() {
    const capture = captureRef.current;
    captureRef.current = null;
    setRecording(false);
    if (!capture) return;
    capture.stop();

    const frames = framesRef.current;
    framesRef.current = [];
    if (frames.length === 0 || !config) return; // 잡음 없이 뗀 경우 — 클립을 만들지 않는다

    const sampleRate = config.audio.stt_sample_rate;
    const channels = config.audio.stt_channels;
    const samples = concatPcm16(frames);
    const wav = encodeWav(samples, sampleRate, channels);
    const seconds = samples.length / channels / sampleRate;

    seqRef.current += 1;
    setClips(prev => [...prev, { id: seqRef.current, seconds, wav }]);
  }

  async function toggleRecording() {
    if (recording) {
      stopRecording();
      return;
    }
    if (startingRef.current) return; // 여는 사이에 다시 눌렀다
    if (!config) {
      setError('설정을 먼저 받아야 녹음할 수 있다.');
      return;
    }

    startingRef.current = true;
    framesRef.current = [];
    const capture = new MicCapture(
      {
        sampleRate: config.audio.stt_sample_rate,
        channels: config.audio.stt_channels,
        frameSamples: frameSamples(config),
      },
      {
        onFrame: frame => {
          framesRef.current.push(frame);
        },
        onError: msg => {
          setError(msg);
          stopRecording();
        },
      },
    );

    try {
      await capture.start();
    } catch (err) {
      startingRef.current = false;
      setError(errorText(err));
      capture.stop(); // MicCapture 가 실패 시 스스로 정리하지만, 방어적으로 한 번 더.
      return;
    }
    startingRef.current = false;
    captureRef.current = capture;
    setRecording(true);
  }

  function removeClip(id: number) {
    setClips(prev => prev.filter(c => c.id !== id));
  }

  /* ---- 등록 ------------------------------------------------------------------ */

  async function onEnroll() {
    const client = makeClient();
    if (!client) {
      setError('서버 주소를 입력하세요.');
      return;
    }
    const id = effectiveSpeakerId.trim();
    if (!id) {
      setError('화자 ID 를 먼저 골라야 한다.');
      return;
    }
    if (clips.length === 0) {
      setError('녹음한 클립이 하나도 없다.');
      return;
    }

    setSubmitting(true);
    setError('');
    setResultMessage('');
    setResultWarning('');
    try {
      const files = clips.map(clip => {
        const filename = `enroll-${clip.id}.wav`;
        // RN 의 Blob 은 원시 바이트를 감쌀 수 없어 data URI 로 우회한다 (파일 상단 주석 참고).
        const uri = `data:audio/wav;base64,${bytesToBase64(new Uint8Array(clip.wav))}`;
        // 파일 이름은 `data.name` 에 실린다 — RN 의 FormData.getParts() 가 여기서 읽는다.
        // (speakers.ts 의 EnrollFile.filename 은 값이 진짜 Blob 일 때만 쓰는 자리라 여기선 비운다 —
        // 채우면 표준 FormData 가 "value 가 Blob 이 아니다" 라며 던진다.)
        return { data: { uri, name: filename, type: 'audio/wav' } };
      });

      const result = await enrollSpeaker(
        client,
        {
          speaker_id: id,
          name: name.trim() || undefined,
          // 설정 화면에서 고른 세션 모드를 그대로 보낸다 — 화자 임베딩 엔진 라우팅용이다.
          mode: form.mode || undefined,
          files,
        },
        () => new FormData(),
      );

      setResultMessage(
        `등록됨 — ${result.speaker.name} (${result.speaker.id}) · 발화 ${result.speaker.utterances}개`,
      );
      // 서버가 렌더한 문장 그대로. 앱은 여기에 문구를 보태지 않는다.
      if (result.warning) setResultWarning(result.warning);

      setClips([]);
      setName('');
      await loadSpeakers();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onDelete(id: string) {
    const client = makeClient();
    if (!client) return;
    try {
      await deleteSpeaker(client, id);
      await loadSpeakers();
    } catch (err) {
      setListError(errorText(err));
    }
  }

  /* ---- 화면 -------------------------------------------------------------------- */

  const policySource = speakers ?? config?.speaker_id ?? null;
  const storeError = speakers ? speakers.error : config ? config.speaker_id.store_error : null;

  return (
    <View>
      <Text style={[ui.sub, { color: colors.dim }]}>
        자기 목소리를 등록해 두면 정책에 따라 다른 목소리(TV 소리·옆 사람 말)를 걸러낸다.
        등록 id 는 세션 참여자 id 와 같아야 한다 — 아래 후보가 그 값이다.
      </Text>

      <View style={ui.row}>
        <Button
          label="다시 불러오기"
          onPress={() => {
            loadConfig();
            loadSpeakers();
          }}
          disabled={configBusy}
          colors={colors}
        />
      </View>

      {error !== '' && (
        <View style={[ui.box, { borderColor: colors.bad, backgroundColor: colors.badBg }]}>
          <Text style={[ui.boxTitle, { color: colors.bad }]}>오류</Text>
          <Text style={[ui.mono, { color: colors.fg }]} selectable>
            {error}
          </Text>
        </View>
      )}

      {config === null && !configBusy && error === '' && (
        <Text style={[ui.sub, { color: colors.dim }]}>
          아직 설정을 받지 못했다. 서버 주소를 넣고 다시 불러오기를 누른다.
        </Text>
      )}

      {/* 정책 — 이름·임계값·자동 등록 여부는 서버 값을 그대로 보여준다. */}
      {policySource && (
        <View style={[ui.box, { borderColor: colors.border, backgroundColor: colors.field }]}>
          <Text style={[ui.boxTitle, { color: colors.dim }]}>정책</Text>
          <Text style={[ui.mono, { color: colors.fg }]} selectable>
            {`정책 ${policySource.policy} · 임계값 ${policySource.threshold} · ` +
              `자동 등록 ${policySource.auto_enroll ? '켜짐' : '꺼짐'} · ` +
              `등록됨 ${speakers ? speakers.count : config!.speaker_id.enrolled}명`}
          </Text>
          <Text style={[ui.sub, { color: colors.dim }]}>
            정책·임계값·등록 여부에 따라 어떤 발화가 통역되고 어떤 발화가 건너뛰어지는지가 갈린다.
          </Text>
          {storeError && (
            <Text style={[ui.mono, { color: colors.bad }]} selectable>
              {storeError}
            </Text>
          )}
        </View>
      )}

      {/* ---- 등록 폼 ---- */}
      {config !== null && (
        <View style={[ui.box, { borderColor: colors.border, backgroundColor: colors.field }]}>
          <Text style={[ui.boxTitle, { color: colors.dim }]}>새로 등록</Text>

          <Text style={[ui.label, { color: colors.dim }]}>화자 ID</Text>
          {candidates.length > 0 ? (
            <View style={styles.chips}>
              {candidates.map(p => (
                <Pressable
                  key={p.id}
                  testID={`speaker:${p.id}`}
                  onPress={() => setSpeakerId(p.id)}
                  style={({ pressed }) => [
                    styles.chip,
                    {
                      borderColor: p.id === effectiveSpeakerId ? colors.accent : colors.border,
                      backgroundColor: p.id === effectiveSpeakerId ? colors.accent : 'transparent',
                      opacity: pressed ? 0.7 : 1,
                    },
                  ]}>
                  <Text
                    style={[
                      styles.chipText,
                      p.id === effectiveSpeakerId ? styles.chipTextOn : { color: colors.fg },
                    ]}>
                    {p.lang ? `${p.id} · ${p.lang}` : p.id}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : (
            <>
              <TextInput
                style={[
                  ui.input,
                  { color: colors.fg, borderColor: colors.border, backgroundColor: colors.field },
                ]}
                value={effectiveSpeakerId}
                onChangeText={value => setSpeakerId(value.trim())}
                placeholder="예: speaker"
                placeholderTextColor={colors.dim}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Text style={[styles.note, { color: colors.dim }]}>
                지금 프로필이 참여자를 주지 않아 직접 적는다 — 세션이 실제로 쓸 참여자 id 와
                같아야 대조가 된다.
              </Text>
            </>
          )}

          <Text style={[ui.label, { color: colors.dim }]}>이름 (선택)</Text>
          <TextInput
            style={[
              ui.input,
              { color: colors.fg, borderColor: colors.border, backgroundColor: colors.field },
            ]}
            value={name}
            onChangeText={setName}
            placeholder={effectiveSpeakerId || '비워 두면 화자 ID 를 쓴다'}
            placeholderTextColor={colors.dim}
          />

          <View style={ui.row}>
            <Button
              label={recording ? '녹음 중지' : '클립 녹음'}
              onPress={toggleRecording}
              disabled={config === null}
              colors={colors}
              tone={recording ? 'danger' : 'accent'}
            />
          </View>
          {recording && (
            <Text style={[styles.note, { color: colors.dim }]}>
              녹음 중 — 다시 누르면 이 클립을 마친다. 짧은 클립을 여럿 모을수록 평균이 안정적이다.
            </Text>
          )}

          {clips.length > 0 && (
            <View style={styles.clipList}>
              <Text style={[ui.label, { color: colors.dim }]}>{`클립 ${clips.length}개`}</Text>
              {clips.map(clip => (
                <View key={clip.id} style={styles.clipRow}>
                  <Text style={[ui.mono, { color: colors.fg }]}>
                    {`#${clip.id} · ${clip.seconds.toFixed(1)}초`}
                  </Text>
                  <Pressable testID={`clip-remove:${clip.id}`} onPress={() => removeClip(clip.id)}>
                    <Text style={[ui.mono, { color: colors.bad }]}>삭제</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          )}

          <View style={ui.row}>
            <Button
              label="등록"
              onPress={onEnroll}
              disabled={submitting || clips.length === 0 || effectiveSpeakerId.trim() === ''}
              colors={colors}
            />
          </View>

          {resultMessage !== '' && (
            <Text style={[ui.mono, { color: colors.good }, styles.result]} selectable>
              {resultMessage}
            </Text>
          )}
          {/* 서버가 렌더한 문장 그대로 — 유사도가 낮아 다른 사람이 섞였을 수 있다는 경고. */}
          {resultWarning !== '' && (
            <Text style={[ui.mono, { color: colors.bad }, styles.result]} selectable>
              {resultWarning}
            </Text>
          )}
        </View>
      )}

      {/* ---- 등록된 화자 목록 ---- */}
      <View style={[ui.box, { borderColor: colors.border, backgroundColor: colors.field }]}>
        <Text style={[ui.boxTitle, { color: colors.dim }]}>등록된 화자</Text>
        {listError !== '' && (
          <Text style={[ui.mono, { color: colors.bad }]} selectable>
            {listError}
          </Text>
        )}
        {speakers && speakers.speakers.length === 0 && listError === '' && (
          <Text style={[ui.sub, { color: colors.dim }]}>등록된 화자가 없다.</Text>
        )}
        {speakers &&
          speakers.speakers.map(person => (
            <View key={person.id} style={styles.speakerRow}>
              <View style={styles.speakerInfo}>
                <Text style={[ui.mono, { color: colors.fg }]}>{person.name || person.id}</Text>
                <Text style={[styles.note, { color: colors.dim }]}>
                  {`id ${person.id} · 발화 ${person.utterances}개` +
                    (person.engine ? ` · ${person.engine}${person.model ? `/${person.model}` : ''}` : '')}
                </Text>
              </View>
              <Pressable testID={`speaker-delete:${person.id}`} onPress={() => onDelete(person.id)}>
                <Text style={[ui.mono, { color: colors.bad }]}>삭제</Text>
              </Pressable>
            </View>
          ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  chipText: { fontSize: 14 },
  chipTextOn: { color: '#ffffff', fontWeight: '600' },
  note: { fontSize: 12, lineHeight: 17, marginTop: 6 },
  clipList: { marginTop: 12 },
  clipRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  result: { marginTop: 12 },
  speakerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#00000022',
  },
  speakerInfo: { flexShrink: 1, paddingRight: 12 },
});
