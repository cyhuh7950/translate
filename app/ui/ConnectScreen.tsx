/**
 * 연결 확인 화면 (스파이크).
 *
 * 이 화면이 보려는 것은 딱 하나 — **실기기에서 RN → src/api → 서버 경로가 사는가.**
 * 그래서 여기에는 오디오도 WebSocket 도 없다. 대신 두 가지를 누를 수 있다.
 *
 *   설정 조회   GET /v1/config    → 프로필 수 · 엔진 수 · 언어 수
 *   텍스트 번역  POST /v1/translate/text
 *
 * **실시간 화면이 안 될 때 "서버는 살아 있다"를 확인할 유일한 수단이다.** 실시간 경로를
 * 붙였다고 이 화면을 지우지 않는 이유가 그것이다.
 *
 * 세 가지 원칙이 여기서 실제로 지켜지는지도 함께 본다.
 *
 *   1. **주입** — `src/api` 는 전역을 찾지 않는다. RN 의 `fetch` 를 App.tsx 가 넘긴다.
 *   2. **주소를 박지 않는다** — 기본값은 소스가 아니라 app.config.json 에서 온다.
 *   3. **문구를 만들지 않는다** — 번역 언어는 설정 화면에서 고른 값(고르지 않았으면
 *      `/v1/config` 의 세션 기본값)이고, 오류는 서버가 로케일로 렌더한 `detail` 을
 *      그대로 띄운다. 앱에 카탈로그가 없다.
 */

import { useState } from 'react';
import { ActivityIndicator, Text, TextInput, View } from 'react-native';

import { availableProfiles, fetchConfig, readyEngines, translateText } from '../src/api';
import type { ApiClient, ServerConfig } from '../src/api';
import { Button } from './Button';
import { chosenLanguages } from './settings';
import type { Settings } from './settings';
import { ui } from './theme';
import type { Palette } from './theme';

export function ConnectScreen({
  colors,
  makeClient,
  locale,
  errorText,
  config,
  onConfig,
  form,
}: {
  colors: Palette;
  /** 서버 주소·API 키는 App.tsx 가 들고 있다 — 세 화면이 같은 값을 쓴다. */
  makeClient: () => ApiClient | null;
  locale: string;
  errorText: (err: unknown) => string;
  /** `/v1/config` 응답도 App.tsx 가 들고 있다 — 설정 화면과 같은 것을 본다. */
  config: ServerConfig | null;
  onConfig: (config: ServerConfig) => void;
  /** 설정 화면에서 고른 값. 번역 버튼이 쓸 언어가 여기서 나온다. */
  form: Settings;
}) {
  const [text, setText] = useState('안녕하세요, 오늘 회의는 세 시에 시작합니다.');

  const [busy, setBusy] = useState<'config' | 'translate' | null>(null);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');

  function begin(which: 'config' | 'translate'): ApiClient | null {
    if (busy) return null;
    const client = makeClient();
    if (!client) {
      setResult('');
      setError('서버 주소를 입력하세요.');
      return null;
    }
    setResult('');
    setError('');
    setBusy(which);
    return client;
  }

  async function onFetchConfig() {
    const client = begin('config');
    if (!client) return;
    try {
      const cfg = await fetchConfig(client);
      onConfig(cfg);
      const langs = chosenLanguages(cfg, form);
      setResult(
        [
          `server_id     ${cfg.server_id}`,
          `locale        ${cfg.locale}   (요청 ${locale || '없음'})`,
          `프로필         ${availableProfiles(cfg).length} / ${cfg.profiles.length} 사용 가능`,
          `엔진           ${readyEngines(cfg).length} / ${cfg.engines.length} 준비됨`,
          `언어           ${cfg.languages.length}`,
          `세션 기본값     ${cfg.session.default_source_lang} → ${cfg.session.default_target_lang}` +
            `  (${cfg.session.default_profile} / ${cfg.session.default_mode})`,
          `고른 언어      ${langs.source} → ${langs.target}   (설정 화면)`,
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
    const client = begin('translate');
    if (!client) return;
    try {
      // 언어 코드도 소스에 없다. 아직 조회하지 않았으면 지금 조회한다.
      const cfg = config ?? (await fetchConfig(client));
      onConfig(cfg);

      // 설정 화면에서 고른 언어로 번역한다 — 고르지 않았으면 서버의 세션 기본값이다.
      const langs = chosenLanguages(cfg, form);
      const out = await translateText(client, {
        text,
        source_lang: langs.source,
        target_lang: langs.target,
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
    <View>
      <Text style={[ui.sub, { color: colors.dim }]}>
        RN → src/api → 서버 경로가 사는지만 본다. 실시간 화면이 막혔을 때 서버가 살아 있는지
        여기서 확인한다.
      </Text>

      <Text style={[ui.label, { color: colors.dim }]}>번역할 문장</Text>
      <TextInput
        style={[
          ui.input,
          ui.multiline,
          { color: colors.fg, borderColor: colors.border, backgroundColor: colors.field },
        ]}
        value={text}
        onChangeText={setText}
        multiline
      />

      <View style={ui.row}>
        <Button
          label="설정 조회"
          onPress={onFetchConfig}
          disabled={busy !== null}
          colors={colors}
        />
        <Button
          label="텍스트 번역"
          onPress={onTranslate}
          disabled={busy !== null}
          colors={colors}
        />
      </View>

      {busy !== null && (
        <View style={ui.busy}>
          <ActivityIndicator color={colors.accent} />
          <Text style={[ui.busyText, { color: colors.dim }]}>
            {busy === 'config' ? '설정을 받는 중…' : '번역하는 중…'}
          </Text>
        </View>
      )}

      {/* 결과와 오류는 손대지 않고 그대로 보여준다 — 이 화면의 목적이 그것이다. */}
      {error !== '' && (
        <View style={[ui.box, { borderColor: colors.bad, backgroundColor: colors.badBg }]}>
          <Text style={[ui.boxTitle, { color: colors.bad }]}>오류</Text>
          <Text style={[ui.mono, { color: colors.fg }]} selectable>
            {error}
          </Text>
        </View>
      )}

      {result !== '' && (
        <View style={[ui.box, { borderColor: colors.border, backgroundColor: colors.field }]}>
          <Text style={[ui.boxTitle, { color: colors.dim }]}>결과</Text>
          <Text style={[ui.mono, { color: colors.fg }]} selectable>
            {result}
          </Text>
        </View>
      )}
    </View>
  );
}
