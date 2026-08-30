/**
 * `ui/LearnScreen.tsx` 배선 검사.
 *
 * `orchestrator/app/modules/lang_learn/session.py` 의 흐름
 * (start → ready → problem → answer → answer.received → feedback → session.summary
 * → session.done) 을 텍스트 답변 경로로 왕복시켜, 각 단계에서 화면이 보내는 메시지와
 * 그려내는 내용을 확인한다. 오디오 캡처/재생은 jest 설정이 목으로 바꿔 끼운다
 * (`facetoface.test.tsx` 와 같은 방식).
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import { LearnScreen } from '../ui/LearnScreen';
import { light } from '../ui/theme';
import type { ServerConfig } from '../src/api';

const common = {
  colors: light,
  locale: 'ko',
  errorText: (err: unknown) => String(err),
};

const USER = { id: 'user-1', name: '철수' };

const SETTINGS = {
  schedule: [],
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
    languages: [],
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
      defaults: SETTINGS,
      answer_type_pattern: ['repeat', 'compose'],
    },
  };
}

interface FakeSocketHandle {
  sent: string[];
  closed: boolean;
  emit: (event: Record<string, unknown>) => void;
}

/** `facetoface.test.tsx` 와 같은 가짜 소켓. */
function installFakeSocket(): FakeSocketHandle[] {
  const sockets: FakeSocketHandle[] = [];
  class FakeSocket {
    binaryType = '';
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: unknown = null;
    onclose: ((event: unknown) => void) | null = null;
    constructor() {
      const handle: FakeSocketHandle = {
        sent: [],
        closed: false,
        emit: event => {
          if (this.onmessage) this.onmessage({ data: JSON.stringify(event) });
        },
      };
      sockets.push(handle);
      (this as unknown as { _handle: FakeSocketHandle })._handle = handle;
      setTimeout(() => {
        if (this.onopen) this.onopen();
      }, 0);
    }
    send(data: string) {
      (this as unknown as { _handle: FakeSocketHandle })._handle.sent.push(data);
    }
    close() {
      (this as unknown as { _handle: FakeSocketHandle })._handle.closed = true;
      if (this.onclose) this.onclose({ code: 1000, reason: '' });
    }
  }
  (globalThis as Record<string, unknown>).WebSocket = FakeSocket;
  return sockets;
}

function fakeClient(config: ServerConfig) {
  return {
    baseUrl: 'http://server.test',
    fetch: async (url: string) => {
      const body = url.includes('/lang_learn/settings') ? SETTINGS : config;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify(body),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    },
  };
}

/** 라벨 텍스트를 갖는 `Button`/`Pressable` 을 찾는다 — 텍스트에서 위로 올라가며 `onPress` 를 가진 노드를 찾는다. */
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

async function startSession(tree: ReactTestRenderer.ReactTestRenderer) {
  const button = findButtonByLabel(tree, '학습 시작');
  await ReactTestRenderer.act(async () => {
    button.props.onPress();
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  });
}

test('세션을 시작하면 로그인된 user_id 로 start 메시지를 보낸다', async () => {
  const config = fakeConfig();
  const sockets = installFakeSocket();
  const client = fakeClient(config);

  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <LearnScreen {...common} makeClient={() => client} user={USER} />,
    );
  });

  await startSession(tree!);

  expect(sockets).toHaveLength(1);
  const start = JSON.parse(sockets[0]!.sent[0]!);
  expect(start).toEqual({ type: 'start', user_id: 'user-1', locale: 'ko' });
});

test('problem → 텍스트 답변 → feedback → session.summary → session.done 왕복', async () => {
  const config = fakeConfig();
  const sockets = installFakeSocket();
  const client = fakeClient(config);

  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <LearnScreen {...common} makeClient={() => client} user={USER} />,
    );
  });

  await startSession(tree!);
  const socket = sockets[0]!;

  await ReactTestRenderer.act(async () => {
    socket.emit({ type: 'ready', total: 1, target_lang: 'en', level: 'beginner', feedback_mode: 'both' });
    await Promise.resolve();
  });

  await ReactTestRenderer.act(async () => {
    socket.emit({
      type: 'problem',
      idx: 0,
      total: 1,
      answer_type: 'compose',
      text: '아침에 일어나서 처음 한 일을 영어로 말해보세요.',
      audio_hint: false,
    });
    await Promise.resolve();
  });

  const texts = () => tree!.root.findAll(n => typeof n.props?.children === 'string').map(n => String(n.props.children));
  expect(texts()).toContain('아침에 일어나서 처음 한 일을 영어로 말해보세요.');

  // 텍스트 입력 → 제출
  const input = tree!.root.findAll(n => n.props?.placeholder === '답을 입력…')[0]!;
  await ReactTestRenderer.act(async () => {
    input.props.onChangeText('I woke up and drank water.');
  });
  const submit = findButtonByLabel(tree!, '답변 제출');
  await ReactTestRenderer.act(async () => {
    submit.props.onPress();
    await Promise.resolve();
  });

  const answer = JSON.parse(socket.sent[socket.sent.length - 1]!);
  expect(answer).toEqual({
    type: 'answer',
    idx: 0,
    modality: 'text',
    text: 'I woke up and drank water.',
  });

  await ReactTestRenderer.act(async () => {
    socket.emit({ type: 'answer.received', idx: 0 });
    await Promise.resolve();
  });
  await ReactTestRenderer.act(async () => {
    socket.emit({ type: 'feedback', idx: 0, grade: '상', comment: '아주 잘했다.' });
    await Promise.resolve();
  });

  expect(texts()).toContain('상');
  expect(texts()).toContain('아주 잘했다.');

  await ReactTestRenderer.act(async () => {
    socket.emit({ type: 'session.summary', grade: '상', comment: '전체적으로 훌륭하다.' });
    await Promise.resolve();
  });
  expect(texts()).toContain('전체적으로 훌륭하다.');

  await ReactTestRenderer.act(async () => {
    socket.emit({ type: 'session.done' });
    await Promise.resolve();
  });

  expect(socket.closed).toBe(true);
  expect(texts().some(t => t.includes('세션이 끝났다'))).toBe(true);
});

test('로그인하지 않았으면 세션을 열 수 없다는 안내만 보인다', async () => {
  const config = fakeConfig();
  installFakeSocket();
  const client = fakeClient(config);

  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <LearnScreen {...common} makeClient={() => client} user={null} />,
    );
  });

  const texts = tree!.root.findAll(n => typeof n.props?.children === 'string').map(n => String(n.props.children));
  expect(texts.some(t => t.includes('학습 로그인'))).toBe(true);
  expect(tree!.root.findAll(n => n.props?.children === '학습 시작')).toHaveLength(0);
});
