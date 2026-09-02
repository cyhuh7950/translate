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
  Modal,
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
import { LangLearnSettingsScreen } from './ui/LangLearnSettingsScreen';
import { LearnScreen } from './ui/LearnScreen';
import { LiveScreen } from './ui/LiveScreen';
import { LoginScreen } from './ui/LoginScreen';
import type { LoggedInUser } from './ui/LoginScreen';
import { onLangLearnNotificationPress } from './notifications';
import { SettingsScreen } from './ui/SettingsScreen';
import { SttTrainingScreen } from './ui/SttTrainingScreen';
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

/**
 * 탭을 "기능"과 "설정"으로 가른다. 기능은 메인 화면에 그대로 두고(고르는 일이 잦다),
 * 설정은 한데 모아 별도 팝업(⚙️ 버튼 → `Modal`)에서 처리한다 — 여섯 개를 한 줄에
 * 다 욱여넣으면 글자가 두 줄로 깨진다(실기기 실측).
 */
type FeatureTab = 'connect' | 'live' | 'learn';
type SettingsTab = 'settings' | 'learnSettings' | 'login' | 'sttTraining';

/** 탭 표시 방식. 아이콘은 새 의존성 없이 이모지로 그린다. */
type TabDisplay = 'text' | 'icon';

interface TabMeta<T extends string> {
  id: T;
  label: string;
  /** 이모지 하나. `tabDisplay==='icon'` 일 때 label 대신 이걸 쓴다. */
  icon: string;
}

/** 탭 이름이자 화면 제목. 순서가 곧 화면에 놓이는 순서다. */
const FEATURE_TABS: TabMeta<FeatureTab>[] = [
  { id: 'connect', label: '연결 확인', icon: '🔌' },
  { id: 'live', label: '실시간 통역', icon: '🎙️' },
  // 언어 학습 세션 (DESIGN.md §15). 번역 기능과 무관해 맨 뒤에 둔다.
  { id: 'learn', label: '학습 세션', icon: '📝' },
];

const SETTINGS_TABS: TabMeta<SettingsTab>[] = [
  { id: 'settings', label: '번역 설정', icon: '🌐' },
  { id: 'learnSettings', label: '학습 설정', icon: '🎛️' },
  { id: 'login', label: '학습 로그인', icon: '👤' },
  // 계정 단위 화면이라 학습 로그인과 같은 묶음에 둔다(서버쪽 권고,
  // MESSAGE_TO_APP.md 2026-08-30 2차 답변) — 언어학습(학습 세션)과는 목적이 다르다.
  { id: 'sttTraining', label: 'STT 학습', icon: '🗣️' },
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
  const [tab, setTab] = useState<FeatureTab>('connect');
  /** ⚙️ 버튼으로 여는 설정 팝업. 열려 있지 않으면 null, 열려 있으면 그 안의 활성 탭. */
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [tabDisplay, setTabDisplay] = useState<TabDisplay>('text');
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
      if (saved.tabDisplay !== undefined) setTabDisplay(saved.tabDisplay);
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
    storage.save({
      serverUrl: baseUrl,
      apiKey,
      locale: LOCALE,
      form,
      user: user ?? undefined,
      tabDisplay,
    });
  }, [restored, baseUrl, apiKey, form, user, tabDisplay]);

  // 학습 알림을 탭하면(포그라운드든 콜드 스타트든) 학습 세션 화면으로 바로 들어간다
  // (DESIGN.md §15 — "알림 탭 → 학습 세션 화면으로 진입"). 로그인이 안 돼 있으면
  // LearnScreen 이 스스로 그 사실을 안내한다.
  useEffect(() => onLangLearnNotificationPress(() => setTab('learn')), []);

  /** 세 화면이 같은 주소·키를 쓴다. 주소가 비어 있으면 null 이다. */
  const makeClient = useCallback((): ApiClient | null => {
    const url = baseUrl.trim();
    if (!url) return null;
    const client: ApiClient = {
      baseUrl: url,
      fetch: rnFetch,
      formData: () => new FormData(),
    };
    if (apiKey.trim()) client.apiKey = apiKey.trim();
    if (LOCALE) client.locale = LOCALE;
    return client;
  }, [baseUrl, apiKey]);

  const shared = { colors, makeClient, locale: LOCALE, errorText };
  const active = FEATURE_TABS.find(t => t.id === tab);
  const activeSettings = SETTINGS_TABS.find(t => t.id === settingsTab);

  /** 설정 팝업 안에서 고른 화면 하나. `tab === null` 이면(팝업이 처음 열리기 전) 아무것도 없다. */
  function renderSettingsScreen() {
    if (settingsTab === 'settings') {
      return (
        <SettingsScreen
          {...shared}
          config={config}
          onConfig={setConfig}
          models={models}
          onModels={setModels}
          form={form}
          onForm={setForm}
        />
      );
    }
    if (settingsTab === 'learnSettings') {
      return <LangLearnSettingsScreen {...shared} user={user} config={config} onConfig={setConfig} />;
    }
    if (settingsTab === 'login') {
      return <LoginScreen {...shared} user={user} onUser={setUser} />;
    }
    if (settingsTab === 'sttTraining') {
      return <SttTrainingScreen {...shared} user={user} config={config} onConfig={setConfig} />;
    }
    return null;
  }

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

      <View style={styles.brandRow}>
        <View style={[styles.brandMark, { backgroundColor: colors.accent }]}>
          <Text style={styles.brandMarkText}>↗</Text>
        </View>
        <View>
          <Text style={[styles.brandName, { color: colors.fg }]}>Translate</Text>
          <Text style={[styles.brandTagline, { color: colors.dim }]}>말이 통하는 순간</Text>
        </View>
      </View>

      <Text style={[ui.title, { color: colors.fg }]}>
        {active ? active.label : ''}
      </Text>

      <View style={styles.tabs}>
        {FEATURE_TABS.map(t => (
          <TabButton
            key={t.id}
            meta={t}
            display={tabDisplay}
            active={tab === t.id}
            onPress={() => setTab(t.id)}
            colors={colors}
          />
        ))}
        {/* 설정 세 개(번역 설정·학습 설정·학습 로그인)는 여기 모아 팝업으로 연다 —
            메인 탭 줄에 다 넣으면 여섯 개라 글자가 두 줄로 깨진다. */}
        <TabButton
          meta={{ label: '설정', icon: '⚙️' }}
          display={tabDisplay}
          active={false}
          onPress={() => setSettingsTab(prev => prev ?? 'settings')}
          colors={colors}
        />
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
        {tab === 'live' && (
          <LiveScreen {...shared} onConfig={setConfig} form={form} models={models} />
        )}
        {tab === 'learn' && <LearnScreen {...shared} user={user} onConfig={setConfig} />}
      </View>

      <Modal
        visible={settingsTab !== null}
        animationType="slide"
        onRequestClose={() => setSettingsTab(null)}>
        <View style={[styles.modalRoot, { backgroundColor: colors.bg, paddingTop: insets.top + 16 }]}>
          <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
            <View style={styles.modalHeader}>
              <Text style={[ui.title, { color: colors.fg }]}>
                {activeSettings ? activeSettings.label : '설정'}
              </Text>
              <Pressable onPress={() => setSettingsTab(null)} style={styles.closeButton}>
                <Text style={[styles.closeText, { color: colors.dim }]}>닫기 ✕</Text>
              </Pressable>
            </View>

            <View style={styles.tabs}>
              {SETTINGS_TABS.map(t => (
                <TabButton
                  key={t.id}
                  meta={t}
                  display={tabDisplay}
                  active={settingsTab === t.id}
                  onPress={() => setSettingsTab(t.id)}
                  colors={colors}
                />
              ))}
            </View>

            {/* 탭 표시 방식 — 글자/아이콘. 메인 탭·이 팝업 탭 둘 다에 적용된다. */}
            <View style={styles.displayRow}>
              <Text style={[ui.label, styles.displayLabel, { color: colors.dim }]}>탭 표시</Text>
              <View style={styles.displayChips}>
                <DisplayChip
                  label="글자"
                  active={tabDisplay === 'text'}
                  onPress={() => setTabDisplay('text')}
                  colors={colors}
                />
                <DisplayChip
                  label="아이콘"
                  active={tabDisplay === 'icon'}
                  onPress={() => setTabDisplay('icon')}
                  colors={colors}
                />
              </View>
            </View>

            <View style={styles.screen}>{renderSettingsScreen()}</View>
          </ScrollView>
        </View>
      </Modal>
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

