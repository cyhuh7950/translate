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
    llm: {
      default_provider: 'alpha',
      style: 'natural',
      styles: ['natural'],
      context_turns: 4,
      providers: [],
    },
    implementations: {},
    routing: { policy: 'x', available: [] },
    audio: {
      stt_sample_rate: 16000,
      stt_channels: 1,
      tts_response_format: 'wav',
    },
    vad: {
      backend: 'energy',
      available: ['energy'],
      silence_ms: 600,
      min_speech_ms: 250,
    },
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
      (handle as any).lateClose = () =>
        this.onclose?.({ code: 1000, reason: '' });
      sockets.push(handle);
      (this as unknown as { _handle: FakeSocketHandle })._handle = handle;
      setTimeout(() => {
        if (this.onopen) this.onopen();
      }, 0);
    }
    send(data: string) {
      (this as unknown as { _handle: FakeSocketHandle })._handle.sent.push(
        data,
      );
    }
    close() {
      (this as unknown as { _handle: FakeSocketHandle })._handle.closed = true;
      // Deliver onclose asynchronously via lateClose, like a real socket.
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
  const pane = tree.root.findAll(
    node => node.props?.testID === `pane:${side}`,
  )[0];
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

import { StreamSession } from '../src/api/stream';

test('지연된 설정 응답은 화면 이탈 뒤 소켓을 만들지 않는다', async () => {
  const real = (globalThis as any).WebSocket;
  const sockets = installFakeSocket();
  const config = fakeConfig();
  let release!: () => void;
  let requested = false;
  const blocked = new Promise<void>(resolve => {
    release = resolve;
  });
  const normal = fakeClient(config);
  const client = {
    ...normal,
    fetch: async () => {
      requested = true;
      await blocked;
      return normal.fetch();
    },
  };
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <FaceToFaceScreen {...common} makeClient={() => client} form={{}} />,
    );
  });
  await ReactTestRenderer.act(async () => {
    tree.root
      .findAll(n => n.props?.testID === 'pane:bottom')[0]!
      .props.onPressIn();
    await Promise.resolve();
  });
  expect(requested).toBe(true);
  await ReactTestRenderer.act(() => tree.unmount());
  await ReactTestRenderer.act(async () => {
    release();
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  });
  expect(sockets).toHaveLength(0);
  (globalThis as any).WebSocket = real;
});

test('늦은 onopen은 닫힌 세션을 다시 열지 않는다', () => {
  const wire: any = { send: jest.fn(), close: jest.fn(), binaryType: '' };
  const session = new StreamSession({
    url: 'ws://test',
    webSocket: () => wire,
    config: { type: 'config', source_lang: 'ko', target_lang: 'en' },
  });
  session.open();
  session.close();
  expect(session.isOpen).toBe(false);
  wire.onopen();
  expect(session.isOpen).toBe(false);
  expect(wire.send).not.toHaveBeenCalled();
});

test('이전 소켓의 지연된 종료가 새 세션을 닫지 않는다', async () => {
  const real = (globalThis as any).WebSocket;
  const sockets = installFakeSocket();
  const client = fakeClient(fakeConfig());
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <FaceToFaceScreen {...common} makeClient={() => client} form={{}} />,
    );
  });
  await pressAndRelease(tree, 'bottom', sockets);
  await pressAndRelease(tree, 'top', sockets);
  expect(sockets).toHaveLength(2);
  expect(sockets[1]!.closed).toBe(false);
  await ReactTestRenderer.act(() => (sockets[0] as any).lateClose());
  expect(sockets[1]!.closed).toBe(false);
  await ReactTestRenderer.act(() => tree.unmount());
  (globalThis as any).WebSocket = real;
});

import { PermissionsAndroid, Platform } from 'react-native';
import { LiveScreen } from '../ui/LiveScreen';
import { Button } from '../ui/Button';
import { MicCapture } from '../audio/capture';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
const initialOS = Platform.OS;
const initialSocket = globalThis.WebSocket;
afterEach(() => {
  Object.defineProperty(Platform, 'OS', {
    value: initialOS,
    configurable: true,
  });
  globalThis.WebSocket = initialSocket;
  jest.restoreAllMocks();
});
describe.each(['live', 'face'] as const)('%s 비동기 정리', kind => {
  async function mount(client: ReturnType<typeof fakeClient>) {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        kind === 'live' ? (
          <LiveScreen
            {...common}
            makeClient={() => client}
            form={{ input_mode: 'handsfree' }}
          />
        ) : (
          <FaceToFaceScreen {...common} makeClient={() => client} form={{}} />
        ),
      );
    });
    return tree;
  }
  async function begin(tree: ReactTestRenderer.ReactTestRenderer) {
    await ReactTestRenderer.act(async () => {
      if (kind === 'live') tree.root.findByType(Button).props.onPress();
      else
        tree.root
          .findAll(n => n.props?.testID === 'pane:bottom')[0]!
          .props.onPressIn();
      await Promise.resolve();
    });
  }
  test('권한 요청 대기 중 화면을 떠나면 설정 요청과 마이크 시작을 하지 않는다', async () => {
    Object.defineProperty(Platform, 'OS', {
      value: 'android',
      configurable: true,
    });
    const permission = deferred<typeof PermissionsAndroid.RESULTS.GRANTED>();
    jest
      .spyOn(PermissionsAndroid, 'request')
      .mockReturnValue(permission.promise);
    const client = fakeClient(fakeConfig());
    const fetchSpy = jest.spyOn(client, 'fetch');
    const micSpy = jest.spyOn(
      require('react-native-audio-api').AudioRecorder.prototype,
      'start',
    );
    const tree = await mount(client);
    await begin(tree);
    await ReactTestRenderer.act(() => tree.unmount());
    await ReactTestRenderer.act(async () => {
      permission.resolve(PermissionsAndroid.RESULTS.GRANTED);
      await Promise.resolve();
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(micSpy).not.toHaveBeenCalled();
  });
  test('설정 요청 대기 중 화면을 떠나면 소켓을 만들지 않는다', async () => {
    const response =
      deferred<Awaited<ReturnType<ReturnType<typeof fakeClient>['fetch']>>>();
    const normal = fakeClient(fakeConfig());
    const client = { ...normal, fetch: jest.fn(() => response.promise) };
    const sockets = installFakeSocket();
    const tree = await mount(client);
    await begin(tree);
    await ReactTestRenderer.act(() => tree.unmount());
    await ReactTestRenderer.act(async () => {
      response.resolve(await normal.fetch());
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });
    expect(sockets).toHaveLength(0);
  });
  test('ready 대기 중 화면을 떠나면 마이크를 시작하지 않는다', async () => {
    const sockets = installFakeSocket();
    const micSpy = jest.spyOn(
      require('react-native-audio-api').AudioRecorder.prototype,
      'start',
    );
    const tree = await mount(fakeClient(fakeConfig()));
    await begin(tree);
    await ReactTestRenderer.act(() => tree.unmount());
    await ReactTestRenderer.act(async () => {
      sockets[0]!.emit(READY_EVENT);
      await Promise.resolve();
    });
    expect(micSpy).not.toHaveBeenCalled();
    expect(sockets[0]!.closed).toBe(true);
  });
});

