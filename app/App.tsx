/**
 * 앱의 뿌리 — 서버 주소를 들고, 두 화면을 전환한다.
 *
 *   연결 확인   `ui/ConnectScreen.tsx`  — RN → src/api → 서버 경로가 사는가 (스파이크)
 *   실시간 통역 `ui/LiveScreen.tsx`     — 마이크 → WS → 원문 · 번역문 · 번역 음성
 *
 * **연결 확인 화면을 남겨둔 것은 의도다.** 실시간 경로가 안 될 때 "서버는 살아 있다"를
 * 확인할 유일한 수단이라, 실시간 화면이 생겼다고 지우지 않는다.
 *
 * 화면 전환에 네비게이션 라이브러리를 넣지 않았다 — 화면이 둘뿐이라 상태 하나면 된다.
 * 의존성은 한 번에 하나씩만 늘린다(이번에 늘어난 것은 `react-native-audio-api` 하나다).
 *
 * 이 파일이 지고 있는 나머지 두 가지.
 *
 *   1. **환경 주입** — `src/api` 는 전역을 찾지 않는다. RN 의 `fetch` 를 여기서 넘긴다.
 *      캐스팅이 없다는 것이 요점이다 — `FetchLike` 는 Node 의 전역 fetch 와 RN 의 전역
 *      fetch 가 **둘 다 그대로 대입되도록** 구조만 선언해 둔 타입이다.
 *   2. **주소를 박지 않는다** — 서버 주소·API 키·로케일은 app.config.json 에서 오고,
 *      비어 있으면 화면에서 입력받는다. 소스에는 없다.
 */

import { useState } from 'react';
import {
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

import appConfig from './app.config.json';
import { ApiError, StreamError } from './src/api';
import type { ApiClient, FetchLike } from './src/api';
import { ConnectScreen } from './ui/ConnectScreen';
import { LiveScreen } from './ui/LiveScreen';
import { dark, light, ui } from './ui/theme';
import type { Palette } from './ui/theme';

/* ---- 환경 주입 -------------------------------------------------------------- */

const rnFetch: FetchLike = fetch;

/* ---- 설정 ------------------------------------------------------------------- */

const DEFAULT_BASE_URL: string = appConfig.serverUrl;
const DEFAULT_API_KEY: string = appConfig.apiKey;
const LOCALE: string = appConfig.locale;

/**
 * 화면에 띄울 오류 문장.
 *
 * `ApiError`/`StreamError` 면 서버가 요청 로케일로 렌더한 문장이 이미 `message` 에 있다 —
 * 그대로 쓴다. 그 밖(주소 오타·와이파이 끊김 등)은 서버까지 가지 못한 것이라 RN 이 준
 * 문장을 쓴다. 어느 쪽이든 앱이 문장을 지어내지 않는다.
 */
function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    return err.code
      ? `${err.message}\n[${err.code}] HTTP ${err.status}`
      : `${err.message}\nHTTP ${err.status}`;
  }
  if (err instanceof StreamError) {
    return err.code ? `${err.message}\n[${err.code}]` : err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

type Tab = 'connect' | 'live';

function App() {
  const isDark = useColorScheme() === 'dark';
  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <Root isDark={isDark} />
    </SafeAreaProvider>
  );
}

function Root({ isDark }: { isDark: boolean }) {
  const insets = useSafeAreaInsets();
  const colors = isDark ? dark : light;

  const [tab, setTab] = useState<Tab>('connect');
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [apiKey, setApiKey] = useState(DEFAULT_API_KEY);

  /** 두 화면이 같은 주소·키를 쓴다. 주소가 비어 있으면 null 이다. */
  function makeClient(): ApiClient | null {
    const url = baseUrl.trim();
    if (!url) return null;
    const client: ApiClient = { baseUrl: url, fetch: rnFetch };
    if (apiKey.trim()) client.apiKey = apiKey.trim();
    if (LOCALE) client.locale = LOCALE;
    return client;
  }

  return (
    <ScrollView
      style={[ui.root, { backgroundColor: colors.bg }]}
      contentContainerStyle={[
        ui.content,
        { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 },
      ]}
      keyboardShouldPersistTaps="handled">
      <Text style={[ui.title, { color: colors.fg }]}>
        {tab === 'connect' ? '연결 확인' : '실시간 통역'}
      </Text>

      <View style={styles.tabs}>
        <Tab2 label="연결 확인" active={tab === 'connect'} onPress={() => setTab('connect')} colors={colors} />
        <Tab2 label="실시간 통역" active={tab === 'live'} onPress={() => setTab('live')} colors={colors} />
      </View>

      <Text style={[ui.label, { color: colors.dim }]}>서버 주소</Text>
      <TextInput
        style={[ui.input, { color: colors.fg, borderColor: colors.border, backgroundColor: colors.field }]}
        value={baseUrl}
        onChangeText={setBaseUrl}
        placeholder="https://…"
        placeholderTextColor={colors.dim}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />

      <Text style={[ui.label, { color: colors.dim }]}>API 키 (서버에 설정돼 있을 때만)</Text>
      <TextInput
        style={[ui.input, { color: colors.fg, borderColor: colors.border, backgroundColor: colors.field }]}
        value={apiKey}
        onChangeText={setApiKey}
        placeholder="비어 있으면 보내지 않는다"
        placeholderTextColor={colors.dim}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <View style={styles.screen}>
        {/* 두 화면을 동시에 살려두지 않는다 — 실시간 화면이 사라지면 마이크도 함께 닫힌다. */}
        {tab === 'connect' ? (
          <ConnectScreen
            colors={colors}
            makeClient={makeClient}
            locale={LOCALE}
            errorText={errorText}
          />
        ) : (
          <LiveScreen
            colors={colors}
            makeClient={makeClient}
            locale={LOCALE}
            errorText={errorText}
          />
        )}
      </View>
    </ScrollView>
  );
}

/** 화면 전환 탭. 네비게이션 라이브러리 대신 쓰는 두 칸짜리 토글이다. */
function Tab2({
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
        styles.tab,
        {
          borderColor: active ? colors.accent : colors.border,
          backgroundColor: active ? colors.accent : 'transparent',
          opacity: pressed ? 0.7 : 1,
        },
      ]}>
      <Text style={[styles.tabText, active ? styles.tabTextOn : { color: colors.dim }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', gap: 8, marginTop: 12 },
  tab: { flex: 1, borderWidth: 1, borderRadius: 8, paddingVertical: 9, alignItems: 'center' },
  tabText: { fontSize: 14, fontWeight: '600' },
  tabTextOn: { color: '#ffffff' },
  screen: { marginTop: 4 },
});

export default App;
