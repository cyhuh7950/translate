/**
 * `ui/LangLearnSettingsScreen.tsx` 배선 검사.
 *
 * GET 으로 받아온 값을 편집해서 PUT 으로 돌려보내는지, 그리고 저장에 성공하면
 * 기기 알림을 그 스케줄로 다시 예약하는지(`notifications.ts` 의
 * `scheduleLangLearnNotifications`, notifee 는 jest 설정이 공식 목으로 바꿔 끼운다)를 본다.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import { LangLearnSettingsScreen } from '../ui/LangLearnSettingsScreen';
import { light } from '../ui/theme';
import type { ServerConfig } from '../src/api';

const common = {
  colors: light,
  errorText: (err: unknown) => String(err),
};

const USER = { id: 'user-1', name: '철수' };

const INITIAL_SETTINGS = {
  schedule: [{ time: '08:00', count: 3 }],
  target_lang: 'en',
  level_mode: 'adaptive',
  manual_level: null,
  feedback_mode: 'both',
  show_text_for_repeat: false,
};

function fakeConfig(): ServerConfig {
  return {
    server_id: 'test',
    locale: 'ko',
    session: {
      default_profile: 'oneway',
      default_mode: 'batch',
      allow_profile_override: true,
      allow_mode_override: true,
      default_source_lang: 'aa',
      default_target_lang: 'bb',
    },
    languages: [
      { code: 'en', label: '영어' },
      { code: 'ja', label: '일본어' },
    ],
    profiles: [],
    engines: [],
    llm: { default_provider: 'alpha', style: 'natural', styles: ['natural'], context_turns: 4, providers: [] },
    implementations: {},
    routing: { policy: 'x', available: [] },
    audio: { stt_sample_rate: 16000, stt_channels: 1, tts_response_format: 'wav' },
    vad: { backend: 'energy', available: ['energy'], silence_ms: 600, min_speech_ms: 250 },
    audio_filter: { enabled: false, implementation: 'none', available: [] },
    turn: { default_policy: 'half_duplex', available: ['half_duplex'] },
    speaker_id: {
      default: 'manual',
      available: ['manual'],
      policy: 'off',
      policies: ['off'],
      threshold: 0.5,
      auto_enroll: false,
      enrolled: 0,
      store_error: null,
    },
    client: { input_modes: ['ptt', 'handsfree'], default_input_mode: 'ptt' },
    stream: { path: '/v1/stream', input_format: 'pcm16', client_frame_ms: 20 },
    lang_learn: {
      stream: { path: '/v1/lang_learn/stream', default_count: 5 },
      levels: ['beginner', 'intermediate', 'advanced'],
      defaults: INITIAL_SETTINGS,
      answer_type_pattern: ['repeat', 'compose'],
    },
  };
}

function fakeClient(config: ServerConfig, requests: { method: string; url: string; body?: unknown }[]) {
  return {
    baseUrl: 'http://server.test',
    fetch: async (url: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method || 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      requests.push({ method, url, body });

      const responseBody = url.includes('/lang_learn/settings')
        ? method === 'PUT'
          ? { ...INITIAL_SETTINGS, ...body }
          : INITIAL_SETTINGS
        : config;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify(responseBody),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    },
  };
}

function findButtonByLabel(
  tree: ReactTestRenderer.ReactTestRenderer,
  label: string,
): ReactTestRenderer.ReactTestInstance {
  let node: ReactTestRenderer.ReactTestInstance | null = tree.root.findAll(
    n => n.props?.children === label,
  )[0]!;
  while (node && typeof node.props?.onPress !== 'function') node = node.parent;
  if (!node) throw new Error(`버튼을 찾지 못했다: ${label}`);
  return node;
}

test('설정을 불러와 학습 언어를 바꿔 저장하면 PUT으로 나가고 알림을 다시 예약한다', async () => {
  const config = fakeConfig();
  const requests: { method: string; url: string; body?: unknown }[] = [];
  const client = fakeClient(config, requests);
  const notifee = require('@notifee/react-native').default;
  jest.clearAllMocks();
  notifee.getTriggerNotificationIds.mockResolvedValue([]);

  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <LangLearnSettingsScreen
        {...common}
        makeClient={() => client}
        user={USER}
        config={config}
        onConfig={() => {}}
      />,
    );
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  });

  // 목표어를 일본어로 바꾼다.
  const jaChip = tree!.root.findAll(n => n.props?.testID === 'chip:ja')[0]!;
  await ReactTestRenderer.act(async () => {
    jaChip.props.onPress();
  });

  const save = findButtonByLabel(tree!, '저장');
  await ReactTestRenderer.act(async () => {
    save.props.onPress();
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  });

  const put = requests.find(r => r.method === 'PUT');
  expect(put).toBeDefined();
  expect((put!.body as { target_lang: string }).target_lang).toBe('ja');
  expect((put!.body as { schedule: unknown[] }).schedule).toEqual([{ time: '08:00', count: 3 }]);

  expect(notifee.createTriggerNotification).toHaveBeenCalledTimes(1);
  const [, trigger] = notifee.createTriggerNotification.mock.calls[0];
  expect(trigger.timestamp).toBeGreaterThan(0);

  const texts = tree!.root.findAll(n => typeof n.props?.children === 'string').map(n => String(n.props.children));
  expect(texts.some(t => t.includes('저장했다'))).toBe(true);
});

test('시간대를 추가/삭제할 수 있다', async () => {
  const config = fakeConfig();
  const requests: { method: string; url: string; body?: unknown }[] = [];
  const client = fakeClient(config, requests);

  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <LangLearnSettingsScreen
        {...common}
        makeClient={() => client}
        user={USER}
        config={config}
        onConfig={() => {}}
      />,
    );
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  });

  const add = findButtonByLabel(tree!, '시간대 추가');
  await ReactTestRenderer.act(async () => {
    add.props.onPress();
  });

  // 테스트 렌더러가 host 컴포넌트를 감싸는 계층까지 같이 잡아 testID 하나당 노드가
  // 둘씩(합성+host) 나온다 — 있고 없고만 본다.
  expect(tree!.root.findAll(n => n.props?.testID === 'slot-time-0').length).toBeGreaterThan(0);
  expect(tree!.root.findAll(n => n.props?.testID === 'slot-time-1').length).toBeGreaterThan(0);

  const remove = tree!.root.findAll(n => n.props?.testID === 'slot-remove-0' && typeof n.props?.onPress === 'function')[0]!;
  await ReactTestRenderer.act(async () => {
    remove.props.onPress();
  });

  expect(tree!.root.findAll(n => n.props?.testID === 'slot-time-1').length).toBe(0);
  expect(tree!.root.findAll(n => n.props?.testID === 'slot-time-0').length).toBeGreaterThan(0);
});

test('로그인하지 않았으면 안내만 보인다', async () => {
  const config = fakeConfig();
  const requests: { method: string; url: string; body?: unknown }[] = [];
  const client = fakeClient(config, requests);

  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <LangLearnSettingsScreen
        {...common}
        makeClient={() => client}
        user={null}
        config={config}
        onConfig={() => {}}
      />,
    );
  });

  const texts = tree!.root.findAll(n => typeof n.props?.children === 'string').map(n => String(n.props.children));
  expect(texts.some(t => t.includes('학습 로그인'))).toBe(true);
  expect(requests).toHaveLength(0);
});
