/**
 * 앱의 뿌리 — 서버 주소와 **고른 설정**을 들고, 세 화면을 전환한다.
 *
 *   연결 확인   `ui/ConnectScreen.tsx`  — RN → src/api → 서버 경로가 사는가 (스파이크)
 *   설정        `ui/SettingsScreen.tsx` — 통역할 언어·프로필·모드·엔진을 고른다
 *   실시간 통역 `ui/LiveScreen.tsx`     — 마이크 → WS → 원문 · 번역문 · 번역 음성
 *
 * **연결 확인 화면을 남겨둔 것은 의도다.** 실시간 경로가 안 될 때 "서버는 살아 있다"를
 * 확인할 유일한 수단이라, 실시간 화면이 생겼다고 지우지 않는다.
 *
 * 화면 전환에 네비게이션 라이브러리를 넣지 않았다 — 상태 하나로 충분하다. 셋으로 늘어난
 * 지금도 마찬가지다. 의존성은 한 번에 하나씩만 늘린다(마지막으로 늘어난 것은
 * `react-native-audio-api` 하나이고, 설정 화면은 아무것도 더하지 않았다).
 *
 * 이 파일이 지고 있는 나머지 세 가지.
 *
 *   1. **환경 주입** — `src/api` 는 전역을 찾지 않는다. RN 의 `fetch` 를 여기서 넘긴다.
 *      캐스팅이 없다는 것이 요점이다 — `FetchLike` 는 Node 의 전역 fetch 와 RN 의 전역
 *      fetch 가 **둘 다 그대로 대입되도록** 구조만 선언해 둔 타입이다.
 *   2. **주소를 박지 않는다** — 서버 주소·API 키·로케일은 app.config.json 에서 오고,
 *      비어 있으면 화면에서 입력받는다. 소스에는 없다.
 *
 *      **그 파일을 고칠 필요는 없다.** 한 번 입력하면 기기에 남아 다음부터 채워진다
 *      (`storage.ts`). 추적되는 파일이라 실제 API 키를 적으면 커밋에 섞일 위험이
 *      있었는데, 저장이 생기면서 그 이유가 없어졌다. 비워 둔 채로 두는 것을 권한다.
 *   3. **고른 설정을 들고 있는다** — 설정 화면이 고치고, 나머지 두 화면이 읽는다.
 *      화면을 오가도 값이 남아야 하기 때문에 여기에 둔다. 그리고 **앱을 껐다 켜도 남는다** —
 *      시작할 때 한 번 읽고, 바뀔 때마다 남긴다 (아래 두 effect).
 */

import { useCallback, useEffect, useState } from 'react';
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
import type { ApiClient, FetchLike, ModelsResponse, ServerConfig } from './src/api';
import { ConnectScreen } from './ui/ConnectScreen';
import { FaceToFaceScreen } from './ui/FaceToFaceScreen';
import { LiveScreen } from './ui/LiveScreen';
import { LoginScreen } from './ui/LoginScreen';
import type { LoggedInUser } from './ui/LoginScreen';
import { SettingsScreen } from './ui/SettingsScreen';
import type { Settings } from './ui/settings';
import * as storage from './storage';
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

/**
 * 앱 최상단 모드. 번역모드는 지금까지의 화면 그대로고, 통역모드는 마주 보고 쓰는
 * `FaceToFaceScreen` 하나뿐이다 — 그 화면은 화면 전체를 차지해야 해서(위/아래 반씩)
 * 탭·서버 주소 입력이 함께 있는 스크롤 레이아웃과 같이 두지 않는다.
 */
type AppMode = 'translate' | 'interpret';

type Tab = 'connect' | 'settings' | 'live' | 'login';

