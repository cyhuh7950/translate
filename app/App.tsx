/**
 * 연결 확인 화면 (스파이크).
 *
 * 이 화면이 보려는 것은 딱 하나 — **실기기에서 RN → src/api → 서버 경로가 사는가.**
 * 그래서 여기에는 앱 다운 것이 아무것도 없다. 오디오도, WebSocket 도, ONNX 도 없다
 * (그것들은 다음 단계다). 대신 두 가지를 누를 수 있다.
 *
 *   설정 조회   GET /v1/config    → 프로필 수 · 엔진 수 · 언어 수
 *   텍스트 번역  POST /v1/translate/text
 *
 * 세 가지 원칙이 이 화면에서 실제로 지켜지는지도 함께 본다.
 *
 *   1. **주입** — `src/api` 는 전역을 찾지 않는다. RN 의 `fetch` 를 여기서 넘긴다.
 *      스모크 테스트(test/smoke.ts)가 Node 의 전역을 넘기던 자리와 같은 한 줄이다.
 *   2. **주소를 박지 않는다** — 기본값은 소스가 아니라 app.config.json 에서 온다.
 *      거기도 비어 있으면 사용자가 입력한다.
 *   3. **문구를 만들지 않는다** — 번역 언어는 `/v1/config` 의 세션 기본값에서 오고,
 *      오류는 서버가 로케일로 렌더한 `detail` 을 그대로 띄운다. 앱에 카탈로그가 없다.
 */

import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  ApiError,
  availableProfiles,
  fetchConfig,
  readyEngines,
  translateText,
} from './src/api';
import type { ApiClient, FetchLike, ServerConfig } from './src/api';
import appConfig from './app.config.json';

/* ---- 환경 주입 --------------------------------------------------------------
 *
 * 이 파일에서 `src/api` 에 넘겨주는 환경은 이것 하나다. 캐스팅이 없다는 것이 요점이다 —
 * `FetchLike` 는 Node 의 전역 fetch 와 RN 의 전역 fetch가 **둘 다 그대로 대입되도록**
 * 구조만 선언해 둔 타입이고, 이 줄이 타입 체크를 통과하는 것이 그 증거다.
 */

const rnFetch: FetchLike = fetch;

/* ---- 설정 ------------------------------------------------------------------
 *
 * 서버 주소도 로케일도 소스에 없다. app.config.json 이 비어 있으면 화면에서 입력받는다.
 */

const DEFAULT_BASE_URL: string = appConfig.serverUrl;
const DEFAULT_API_KEY: string = appConfig.apiKey;
const LOCALE: string = appConfig.locale;

function makeClient(baseUrl: string, apiKey: string): ApiClient {
  const client: ApiClient = { baseUrl: baseUrl.trim(), fetch: rnFetch };
  if (apiKey.trim()) client.apiKey = apiKey.trim();
  if (LOCALE) client.locale = LOCALE;
  return client;
}

/**
 * 화면에 띄울 오류 문장.
 *
 * `ApiError` 면 서버가 요청 로케일로 렌더한 문장이 이미 `message` 에 있다 — 그대로 쓴다.
 * 그 밖(주소 오타·와이파이 끊김 등)은 서버까지 가지 못한 것이라 RN 이 준 문장을 쓴다.
 */
