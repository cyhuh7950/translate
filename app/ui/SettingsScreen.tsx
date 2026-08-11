/**
 * 설정 화면 — 통역할 언어와 세션 규격을 고른다.
 *
 * **이 화면에는 목록이 없다.** 언어도 프로필도 모드도 엔진도 전부 `/v1/config` 응답에서
 * 만들어진다. 그 만드는 규칙은 `ui/settings.ts` 에 있고(웹의 `renderSettings` 와 같은
 * 규칙이다), 이 파일은 그 결과를 RN 위젯으로 옮기기만 한다. 서버에 언어가 하나 늘면
 * 두 파일 다 고치지 않아도 화면에 늘어난다.
 *
 * **고른 값은 실제로 세션에 쓰인다.** 값은 App.tsx 가 들고 있고
 * `LiveScreen` 이 WS `config` 메시지를(`streamConfig()`), `ConnectScreen` 이 텍스트 번역의
 * 언어를(`chosenLanguages()`) 여기서 가져간다. 화면 아래의 "세션을 이 값으로 연다" 상자가
 * 그 메시지를 그대로 보여주므로, 실기기에서도 반영 여부를 눈으로 확인할 수 있다.
 *
 * **저장하지 않는다.** 앱을 껐다 켜면 서버 기본값으로 돌아간다 — RN 에서 설정을 저장하려면
 * AsyncStorage(네이티브 의존성)가 필요한데, 이번 변경은 재빌드 없이 Metro 새로고침만으로
 * 확인되도록 JS 로만 두기로 했다. README §10 에 알려진 한계로 적어 뒀다.
 *
 * 고를 수 없는 항목(`available: false`)은 **누를 수 없게** 하고 서버가 준 이유를 그대로
 * 함께 띄운다. 그 문장은 요청 로케일로 서버가 렌더한 것이라 앱이 손대지 않는다.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { fetchConfig } from '../src/api';
import type { ApiClient, ServerConfig } from '../src/api';
import { Button } from './Button';
import { buildFields, streamConfig } from './settings';
import type { SettingField, Settings } from './settings';
import { ui } from './theme';
import type { Palette } from './theme';

export function SettingsScreen({
  colors,
  makeClient,
  locale,
  errorText,
  config,
  onConfig,
  form,
  onForm,
}: {
  colors: Palette;
  makeClient: () => ApiClient | null;
  locale: string;
  errorText: (err: unknown) => string;
  /** App 이 들고 있는 `/v1/config` 응답. 아직 받지 못했으면 null 이다. */
  config: ServerConfig | null;
  onConfig: (config: ServerConfig) => void;
  /** 지금까지 고른 값. 비어 있으면 전부 서버 기본값이다. */
  form: Settings;
  onForm: (form: Settings) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const client = makeClient();
    if (!client) {
      setError('서버 주소를 입력하세요.');
      return;
    }
    setError('');
    setBusy(true);
    try {
      onConfig(await fetchConfig(client));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }, [makeClient, onConfig, errorText]);

  // 탭에 들어오면 한 번은 알아서 받아온다 — 고를 것이 없는 빈 화면을 먼저 보여주지 않기
  // 위해서다. 그다음부터는 사용자가 `다시 불러오기` 로 부른다 (주소를 바꿨을 때 등).
  const triedRef = useRef(false);
  useEffect(() => {
    if (config !== null || triedRef.current) return;
    triedRef.current = true;
    // load() 는 스스로 오류를 잡아 화면에 띄운다 — 여기로 던져 나오지 않는다.
    load();
  }, [config, load]);

  function pick(name: string, value: string) {
    onForm({ ...form, [name]: value });
  }

  const fields = config === null ? [] : buildFields(config, form);
  // 실제로 나갈 메시지. 화면과 세션이 어긋나지 않는지 여기서 바로 보인다.
  const message = config === null ? null : streamConfig(config, form, locale);

  return (
    <View>
      <Text style={[ui.sub, { color: colors.dim }]}>
        고를 수 있는 것은 전부 /v1/config 가 알려준 것이다. 앱에는 언어·프로필·모드 목록이 없다.
        고른 값은 다음에 여는 세션부터 쓰인다. {'\n'}
        저장하지 않는다 — 앱을 다시 켜면 서버 기본값으로 돌아간다.
      </Text>

      <View style={ui.row}>
        <Button label="다시 불러오기" onPress={() => load()} disabled={busy} colors={colors} />
        <Button
          label="기본값으로"
          onPress={() => onForm({})}
          disabled={busy || config === null}
          colors={colors}
          tone="danger"
        />
      </View>

      {busy && (
        <View style={ui.busy}>
          <ActivityIndicator color={colors.accent} />
          <Text style={[ui.busyText, { color: colors.dim }]}>설정을 받는 중…</Text>
        </View>
      )}

      {/* 서버가 준 문장을 그대로. 앱은 여기에 문구를 보태지 않는다. */}
      {error !== '' && (
        <View style={[ui.box, { borderColor: colors.bad, backgroundColor: colors.badBg }]}>
          <Text style={[ui.boxTitle, { color: colors.bad }]}>오류</Text>
          <Text style={[ui.mono, { color: colors.fg }]} selectable>
            {error}
          </Text>
        </View>
      )}

      {config === null && !busy && error === '' && (
        <Text style={[ui.sub, { color: colors.dim }]}>
          아직 설정을 받지 못했다. 서버 주소를 넣고 다시 불러오기를 누른다.
        </Text>
      )}

      {fields.map(field => (
        <Field
          key={field.name}
          field={field}
          colors={colors}
          onPick={value => pick(field.name, value)}
        />
      ))}

      {message !== null && (
        <View style={[ui.box, { borderColor: colors.border, backgroundColor: colors.field }]}>
          <Text style={[ui.boxTitle, { color: colors.dim }]}>세션을 이 값으로 연다</Text>
          <Text style={[ui.mono, { color: colors.fg }]} selectable>
            {describe(message)}
          </Text>
        </View>
      )}
    </View>
  );
}

