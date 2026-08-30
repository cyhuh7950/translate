/**
 * `ui/FaceToFaceScreen.tsx` 배선 검사 (통역모드).
 *
 * 서버가 세션 도중 발화자를 바꿀 방법을 주지 않는다는 제약 때문에, 이 화면은 **누른 쪽이
 * 바뀔 때마다 세션을 다시 연다.** 그 재연결이 실제로 일어나는지, `oneway` 프로필로
 * source/target 언어가 맞바꿔 나가는지, 같은 쪽을 다시 누르면 재연결 없이 세션을
 * 그대로 쓰는지를 본다. 오디오 라이브러리는 jest 설정이 목으로 바꿔 끼운다.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import { FaceToFaceScreen } from '../ui/FaceToFaceScreen';
import { light } from '../ui/theme';
import type { ServerConfig } from '../src/api';

const common = {
  colors: light,
  locale: 'ko',
  errorText: (err: unknown) => String(err),
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
      { code: 'aa', label: '가나어' },
      { code: 'bb', label: '나다어' },
    ],
    profiles: [
      {
        id: 'oneway',
        label: '단방향',
        description: '',
        speaker_id: 'manual',
        turn_policy: 'half_duplex',
        participants: [],
        participant_count: 2,
        bidirectional: false,
        available: true,
        reason: null,
      },
    ],
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
  };
}

interface FakeSocketHandle {
  sent: string[];
  closed: boolean;
  emit: (event: Record<string, unknown>) => void;
}

/** LiveScreen 테스트와 같은 가짜 소켓. RN 의 전역 WebSocket 을 바꿔 끼운다. */
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
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(config),
      arrayBuffer: async () => new ArrayBuffer(0),
    }),
  };
}

const READY_EVENT = {
  type: 'ready',
  session_id: 's1',
  participants: [],
  profile: 'oneway',
  mode: 'batch',
  turn_policy: 'half_duplex',
  audio: { sample_rate: 16000, channels: 1, format: 'pcm16', frame_ms: 20 },
  vad: { backend: 'energy' },
};

/** 누르고, `ready` 를 보내(캡처가 실제로 열리게) 뗀다 — flush 배선을 보려면 이게 필요하다. */
async function pressAndRelease(
  tree: ReactTestRenderer.ReactTestRenderer,
  side: 'top' | 'bottom',
  sockets: FakeSocketHandle[],
) {
  const pane = tree.root.findAll(node => node.props?.testID === `pane:${side}`)[0];
  await ReactTestRenderer.act(async () => {
    pane.props.onPressIn();
    await Promise.resolve();
  });
  await ReactTestRenderer.act(async () => {
    sockets[sockets.length - 1]!.emit(READY_EVENT);
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  });
  await ReactTestRenderer.act(async () => {
    pane.props.onPressOut();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
}

test('아래쪽을 누르면 oneway 프로필로 세션을 열고, 뗄 때 flush 한다', async () => {
  const config = fakeConfig();
  const sockets = installFakeSocket();
  const client = fakeClient(config);

  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <FaceToFaceScreen {...common} makeClient={() => client} form={{}} />,
    );
  });

  await pressAndRelease(tree!, 'bottom', sockets);

  expect(sockets).toHaveLength(1);
  const message = JSON.parse(sockets[0]!.sent[0]!);
  expect(message.type).toBe('config');
  expect(message.profile).toBe('oneway');
  // 아무것도 안 골랐으면 서버 세션 기본값(aa→bb)이 그대로 나간다.
  expect(message.source_lang).toBe('aa');
  expect(message.target_lang).toBe('bb');
  // 뗐으니 flush 컨트롤 메시지가 나갔어야 한다.
  const flushed = sockets[0]!.sent.some(raw => JSON.parse(raw).action === 'flush');
  expect(flushed).toBe(true);
});

test('반대쪽을 누르면 세션을 닫고 언어를 맞바꿔 다시 연다', async () => {
  const config = fakeConfig();
  const sockets = installFakeSocket();
  const client = fakeClient(config);

  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <FaceToFaceScreen {...common} makeClient={() => client} form={{}} />,
    );
  });

  await pressAndRelease(tree!, 'bottom', sockets);
  expect(sockets).toHaveLength(1);
  expect(sockets[0]!.closed).toBe(false);

  await pressAndRelease(tree!, 'top', sockets);

  expect(sockets).toHaveLength(2);
  expect(sockets[0]!.closed).toBe(true); // 이전 세션은 닫혔다
  const second = JSON.parse(sockets[1]!.sent[0]!);
  expect(second.source_lang).toBe('bb'); // 위쪽이 이제 발화자다 — 언어가 맞바뀐다
  expect(second.target_lang).toBe('aa');
});

test('같은 쪽을 다시 누르면 재연결 없이 세션을 그대로 쓴다', async () => {
  const config = fakeConfig();
  const sockets = installFakeSocket();
  const client = fakeClient(config);

  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <FaceToFaceScreen {...common} makeClient={() => client} form={{}} />,
    );
  });

  await pressAndRelease(tree!, 'bottom', sockets);
  await pressAndRelease(tree!, 'bottom', sockets);

  expect(sockets).toHaveLength(1); // 두 번째 누름은 새 소켓을 만들지 않는다
});

test('말한 사람 쪽에 원문이, 상대 쪽에 번역문이 뜬다', async () => {
  const config = fakeConfig();
  const sockets = installFakeSocket();
  const client = fakeClient(config);

  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <FaceToFaceScreen {...common} makeClient={() => client} form={{}} />,
    );
  });

  const pane = (side: 'top' | 'bottom') =>
    tree!.root.findAll(node => node.props?.testID === `pane:${side}`)[0];

  await ReactTestRenderer.act(async () => {
    pane('bottom').props.onPressIn();
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  });

  const readyEvent = {
    type: 'ready',
    session_id: 's1',
    participants: [],
    profile: 'oneway',
    mode: 'batch',
    turn_policy: 'half_duplex',
    audio: { sample_rate: 16000, channels: 1, format: 'pcm16', frame_ms: 20 },
    vad: { backend: 'energy' },
  };
  await ReactTestRenderer.act(async () => {
    sockets[0]!.emit(readyEvent);
    await Promise.resolve();
  });

  await ReactTestRenderer.act(async () => {
    sockets[0]!.emit({ type: 'stt.final', seg: 0, from: 'speaker', lang: 'aa', text: '안녕' });
    sockets[0]!.emit({ type: 'llm.final', seg: 0, to: 'listener', lang: 'bb', text: 'hello' });
    await Promise.resolve();
  });

  const texts = tree!.root.findAll(n => typeof n.props?.children === 'string');
  const shown = texts.map(n => String(n.props.children));
  expect(shown).toContain('안녕');
  expect(shown).toContain('hello');

  await ReactTestRenderer.act(async () => {
    pane('bottom').props.onPressOut();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
});
