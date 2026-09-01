/**
 * `ui/SttTrainingScreen.tsx` 배선 검사.
 *
 * 서버의 확정 API 계약(multipart WAV + 중첩 응답)을 화면이 지키는지 확인한다.
 *
 * 녹음은 `__tests__/screens.test.tsx` 의 `tapMic` 과 같은 방식으로 흉내 낸다 — 네이티브
 * 라이브러리가 20ms 버퍼를 올려주는 것과 같은 콜백을 손으로 부른다.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import { SttTrainingScreen } from '../ui/SttTrainingScreen';
import { light } from '../ui/theme';
import type { ServerConfig } from '../src/api';

const common = {
  colors: light,
  errorText: (err: unknown) => String(err),
};

const USER = { id: 'user-1', name: '철수' };

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
    stt_training: {
      languages: ['ko'],
      default_lang: 'ko',
      required_read_count: 5,
      required_verify_count: 5,
    },
  };
}

interface Req {
  method: string;
  url: string;
  body?: unknown;
}

class FakeFormData {
  readonly parts: Array<{ name: string; value: unknown; fileName?: string }> = [];

  append(name: string, value: unknown, fileName?: string): void {
    this.parts.push({ name, value, fileName });
  }
}

/** 이 화면이 실제로 부를 경로들을 흉내 낸다. 요청은 전부 `requests` 에 기록된다. */
function fakeClient(config: ServerConfig, requests: Req[]) {
  return {
    baseUrl: 'http://server.test',
    formData: () => new FakeFormData(),
    blob: (bytes: ArrayBuffer, contentType: string) => ({ bytes, contentType }),
    fetch: async (url: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method || 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
      requests.push({ method, url, body });

      let responseBody: unknown;
      if (url.includes('/stt_training/status')) {
        responseBody = { read: { done: 1, required: 5 }, verify: { done: 0, required: 5 } };
      } else if (url.includes('/stt_training/next_prompt')) {
        responseBody = {
          done: false,
          prompt: { id: 'p1', text: '오늘 날씨가 좋습니다.', lang: 'ko' },
          progress: { done: 1, required: 5 },
        };
      } else if (url.includes('/stt_training/read_sample')) {
        responseBody = { saved: true, progress: { done: 2, required: 5 } };
      } else if (url.includes('/stt_training/verify/') && url.includes('/verdict')) {
        responseBody = { confirmed: true, progress: { done: 1, required: 5 } };
      } else if (url.includes('/stt_training/verify')) {
        responseBody = { sample_id: 's1', recognized_text: '안녕하세요' };
      } else {
        responseBody = config; // /v1/config
      }

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

/** `screens.test.tsx` 의 `tapMic` 과 같다 — 라이브러리가 버퍼를 올려준 것을 손으로 흉내 낸다. */
function tapMic() {
  const api = require('react-native-audio-api');
  const original = api.AudioRecorder.prototype.onAudioReady;
  const callbacks: ((event: { buffer: unknown }) => void)[] = [];

  api.AudioRecorder.prototype.onAudioReady = function patched(
    this: unknown,
    options: unknown,
    callback: (event: { buffer: unknown }) => void,
  ) {
    callbacks.push(callback);
    return original.call(this, options, callback);
  };

  return {
    speak: () => {
      const callback = callbacks[callbacks.length - 1];
      if (!callback) throw new Error('마이크가 열리지 않았다');
      callback({
        buffer: {
          sampleRate: 16000,
          numberOfChannels: 1,
          getChannelData: () => new Float32Array(1600).fill(0.1),
        },
      });
    },
    restore: () => {
      api.AudioRecorder.prototype.onAudioReady = original;
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

test('로그인하지 않았으면 안내만 보인다', async () => {
  const config = fakeConfig();
  const requests: Req[] = [];
  const client = fakeClient(config, requests);

  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <SttTrainingScreen {...common} makeClient={() => client} user={null} config={config} onConfig={() => {}} />,
    );
  });

  const texts = tree!.root.findAll(n => typeof n.props?.children === 'string').map(n => String(n.props.children));
  expect(texts.some(t => t.includes('로그인'))).toBe(true);
  expect(requests).toHaveLength(0);
});

test('진행률을 불러오고, 낭독 문장을 받아 녹음하면 read_sample 이 추정 계약대로 나간다', async () => {
  const config = fakeConfig();
  const requests: Req[] = [];
  const client = fakeClient(config, requests);
  const mic = tapMic();

  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  try {
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <SttTrainingScreen
          {...common}
          makeClient={() => client}
          user={USER}
          config={config}
          onConfig={() => {}}
        />,
      );
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    });

    const texts = () =>
      tree!.root.findAll(n => typeof n.props?.children === 'string').map(n => String(n.props.children));
    expect(texts().some(t => t.includes('1 / 5'))).toBe(true);
    expect(texts()).toContain('오늘 날씨가 좋습니다.');

    const record = findButtonByLabel(tree!, '녹음 시작');
    await ReactTestRenderer.act(async () => {
      record.props.onPress();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });

    await ReactTestRenderer.act(() => {
      mic.speak();
    });

    const stop = findButtonByLabel(tree!, '녹음 종료 (제출)');
    await ReactTestRenderer.act(async () => {
      stop.props.onPress();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });

    const readRequest = requests.find(r => r.url.includes('/read_sample'));
    expect(readRequest).toBeDefined();
    expect(readRequest!.method).toBe('POST');
    expect(readRequest!.body).toBeInstanceOf(FakeFormData);
    const readBody = readRequest!.body as FakeFormData;
    expect(readBody.parts.map(part => part.name)).toEqual(['prompt_id', 'file']);
    expect(readBody.parts[0]!.value).toBe('p1');
    expect(readBody.parts[1]!.value).toEqual({
      uri: '/mock/path/recording.m4a',
      name: 'sample.wav',
      type: 'audio/wav',
    });

    // 업로드 후 진행률이 응답대로 갱신된다.
    expect(texts().some(t => t.includes('2 / 5'))).toBe(true);
  } finally {
    mic.restore();
  }
});

