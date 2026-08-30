/**
 * 언어 학습 설정 화면 (`DESIGN.md` §15, `PLAN_LANG_LEARN.md` 앱 작업 2번).
 *
 * 스케줄(시각·문제 수 — 하루 여러 세트), 학습 언어, 난이도(`level_mode`
 * adaptive/manual + manual 이면 등급), `feedback_mode`, `show_text_for_repeat` 를
 * `GET/PUT /v1/users/{id}/lang_learn/settings` 로 조회·저장한다.
 *
 * **목록을 하드코딩하지 않는다(§10 규칙).** 학습 언어는 `/v1/config` 의
 * `languages`에서, 난이도 단계(`levels`)는 그 응답의 `lang_learn.levels`에서 온다.
 * `level_mode`/`feedback_mode` 의 값 자체는 DESIGN.md §15 가 정한 프로토콜 상수라
 * (등급 이름 "상/중/하"와 같은 종류) 서버가 목록으로 내려주지 않는다 — 그래서 이
 * 둘만 화면에 고정된 선택지로 둔다.
 *
 * **저장에 성공하면 기기 알림을 다시 예약한다.** 스케줄이 바뀌었는데 예약이
 * 그대로면 옛 시각에 알림이 온다 — `PLAN_LANG_LEARN.md` 앱 작업 3번의 "학습
 * 설정이 바뀌면 기존 예약 취소하고 재예약"이 이 화면의 저장 버튼에 걸려 있다.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { ensurePermission, scheduleLangLearnNotifications } from '../notifications';
import { fetchConfig, getLangLearnSettings, putLangLearnSettings } from '../src/api';
import type { ApiClient, LangLearnScheduleSlot, LangLearnSettings, ServerConfig } from '../src/api';
import type { LoggedInUser } from './LoginScreen';
import { Button } from './Button';
import { ui } from './theme';
import type { Palette } from './theme';

const LEVEL_MODES = [
  { value: 'adaptive', label: '적응형 (최근 점수로 자동 조정)' },
  { value: 'manual', label: '수동 (직접 등급 고정)' },
];

const FEEDBACK_MODES = [
  { value: 'immediate', label: '즉시 (문제마다)' },
  { value: 'summary', label: '총평만 (세션 끝에)' },
  { value: 'both', label: '즉시 + 총평' },
];

export function LangLearnSettingsScreen({
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
  /** App 이 들고 있는 `/v1/config` 응답. 아직 못 받았으면 null 이다. */
  config: ServerConfig | null;
  onConfig: (config: ServerConfig) => void;
}) {
  const [draft, setDraft] = useState<LangLearnSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const client = makeClient();
    if (!client || !user) return;
    setError('');
    setSaved(false);
    setLoading(true);
    try {
      if (config === null) onConfig(await fetchConfig(client));
      setDraft(await getLangLearnSettings(client, user.id));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [makeClient, user, config, onConfig, errorText]);

  // 로그인된 사용자가 있고 아직 못 받았으면 탭에 들어오자마자 한 번 받아온다.
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

  async function onSave() {
    const client = makeClient();
    if (!client || !user || !draft) return;

    const schedule = draft.schedule.filter(slot => slot.time.trim() !== '');
    for (const slot of schedule) {
      if (!/^\d{1,2}:\d{2}$/.test(slot.time.trim())) {
        setError(`시각 형식이 잘못됐다 (HH:MM): "${slot.time}"`);
        return;
      }
      if (!Number.isFinite(slot.count) || slot.count <= 0) {
        setError(`문제 수는 1 이상이어야 한다 (${slot.time}).`);
        return;
      }
    }

    setError('');
    setSaved(false);
    setSaving(true);
    try {
      const patch = { ...draft, schedule };
      const result = await putLangLearnSettings(client, user.id, patch);
      setDraft(result);
      // 저장된 스케줄로 기기 알림을 다시 건다 — 실패해도(권한 없음 등) 설정 저장
      // 자체는 끝난 것이므로 사용자에게 별도 오류로 띄우지 않는다(notifications.ts 가
      // 이미 자기 안에서 잡아 조용히 넘어간다).
      await ensurePermission();
      await scheduleLangLearnNotifications(result.schedule);
      setSaved(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  function update<K extends keyof LangLearnSettings>(key: K, value: LangLearnSettings[K]) {
    if (!draft) return;
    setDraft({ ...draft, [key]: value });
    setSaved(false);
  }

  function updateSlot(index: number, patch: Partial<LangLearnScheduleSlot>) {
    if (!draft) return;
    const schedule = draft.schedule.slice();
    schedule[index] = { ...(schedule[index] as LangLearnScheduleSlot), ...patch };
    update('schedule', schedule);
  }

  function addSlot() {
    if (!draft) return;
    update('schedule', [...draft.schedule, { time: '', count: 3 }]);
  }

  function removeSlot(index: number) {
    if (!draft) return;
    update(
      'schedule',
      draft.schedule.filter((_, i) => i !== index),
    );
  }

  if (!user) {
    return (
      <View>
        <Text style={[ui.sub, { color: colors.dim }]}>
          학습 설정은 학습 로그인 계정으로 스코프된다. 먼저 "학습 로그인" 탭에서
          로그인해야 이 화면을 쓸 수 있다.
        </Text>
      </View>
    );
  }

  const languages = config === null ? [] : config.languages;
  const levels = config?.lang_learn?.levels ?? [];

  return (
    <View>
      <Text style={[ui.sub, { color: colors.dim }]}>
        스케줄이 되면 기기가 스스로 알림을 예약한다(서버 푸시 없음). 학습 언어·난이도
        목록은 /v1/config 에서 온다.
      </Text>

      <View style={ui.row}>
        <Button label="다시 불러오기" onPress={load} disabled={loading || saving} colors={colors} />
      </View>

      {loading && (
        <View style={ui.busy}>
          <ActivityIndicator color={colors.accent} />
          <Text style={[ui.busyText, { color: colors.dim }]}>설정을 받는 중…</Text>
        </View>
      )}

      {error !== '' && (
        <View style={[ui.box, { borderColor: colors.bad, backgroundColor: colors.badBg }]}>
          <Text style={[ui.boxTitle, { color: colors.bad }]}>오류</Text>
          <Text style={[ui.mono, { color: colors.fg }]} selectable>
            {error}
          </Text>
        </View>
      )}

      {draft && (
        <View>
          <Text style={[ui.label, { color: colors.dim }]}>스케줄 (하루 여러 세트 가능)</Text>
          {draft.schedule.map((slot, index) => (
            <View key={index} style={styles.slotRow}>
              <TextInput
                testID={`slot-time-${index}`}
                style={[
                  ui.input,
                  styles.slotTime,
                  { color: colors.fg, borderColor: colors.border, backgroundColor: colors.field },
                ]}
                value={slot.time}
                onChangeText={t => updateSlot(index, { time: t })}
                placeholder="08:00"
                placeholderTextColor={colors.dim}
                keyboardType="numbers-and-punctuation"
              />
              <TextInput
                testID={`slot-count-${index}`}
                style={[
                  ui.input,
                  styles.slotCount,
                  { color: colors.fg, borderColor: colors.border, backgroundColor: colors.field },
                ]}
                value={String(slot.count)}
                onChangeText={t => updateSlot(index, { count: Number.parseInt(t, 10) || 0 })}
                placeholder="3"
                placeholderTextColor={colors.dim}
                keyboardType="number-pad"
              />
              <Pressable
                testID={`slot-remove-${index}`}
                onPress={() => removeSlot(index)}
                style={({ pressed }) => [styles.remove, { borderColor: colors.bad, opacity: pressed ? 0.7 : 1 }]}>
                <Text style={{ color: colors.bad }}>삭제</Text>
              </Pressable>
            </View>
          ))}
          <View style={ui.row}>
            <Button label="시간대 추가" onPress={addSlot} disabled={saving} colors={colors} />
          </View>

          <Text style={[ui.label, { color: colors.dim }]}>학습 언어</Text>
          <ChipRow
            options={languages.map(l => ({ value: l.code, label: l.label }))}
            value={draft.target_lang}
            colors={colors}
            onPick={v => update('target_lang', v)}
          />

          <Text style={[ui.label, { color: colors.dim }]}>난이도</Text>
          <ChipRow
            options={LEVEL_MODES}
            value={draft.level_mode}
            colors={colors}
            onPick={v => update('level_mode', v)}
          />
          {draft.level_mode === 'manual' && (
            <ChipRow
              options={levels.map(l => ({ value: l, label: l }))}
              value={draft.manual_level ?? ''}
              colors={colors}
              onPick={v => update('manual_level', v)}
            />
          )}

          <Text style={[ui.label, { color: colors.dim }]}>피드백</Text>
          <ChipRow
            options={FEEDBACK_MODES}
            value={draft.feedback_mode}
            colors={colors}
            onPick={v => update('feedback_mode', v)}
          />

          <Text style={[ui.label, { color: colors.dim }]}>repeat 문제에서 문장 텍스트도 보여줄지</Text>
          <ChipRow
            options={[
              { value: 'hide', label: '숨김 — 듣고만 따라 말한다' },
              { value: 'show', label: '표시 — 텍스트도 같이 본다' },
            ]}
            value={draft.show_text_for_repeat ? 'show' : 'hide'}
            colors={colors}
            onPick={v => update('show_text_for_repeat', v === 'show')}
          />

          <View style={ui.row}>
            <Button label="저장" onPress={onSave} disabled={saving} colors={colors} />
          </View>

          {saving && (
            <View style={ui.busy}>
              <ActivityIndicator color={colors.accent} />
              <Text style={[ui.busyText, { color: colors.dim }]}>저장하는 중…</Text>
            </View>
          )}

          {saved && (
            <Text style={[ui.sub, styles.savedNote, { color: colors.good }]}>
              저장했다. 기기 알림도 이 스케줄로 다시 예약했다.
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

function ChipRow({
  options,
  value,
  colors,
  onPick,
}: {
  options: { value: string; label: string }[];
  value: string;
  colors: Palette;
  onPick: (value: string) => void;
}) {
  return (
    <View style={styles.chips}>
      {options.map(o => (
        <Pressable
          key={o.value}
          testID={`chip:${o.value}`}
          onPress={() => onPick(o.value)}
          style={({ pressed }) => [
            styles.chip,
            {
              borderColor: o.value === value ? colors.accent : colors.border,
              backgroundColor: o.value === value ? colors.accent : 'transparent',
              opacity: pressed ? 0.7 : 1,
            },
          ]}>
          <Text style={[styles.chipText, o.value === value ? styles.chipTextOn : { color: colors.fg }]}>
            {o.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  slotRow: { flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 6 },
  slotTime: { flex: 1 },
  slotCount: { width: 70 },
  remove: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4, marginBottom: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  chipText: { fontSize: 14 },
  chipTextOn: { color: '#ffffff', fontWeight: '600' },
  savedNote: { marginTop: 8 },
});