test('너무 짧아 제외된 발화는 통역모드 화면에서 명확히 알린다', async () => {
  const sockets = installFakeSocket();
  const client = fakeClient(fakeConfig());
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <FaceToFaceScreen {...common} makeClient={() => client} form={{}} />,
    );
  });
  await pressAndRelease(tree, 'bottom', sockets);
  await ReactTestRenderer.act(() =>
    sockets[0]!.emit({ type: 'vad', state: 'speech_end', dropped: true }),
  );
  expect(JSON.stringify(tree.toJSON())).toContain(
    '발화가 너무 짧아 처리되지 않았습니다',
  );
  await ReactTestRenderer.act(() => tree.unmount());
});

test('빠른 통역 시작 두 번에서 뒤늦은 첫 설정 응답이 새 연결을 바꾸지 않는다', async () => {
  const sockets = installFakeSocket();
  const first =
    deferred<Awaited<ReturnType<ReturnType<typeof fakeClient>['fetch']>>>();
  const second =
    deferred<Awaited<ReturnType<ReturnType<typeof fakeClient>['fetch']>>>();
  const normal = fakeClient(fakeConfig());
  const client = {
    ...normal,
    fetch: jest
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise),
  };
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <LiveScreen
        {...common}
        makeClient={() => client}
        form={{ input_mode: 'ptt' }}
      />,
    );
  });
  const connect = tree.root.findByType(Button).props.onPress;
  await ReactTestRenderer.act(async () => {
    connect();
    await Promise.resolve();
  });
  await ReactTestRenderer.act(async () => {
    connect();
    await Promise.resolve();
  });
  await ReactTestRenderer.act(async () => {
    second.resolve(await normal.fetch());
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    sockets[0]!.emit(READY_EVENT);
    await Promise.resolve();
  });
  await ReactTestRenderer.act(async () => {
    first.resolve(await normal.fetch());
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
  expect(sockets).toHaveLength(1);
  expect(sockets[0]!.closed).toBe(false);
  await ReactTestRenderer.act(() => tree.unmount());
});

test('이전 마이크 시작의 늦은 실패가 새 연결의 누르기를 취소하지 않는다', async () => {
  const sockets = installFakeSocket();
  let rejectOld!: (reason: Error) => void;
  const oldStart = new Promise<void>((_, reject) => {
    rejectOld = reject;
  });
  jest
    .spyOn(MicCapture.prototype, 'start')
    .mockReturnValueOnce(oldStart)
    .mockResolvedValue(undefined);
  const client = fakeClient(fakeConfig());
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <LiveScreen
        {...common}
        makeClient={() => client}
        form={{ input_mode: 'ptt' }}
      />,
    );
  });
  async function connect() {
    await ReactTestRenderer.act(async () => {
      tree.root.findByType(Button).props.onPress();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      sockets[sockets.length - 1]!.emit(READY_EVENT);
      await Promise.resolve();
    });
  }
  await connect();
  await ReactTestRenderer.act(async () => {
    tree.root.findAll(n => n.props?.testID === 'ptt')[0]!.props.onPressIn();
    await Promise.resolve();
  });
  await ReactTestRenderer.act(() =>
    tree.root.findByType(Button).props.onPress(),
  );
  await connect();
  await ReactTestRenderer.act(async () => {
    tree.root.findAll(n => n.props?.testID === 'ptt')[0]!.props.onPressIn();
    await Promise.resolve();
  });
  await ReactTestRenderer.act(async () => {
    rejectOld(new Error('stale microphone failure'));
    await Promise.resolve();
  });
  expect(JSON.stringify(tree.toJSON())).not.toContain(
    'stale microphone failure',
  );
  expect(JSON.stringify(tree.toJSON())).toContain(
    '듣는 중 — 손을 떼면 번역한다',
  );
  await ReactTestRenderer.act(() => tree.unmount());
});