/** 탭 이름이자 화면 제목. 순서가 곧 화면에 놓이는 순서다. */
const TABS: { id: Tab; label: string }[] = [
  { id: 'connect', label: '연결 확인' },
  { id: 'settings', label: '설정' },
  { id: 'live', label: '실시간 통역' },
  // 언어 학습 계정 (DESIGN.md §15). 번역 기능과 무관해 맨 뒤에 둔다.
  { id: 'login', label: '학습 로그인' },
];

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

  const [mode, setMode] = useState<AppMode>('translate');
  const [tab, setTab] = useState<Tab>('connect');
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [apiKey, setApiKey] = useState(DEFAULT_API_KEY);

  /**
   * 화면들이 공유하는 두 가지.
   *
   *   config  마지막으로 받은 `/v1/config`. 설정 화면이 이것으로 폼을 만들고,
   *           실시간 화면이 세션을 열 때 받아온 것을 여기에 다시 넣어준다.
   *   form    사용자가 고른 값. 비어 있으면 전부 서버 기본값이라는 뜻이다.
   */
  const [config, setConfig] = useState<ServerConfig | null>(null);
  // `GET /v1/models` 결과. `/v1/config` 와 따로 받는다 — 프로바이더 9곳에 물어보는
  // 응답이라 앱 시작 경로에 두면 그만큼 늦어진다. 설정 화면이 받아 여기 올려두면
  // 실시간 화면도 같은 것을 본다(고른 모델이 세션에 실려야 하므로).
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [form, setForm] = useState<Settings>({});
  /** 언어 학습 계정 (`ui/LoginScreen.tsx`). 로그인 안 했으면 null — 번역 기능은 그대로 쓴다. */
  const [user, setUser] = useState<LoggedInUser | null>(null);

  /**
   * 기기에 남겨둔 값을 한 번 읽어온다.
   *
   * 저장이 없던 동안 서버 주소를 앱을 켤 때마다 다시 입력해야 했다 — 고를 것이 많아진
   * 지금은 더 거슬린다. 읽기가 끝날 때까지는 `app.config.json` 의 값으로 시작하고,
   * 남긴 것이 있으면 그것으로 덮는다. **읽지 못해도 그냥 기본값으로 간다**
   * (`storage.ts` 는 던지지 않는다).
   */
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    let alive = true;
    storage.load().then(saved => {
      if (!alive) return;
      if (saved.serverUrl !== undefined) setBaseUrl(saved.serverUrl);
      if (saved.apiKey !== undefined) setApiKey(saved.apiKey);
      if (saved.form !== undefined) setForm(saved.form);
      if (saved.user !== undefined) setUser(saved.user);
      setRestored(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * 바뀌면 남긴다.
   *
   * `restored` 를 기다리는 이유 — 읽기가 끝나기 전에 저장하면, 아직 기본값인 상태가
   * 남긴 값을 덮어써 저장이 무의미해진다. 실제로 순서를 지키지 않으면 그렇게 된다.
   */
  useEffect(() => {
    if (!restored) return;
    storage.save({ serverUrl: baseUrl, apiKey, locale: LOCALE, form, user: user ?? undefined });
  }, [restored, baseUrl, apiKey, form, user]);

  /** 세 화면이 같은 주소·키를 쓴다. 주소가 비어 있으면 null 이다. */
  const makeClient = useCallback((): ApiClient | null => {
    const url = baseUrl.trim();
    if (!url) return null;
    const client: ApiClient = { baseUrl: url, fetch: rnFetch };
    if (apiKey.trim()) client.apiKey = apiKey.trim();
    if (LOCALE) client.locale = LOCALE;
    return client;
  }, [baseUrl, apiKey]);

  const shared = { colors, makeClient, locale: LOCALE, errorText };
  const active = TABS.find(t => t.id === tab);

  function modeSwitch(topPadding: number) {
    return (
      <View style={[styles.modeSwitch, { paddingTop: topPadding }]}>
        <ModeButton
          label="번역모드"
          active={mode === 'translate'}
          onPress={() => setMode('translate')}
          colors={colors}
        />
        <ModeButton
          label="통역모드"
          active={mode === 'interpret'}
          onPress={() => setMode('interpret')}
          colors={colors}
        />
      </View>
    );
  }

  // 통역모드는 화면 전체(위/아래 반씩)를 쓴다 — 스크롤·탭·주소 입력과 같이 두지 않는다.
  if (mode === 'interpret') {
    return (
      <View style={[styles.interpretRoot, { backgroundColor: colors.bg }]}>
        {modeSwitch(insets.top + 12)}
        <View style={styles.interpretBody}>
          <FaceToFaceScreen {...shared} onConfig={setConfig} form={form} models={models} />
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      style={[ui.root, { backgroundColor: colors.bg }]}
      contentContainerStyle={[
        ui.content,
        { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 },
      ]}
      keyboardShouldPersistTaps="handled">
      {modeSwitch(0)}

      <Text style={[ui.title, { color: colors.fg }]}>
        {active ? active.label : ''}
      </Text>

      <View style={styles.tabs}>
        {TABS.map(t => (
          <TabButton
            key={t.id}
            label={t.label}
            active={tab === t.id}
            onPress={() => setTab(t.id)}
            colors={colors}
          />
        ))}
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
        {/* 화면을 동시에 살려두지 않는다 — 실시간 화면이 사라지면 마이크도 함께 닫힌다. */}
        {tab === 'connect' && (
          <ConnectScreen {...shared} config={config} onConfig={setConfig} form={form} />
        )}
        {tab === 'settings' && (
          <SettingsScreen
            {...shared}
            config={config}
            onConfig={setConfig}
            models={models}
            onModels={setModels}
            form={form}
            onForm={setForm}
          />
        )}
        {tab === 'live' && (
          <LiveScreen {...shared} onConfig={setConfig} form={form} models={models} />
        )}
        {tab === 'login' && (
          <LoginScreen {...shared} user={user} onUser={setUser} />
        )}
      </View>
    </ScrollView>
  );
}

/** 번역모드/통역모드 전환. `TabButton` 과 모양은 같지만 최상단 모드라 따로 둔다. */
function ModeButton({
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

/** 화면 전환 탭. 네비게이션 라이브러리 대신 쓰는 토글이다. */
function TabButton({
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
  modeSwitch: { flexDirection: 'row', gap: 8, paddingHorizontal: 20 },
  interpretRoot: { flex: 1 },
  interpretBody: { flex: 1, marginTop: 8 },
});

export default App;