test('정오 판정 — 인식 결과를 틀림으로 표시하면 정답 텍스트 없이는 제출되지 않는다', async () => {
  const config = fakeConfig();
  const requests: Req[] = [];
  const client = fakeClient(config, requests);
  const mic = tapMic();

  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  try {
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <SttTrainingScreen
          {...common}
          makeClient={() => client}
          user={USER}
          config={config}
          onConfig={() => {}}
        />,
      );
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    });

    const verifyTab = findButtonByLabel(tree!, '정오 판정');
    await ReactTestRenderer.act(() => {
      verifyTab.props.onPress();
    });

    const record = findButtonByLabel(tree!, '녹음 시작');
    await ReactTestRenderer.act(async () => {
      record.props.onPress();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });
    await ReactTestRenderer.act(() => {
      mic.speak();
    });
    const stop = findButtonByLabel(tree!, '녹음 종료 (제출)');
    await ReactTestRenderer.act(async () => {
      stop.props.onPress();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });

    const texts = () =>
      tree!.root.findAll(n => typeof n.props?.children === 'string').map(n => String(n.props.children));
    expect(texts()).toContain('안녕하세요');

    const wrong = findButtonByLabel(tree!, '틀림');
    await ReactTestRenderer.act(() => {
      wrong.props.onPress();
    });

    // 정답 텍스트를 아직 안 넣었으니 제출 버튼이 막혀 있어야 한다.
    const submit = findButtonByLabel(tree!, '틀림으로 제출');
    expect(submit.props.disabled).toBe(true);

    const input = tree!.root.findAll(n => n.props?.placeholder === '실제로 말한 문장을 그대로 입력…')[0]!;
    await ReactTestRenderer.act(() => {
      input.props.onChangeText('안녕하십니까');
    });

    await ReactTestRenderer.act(async () => {
      findButtonByLabel(tree!, '틀림으로 제출').props.onPress();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });

    const verdictRequest = requests.find(r => r.url.includes('/verdict'));
    expect(verdictRequest).toBeDefined();
    expect(verdictRequest!.url).toContain('/verify/s1/verdict');
    expect(verdictRequest!.body).toEqual({ correct: false, corrected_text: '안녕하십니까' });
  } finally {
    mic.restore();
  }
});