/**
 * 화면 전환 탭. 네비게이션 라이브러리 대신 쓰는 토글이다.
 *
 * `tabDisplay==='icon'` 이면 글자 대신 이모지 하나만 그린다 — 탭이 여섯 개일 때 글자가
 * 두 줄로 깨지던 것(실기기 실측)을 피하는 용도라, 아이콘 모드에서는 글씨를 아예 안 쓴다.
 * 글자 모드에서도 크기를 12로 줄여 좁은 폭에서 덜 깨지게 한다.
 */
function TabButton({
  meta,
  display,
  active,
  onPress,
  colors,
}: {
  meta: { label: string; icon: string };
  display: TabDisplay;
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
      <Text
        style={[
          display === 'icon' ? styles.tabIcon : styles.tabText,
          active ? styles.tabTextOn : { color: colors.dim },
        ]}
        numberOfLines={display === 'icon' ? 1 : 2}>
        {display === 'icon' ? meta.icon : meta.label}
      </Text>
    </Pressable>
  );
}

/** "탭 표시" 글자/아이콘 선택 칩. `ui/SettingsScreen.tsx` 의 `Chip` 과 같은 모양이다. */
function DisplayChip({
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
        styles.displayChip,
        {
          borderColor: active ? colors.accent : colors.border,
          backgroundColor: active ? colors.accent : 'transparent',
          opacity: pressed ? 0.7 : 1,
        },
      ]}>
      <Text style={active ? styles.displayChipTextOn : { color: colors.fg }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18, marginBottom: 4 },
  brandMark: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  brandMarkText: { color: '#FFFFFF', fontSize: 22, fontWeight: '800' },
  brandName: { fontSize: 17, fontWeight: '800', letterSpacing: -0.2 },
  brandTagline: { fontSize: 11, marginTop: 1 },
  tabs: { flexDirection: 'row', gap: 8, marginTop: 14 },
  tab: { flex: 1, borderWidth: 1, borderRadius: 14, paddingVertical: 11, paddingHorizontal: 2, alignItems: 'center' },
  tabText: { fontSize: 12, fontWeight: '700', textAlign: 'center' },
  tabIcon: { fontSize: 20 },
  tabTextOn: { color: '#ffffff' },
  screen: { marginTop: 4 },
  modeSwitch: { flexDirection: 'row', gap: 8, paddingHorizontal: 20 },
  interpretRoot: { flex: 1 },
  interpretBody: { flex: 1, marginTop: 8 },
  modalRoot: { flex: 1 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  closeButton: { paddingHorizontal: 12, paddingVertical: 8 },
  closeText: { fontSize: 15, fontWeight: '600' },
  displayRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16 },
  displayLabel: { marginTop: 0 },
  displayChips: { flexDirection: 'row', gap: 8 },
  displayChip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  displayChipTextOn: { color: '#ffffff', fontWeight: '600' },
});

export default App;