/**
 * 실제로 나갈 WS `config` 메시지를 한 줄씩. 키를 열거하지 않고 메시지에 실린 것을 그대로
 * 편다 — 서버 설정이 늘어 필드가 하나 더 붙어도 여기 뜬다.
 */
function describe(message: object): string {
  const entries = message as unknown as Record<string, unknown>;
  return Object.keys(entries)
    .filter(key => key !== 'type')
    .map(key => `${key.padEnd(14)}${String(entries[key])}`)
    .join('\n');
}

/* ---- 한 항목 ---------------------------------------------------------------- */

function Field({
  field,
  colors,
  onPick,
}: {
  field: SettingField;
  colors: Palette;
  onPick: (value: string) => void;
}) {
  // 고른 것의 설명과, 못 고르는 것들의 이유. 후자가 서버가 준 문장이다.
  const selected = field.options.find(o => o.value === field.value);
  const blocked = field.options.filter(o => !o.usable && o.note !== '');

  return (
    <View style={styles.field}>
      <Text style={[ui.label, { color: colors.dim }]}>{field.label}</Text>

      {field.kind === 'text' ? (
        <TextInput
          style={[
            ui.input,
            { color: colors.fg, borderColor: colors.border, backgroundColor: colors.field },
          ]}
          value={field.value}
          onChangeText={onPick}
          placeholder={field.placeholder}
          placeholderTextColor={colors.dim}
          autoCapitalize="none"
          autoCorrect={false}
        />
      ) : (
        <View style={styles.chips}>
          {field.options.map(o => (
            <Chip
              key={o.value}
              // 값이 서버에서 오므로 화면에는 같은 글자가 여러 항목에 나온다(사용어/목표어).
              // 테스트가 어느 항목의 어느 값인지 집을 수 있게 이름을 붙여 둔다.
              testID={`${field.name}:${o.value}`}
              option={o}
              active={o.value === field.value}
              colors={colors}
              onPress={() => onPick(o.value)}
            />
          ))}
        </View>
      )}

      {field.transient && (
        <Text style={[styles.note, { color: colors.dim }]}>
          화면 전용 — 서버로 나가지 않는다. 앱이 마이크를 어떻게 다루는지를 정한다
          (실시간 화면이 다음에 여는 세션부터 따른다).
        </Text>
      )}

      {selected && selected.note !== '' && (
        <Text style={[styles.note, { color: colors.dim }]} selectable>
          {selected.note}
        </Text>
      )}

      {blocked.map(o => (
        <Text key={o.value} style={[styles.note, { color: colors.bad }]} selectable>
          {`${o.label} — ${o.note}`}
        </Text>
      ))}
    </View>
  );
}

/** 목록 하나. RN 에 select 가 없어서 눌러 고르는 칩으로 둔다(네이티브 의존성 없이). */
function Chip({
  option,
  active,
  colors,
  onPress,
  testID,
}: {
  option: { label: string; usable: boolean };
  active: boolean;
  colors: Palette;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={!option.usable}
      style={({ pressed }) => [
        styles.chip,
        {
          borderColor: active ? colors.accent : colors.border,
          backgroundColor: active ? colors.accent : 'transparent',
          opacity: !option.usable ? 0.4 : pressed ? 0.7 : 1,
        },
      ]}>
      <Text style={[styles.chipText, active ? styles.chipTextOn : { color: colors.fg }]}>
        {option.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  field: { marginTop: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  chipText: { fontSize: 14 },
  chipTextOn: { color: '#ffffff', fontWeight: '600' },
  note: { fontSize: 12, lineHeight: 17, marginTop: 6 },
});