function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    return err.code ? `${err.message}\n[${err.code}] HTTP ${err.status}` : `${err.message}\nHTTP ${err.status}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function App() {
  const isDark = useColorScheme() === 'dark';
  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <Screen isDark={isDark} />
    </SafeAreaProvider>
  );
}

function Screen({ isDark }: { isDark: boolean }) {
  const insets = useSafeAreaInsets();
  const c = isDark ? dark : light;

  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [apiKey, setApiKey] = useState(DEFAULT_API_KEY);
  const [text, setText] = useState('안녕하세요, 오늘 회의는 세 시에 시작합니다.');

  /** `/v1/config` 응답. 번역 버튼이 쓸 언어가 여기서 온다. */
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [busy, setBusy] = useState<'config' | 'translate' | null>(null);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');

  function begin(which: 'config' | 'translate'): boolean {
    if (busy) return false;
    if (!baseUrl.trim()) {
      setResult('');
      setError('서버 주소를 입력하세요.');
      return false;
    }
    setResult('');
    setError('');
    setBusy(which);
    return true;
  }

  async function onFetchConfig() {
    if (!begin('config')) return;
    try {
      const cfg = await fetchConfig(makeClient(baseUrl, apiKey));
      setConfig(cfg);
      setResult(
        [
          `server_id     ${cfg.server_id}`,
          `locale        ${cfg.locale}   (요청 ${LOCALE || '없음'})`,
          `프로필         ${availableProfiles(cfg).length} / ${cfg.profiles.length} 사용 가능`,
          `엔진           ${readyEngines(cfg).length} / ${cfg.engines.length} 준비됨`,
          `언어           ${cfg.languages.length}`,
          `세션 기본값     ${cfg.session.default_source_lang} → ${cfg.session.default_target_lang}` +
            `  (${cfg.session.default_profile} / ${cfg.session.default_mode})`,
          `WS 경로        ${cfg.stream.path}`,
          `마이크 규격     ${cfg.audio.stt_sample_rate}Hz ${cfg.audio.stt_channels}ch` +
            ` · ${cfg.stream.client_frame_ms}ms 프레임`,
        ].join('\n'),
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function onTranslate() {
    if (!begin('translate')) return;
    try {
      const client = makeClient(baseUrl, apiKey);
      // 언어 코드도 소스에 없다. 아직 조회하지 않았으면 지금 조회한다.
      const cfg = config ?? (await fetchConfig(client));
      setConfig(cfg);

      const out = await translateText(client, {
        text,
        source_lang: cfg.session.default_source_lang,
        target_lang: cfg.session.default_target_lang,
      });
      setResult(
        [
          out.text,
          '',
          `${out.source_lang} → ${out.target_lang}`,
          `${out.provider}${out.model ? ` / ${out.model}` : ''}   ${out.elapsed_s.toFixed(2)}s`,
        ].join('\n'),
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: c.bg }]}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={[styles.title, { color: c.fg }]}>연결 확인</Text>
      <Text style={[styles.sub, { color: c.dim }]}>
        RN → src/api → 서버 경로가 사는지만 본다. 오디오·WS·ONNX 는 다음 단계.
      </Text>

      <Text style={[styles.label, { color: c.dim }]}>서버 주소</Text>
      <TextInput
        style={[styles.input, { color: c.fg, borderColor: c.border, backgroundColor: c.field }]}
        value={baseUrl}
        onChangeText={setBaseUrl}
        placeholder="https://…"
        placeholderTextColor={c.dim}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />

      <Text style={[styles.label, { color: c.dim }]}>API 키 (서버에 설정돼 있을 때만)</Text>
      <TextInput
        style={[styles.input, { color: c.fg, borderColor: c.border, backgroundColor: c.field }]}
        value={apiKey}
        onChangeText={setApiKey}
        placeholder="비어 있으면 보내지 않는다"
        placeholderTextColor={c.dim}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={[styles.label, { color: c.dim }]}>번역할 문장</Text>
      <TextInput
        style={[
          styles.input,
          styles.multiline,
          { color: c.fg, borderColor: c.border, backgroundColor: c.field },
        ]}
        value={text}
        onChangeText={setText}
        multiline
      />

      <View style={styles.row}>
        <Button label="설정 조회" onPress={onFetchConfig} disabled={busy !== null} colors={c} />
        <Button label="텍스트 번역" onPress={onTranslate} disabled={busy !== null} colors={c} />
      </View>

      {busy !== null && (
        <View style={styles.busy}>
          <ActivityIndicator color={c.accent} />
          <Text style={[styles.busyText, { color: c.dim }]}>
            {busy === 'config' ? '설정을 받는 중…' : '번역하는 중…'}
          </Text>
        </View>
      )}

      {/* 결과와 오류는 손대지 않고 그대로 보여준다 — 이 화면의 목적이 그것이다. */}
      {error !== '' && (
        <View style={[styles.box, { borderColor: c.bad, backgroundColor: c.badBg }]}>
          <Text style={[styles.boxTitle, { color: c.bad }]}>오류</Text>
          <Text style={[styles.mono, { color: c.fg }]} selectable>
            {error}
          </Text>
        </View>
      )}

      {result !== '' && (
        <View style={[styles.box, { borderColor: c.border, backgroundColor: c.field }]}>
          <Text style={[styles.boxTitle, { color: c.dim }]}>결과</Text>
          <Text style={[styles.mono, { color: c.fg }]} selectable>
            {result}
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

function Button({
  label,
  onPress,
  disabled,
  colors,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  colors: Palette;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: colors.accent, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
      ]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

/* ---- 모양 ------------------------------------------------------------------ */

interface Palette {
  bg: string;
  fg: string;
  dim: string;
  border: string;
  field: string;
  accent: string;
  bad: string;
  badBg: string;
}

const light: Palette = {
  bg: '#ffffff',
  fg: '#111111',
  dim: '#6b7280',
  border: '#d1d5db',
  field: '#f9fafb',
  accent: '#2563eb',
  bad: '#b91c1c',
  badBg: '#fef2f2',
};

const dark: Palette = {
  bg: '#0b0f14',
  fg: '#e5e7eb',
  dim: '#9ca3af',
  border: '#374151',
  field: '#111827',
  accent: '#3b82f6',
  bad: '#f87171',
  badBg: '#1f1416',
};

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 20, gap: 4 },
  title: { fontSize: 24, fontWeight: '700' },
  sub: { fontSize: 13, marginBottom: 12, lineHeight: 18 },
  label: { fontSize: 12, marginTop: 12, marginBottom: 4 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  multiline: { minHeight: 76, textAlignVertical: 'top' },
  row: { flexDirection: 'row', gap: 10, marginTop: 20 },
  button: { flex: 1, borderRadius: 8, paddingVertical: 13, alignItems: 'center' },
  buttonText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  busy: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16 },
  busyText: { fontSize: 13 },
  box: { borderWidth: 1, borderRadius: 8, padding: 12, marginTop: 16 },
  boxTitle: { fontSize: 11, fontWeight: '700', marginBottom: 6, letterSpacing: 1 },
  mono: { fontFamily: 'monospace', fontSize: 13, lineHeight: 19 },
});

export default App;
