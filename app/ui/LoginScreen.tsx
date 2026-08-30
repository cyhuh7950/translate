/**
 * 언어 학습 계정 로그인 화면 (`DESIGN.md` §15, `PLAN_LANG_LEARN.md` 앱 작업 1번).
 *
 * **계정 가입이 아니다.** 번역 기능은 이 로그인과 무관하게 그대로 API 키만으로 동작한다
 * (기존 방식 유지). 이 화면은 그 위에 얹히는 언어 학습 전용 계층 — 같은 서버를 쓰는
 * 여러 사람을 이름+PIN 으로만 가르는 용도다.
 *
 * 서버(`POST /v1/users`, `/v1/users/login`)는 세션 토큰을 내주지 않는다 —
 * 로그인은 `user_id` 만 돌려주고, 이후 그 사람 것으로 스코프해야 하는 요청에
 * 앱이 그 값을 실어 보낸다. 그래서 여기 남기는 것도 `user_id` 와 이름뿐이고,
 * PIN 은 요청이 끝나면 버린다(`storage.ts`).
 */

import { useState } from 'react';
import { ActivityIndicator, Text, TextInput, View } from 'react-native';

import { loginUser, registerUser } from '../src/api';
import type { ApiClient } from '../src/api';
import { Button } from './Button';
import { ui } from './theme';
import type { Palette } from './theme';

export interface LoggedInUser {
  id: string;
  name: string;
}

export function LoginScreen({
  colors,
  makeClient,
  errorText,
  user,
  onUser,
}: {
  colors: Palette;
  makeClient: () => ApiClient | null;
  errorText: (err: unknown) => string;
  /** 로그인돼 있으면 App.tsx 가 기기에서 읽어 넘겨준다. */
  user: LoggedInUser | null;
  onUser: (user: LoggedInUser | null) => void;
}) {
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState<'register' | 'login' | null>(null);
  const [error, setError] = useState('');

  function begin(which: 'register' | 'login'): ApiClient | null {
    if (busy) return null;
    const client = makeClient();
    if (!client) {
      setError('서버 주소를 입력하세요.');
      return null;
    }
    if (!name.trim() || !pin.trim()) {
      setError('이름과 PIN을 모두 입력하세요.');
      return null;
    }
    setError('');
    setBusy(which);
    return client;
  }

  async function onRegister() {
    const client = begin('register');
    if (!client) return;
    try {
      const created = await registerUser(client, { name: name.trim(), pin });
      // 등록만으로 로그인이 되지는 않는다 — 서버가 세션을 만들지 않으므로 곧바로
      // 다시 로그인해 user_id 를 받는다. 사용자 입장에서는 한 번의 동작으로 보인다.
      const userId = await loginUser(client, { name: created.name, pin });
      setPin('');
      onUser({ id: userId, name: created.name });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function onLogin() {
    const client = begin('login');
    if (!client) return;
    try {
      const userId = await loginUser(client, { name: name.trim(), pin });
      setPin('');
      onUser({ id: userId, name: name.trim() });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  if (user) {
    return (
      <View>
        <Text style={[ui.sub, { color: colors.dim }]}>
          언어 학습 계정으로 로그인돼 있다. 번역 기능은 이 로그인과 무관하게 그대로 쓸 수 있다.
        </Text>
        <View style={[ui.box, { borderColor: colors.border, backgroundColor: colors.field }]}>
          <Text style={[ui.boxTitle, { color: colors.dim }]}>로그인됨</Text>
          <Text style={[ui.mono, { color: colors.fg }]}>{user.name}</Text>
        </View>
        <Button label="로그아웃" onPress={() => onUser(null)} disabled={false} colors={colors} />
      </View>
    );
  }

  return (
    <View>
      <Text style={[ui.sub, { color: colors.dim }]}>
        계정 가입이 아니다 — 같은 서버를 쓰는 사람을 이름+PIN 으로 가를 뿐이다. 번역
        기능은 이 로그인 없이도 그대로 동작한다.
      </Text>

      <Text style={[ui.label, { color: colors.dim }]}>이름</Text>
      <TextInput
        style={[ui.input, { color: colors.fg, borderColor: colors.border, backgroundColor: colors.field }]}
        value={name}
        onChangeText={setName}
        placeholder="예: 철수"
        placeholderTextColor={colors.dim}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={[ui.label, { color: colors.dim }]}>PIN</Text>
      <TextInput
        style={[ui.input, { color: colors.fg, borderColor: colors.border, backgroundColor: colors.field }]}
        value={pin}
        onChangeText={setPin}
        placeholder="숫자 4자리 이상"
        placeholderTextColor={colors.dim}
        keyboardType="number-pad"
        secureTextEntry
      />

      <View style={ui.row}>
        <Button label="로그인" onPress={onLogin} disabled={busy !== null} colors={colors} />
        <Button
          label="처음이면 등록"
          onPress={onRegister}
          disabled={busy !== null}
          colors={colors}
        />
      </View>

      {busy !== null && (
        <View style={ui.busy}>
          <ActivityIndicator color={colors.accent} />
          <Text style={[ui.busyText, { color: colors.dim }]}>
            {busy === 'register' ? '등록하는 중…' : '로그인하는 중…'}
          </Text>
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
    </View>
  );
}
