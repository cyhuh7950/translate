/**
 * 세 화면이 **실제로 그려지는지**, 그리고 **설정 화면에서 고른 값이 세션까지 가는지** 본다.
 *
 * 렌더 테스트가 있는 이유는, 앱이 실기기에서 화면 한 번 안 그려보고 종료된 적이 있기
 * 때문이다. 그때 있던 렌더 테스트는 `App` 하나뿐이었는데, `App` 은 **연결 확인 탭으로
 * 시작**하므로 `LiveScreen` 은 아예 마운트되지 않았다 — 가장 위험한 화면이 검증에서
 * 통째로 빠져 있었다. 화면이 하나 늘 때마다 여기도 늘려야 하는 이유가 그것이다.
 *
 * 배선 테스트가 있는 이유는 그 반대다. 설정 화면은 **그려지기만 해서는 아무 의미가 없다.**
 * 고른 언어·프로필로 세션이 열리지 않으면 통역기로 쓸 수 없다. 그래서 마지막 두 테스트는
 * 칩을 실제로 누르고, 그 값이 WS 로 나가는 첫 메시지에 실리는지까지 따라간다.
 *
 * 오디오 라이브러리는 jest 설정이 목으로 바꿔 끼운다(네이티브가 없는 Node 에서 돈다).
 * 그러니 이 테스트가 잡는 것은 **우리 화면 코드의 렌더 시점 사고**와 **배선**이다.
 * 네이티브 쪽 문제는 여전히 기기/에뮬레이터에서만 드러난다.
 *
 * 가짜 `/v1/config` 의 언어 코드·프로필 이름을 실제 서버와 다르게(`aa`, `solo` …) 지어낸
 * 것은 일부러다. 앱이 이름을 하나도 모른 채 응답만 보고 그린다는 것이 그래야 드러난다.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import App from '../App';
import type { ServerConfig } from '../src/api';
import { ConnectScreen } from '../ui/ConnectScreen';
import { LiveScreen } from '../ui/LiveScreen';
import { SettingsScreen } from '../ui/SettingsScreen';
import { buildFields, streamConfig } from '../ui/settings';
import type { Settings } from '../ui/settings';
import { light } from '../ui/theme';

/** 화면들이 공통으로 받는 것. App.tsx 가 넘기는 모양과 같다. */
const common = {
  colors: light,
  // 서버에 실제로 붙지 않는다. 렌더만 보는 테스트다.
  makeClient: () => null,
  locale: 'ko',
  errorText: (err: unknown) => String(err),
};

/**
 * 서버가 줄 법한 응답. 실제 서버와 이름을 겹치지 않게 지어냈다 — 앱에 목록이 없다는 것이
 * 그래야 증명된다. 모양은 `src/api/types.ts` 의 `ServerConfig` 그대로다.
 */
function fakeConfig(): ServerConfig {
  return {
    server_id: 'test',
    locale: 'ko',
    session: {
      default_profile: 'solo',
      default_mode: 'batch',
      allow_profile_override: true,
      allow_mode_override: true,
      default_source_lang: 'aa',
      default_target_lang: 'bb',
    },
    languages: [
      { code: 'aa', label: '가나어' },
      { code: 'bb', label: '나다어' },
      { code: 'cc', label: '다라어' },
    ],
    profiles: [
      {
        id: 'solo',
        label: '혼자 말하기',
        description: '한 사람이 말한다',
        speaker_id: 'manual',
        turn_policy: 'half_duplex',
        participants: [],
        participant_count: 2,
        bidirectional: false,
        available: true,
        reason: null,
      },
      {
        id: 'duo',
        label: '주고받기',
        description: '두 사람이 말한다',
        speaker_id: 'nose_print',
        turn_policy: 'half_duplex',
        participants: [],
        participant_count: 2,
        bidirectional: true,
        available: false,
        // 서버가 로케일로 렌더해 보낸 문장. 앱은 이것을 그대로 띄운다.
        reason: "구현 'nose_print' 가 등록돼 있지 않다",
      },
    ],
    engines: [
      {
        id: 'ear',
        kind: 'listen',
        server: 'test',
        modes: ['batch', 'quick'],
        streaming: false,
        available: true,
        ready: true,
        model: 'ear-1',
        languages: ['aa'],
        voices: null,
        default_voice: null,
        error: null,
      },
      {
        id: 'ear_quick',
        kind: 'listen',
        server: 'test',
        modes: ['quick'],
        streaming: true,
        available: true,
        ready: true,
        model: null,
        languages: null,
        voices: null,
        default_voice: null,
        error: null,
      },
      {
        id: 'mouth',
        kind: 'talk',
        server: 'test',
        modes: ['batch'],
        streaming: false,
        available: false,
        ready: false,
        model: null,
        languages: null,
        voices: null,
        default_voice: null,
        error: '연결하지 못했다',
      },
    ],
    llm: {
      default_provider: 'alpha',
      style: 'natural',
      styles: ['natural'],
      context_turns: 4,
      providers: [
        {
          id: 'alpha',
          label: '알파',
          kind: 'x',
          default_model: 'alpha-big',
          fast: true,
          available: true,
          reason: null,
        },
        {
          id: 'beta',
          label: '베타',
          kind: 'x',
          default_model: null,
          fast: false,
          available: false,
          reason: '키가 없다',
        },
      ],
    },
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
    client: { input_modes: ['tap', 'auto'], default_input_mode: 'tap' },
    stream: { path: '/v1/stream', input_format: 'pcm16', client_frame_ms: 20 },
  };
}

/** 한 필드를 이름으로 집는다. */
function field(config: ServerConfig, form: Settings, name: string) {
  const found = buildFields(config, form).find(f => f.name === name);
  expect(found).toBeDefined();
  return found!;
}

describe('화면 렌더', () => {
  it('ConnectScreen 이 그려진다', async () => {
    await ReactTestRenderer.act(() => {
      ReactTestRenderer.create(
        <ConnectScreen {...common} config={null} onConfig={() => {}} form={{}} />,
      );
    });
  });

  it('LiveScreen 이 그려진다', async () => {
    await ReactTestRenderer.act(() => {
      ReactTestRenderer.create(<LiveScreen {...common} form={{}} />);
    });
  });

  it('SettingsScreen 이 그려진다 (설정을 아직 못 받은 상태)', async () => {
    await ReactTestRenderer.act(() => {
      ReactTestRenderer.create(
        <SettingsScreen {...common} config={null} onConfig={() => {}} form={{}} onForm={() => {}} />,
      );
    });
  });

  it('SettingsScreen 이 그려진다 (설정을 받은 상태 — 항목이 실제로 나온다)', async () => {
    let tree: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <SettingsScreen
          {...common}
          config={fakeConfig()}
          onConfig={() => {}}
          form={{}}
          onForm={() => {}}
        />,
      );
    });

    // 서버가 준 표시 이름이 그대로 화면에 있다.
    const texts = tree!.root.findAll(node => typeof node.props?.children === 'string');
    const shown = texts.map(node => String(node.props.children));
    expect(shown).toContain('가나어');
    expect(shown).toContain('혼자 말하기');
    // 고를 수 없는 프로필의 이유도 함께 떠 있어야 한다 (서버가 렌더한 문장 그대로).
    expect(shown.join('\n')).toContain("구현 'nose_print' 가 등록돼 있지 않다");
  });

  it('App 이 그려진다 (연결 확인 탭으로 시작)', async () => {
    await ReactTestRenderer.act(() => {
      ReactTestRenderer.create(<App />);
    });
  });

  it('App 에서 다른 탭으로 넘겨도 그려진다', async () => {
    let tree: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(<App />);
    });

    // 탭은 label 로 찾는다 — 화면에 보이는 글자와 같아서 깨져도 이유가 분명하다.
    const tab = (label: string) =>
      tree!.root.findAll(
        node => node.props?.label === label && typeof node.props?.onPress === 'function',
      )[0];

    for (const label of ['설정', '실시간 통역']) {
      const button = tab(label);
      expect(button).toBeDefined();
      await ReactTestRenderer.act(() => {
        button!.props.onPress();
      });
    }
  });
});

describe('폼을 응답에서 만든다', () => {
  it('모드 목록은 엔진들이 신고한 것의 합집합이다', () => {
    // 앱에 모드 이름이 없다는 뜻이다 — 엔진이 'quick' 을 신고했으니 'quick' 이 나온다.
    expect(field(fakeConfig(), {}, 'mode').options.map(o => o.value)).toEqual(['batch', 'quick']);
  });

  it('엔진 항목은 kind 별로 하나씩 생긴다', () => {
    const names = buildFields(fakeConfig(), {}).map(f => f.name);
    expect(names).toContain('listen_engine');
    expect(names).toContain('talk_engine');
  });

  it('고를 수 없는 것은 이유와 함께 잠긴다', () => {
    const config = fakeConfig();

    const duo = field(config, {}, 'profile').options.find(o => o.value === 'duo');
    expect(duo!.usable).toBe(false);
    expect(duo!.note).toBe("구현 'nose_print' 가 등록돼 있지 않다");

    // 준비되지 않은 엔진도 마찬가지. 사유는 서버가 준 `error` 를 그대로 나른다.
    const mouth = field(config, {}, 'talk_engine').options.find(o => o.value === 'mouth');
    expect(mouth!.usable).toBe(false);
    expect(mouth!.note).toContain('연결하지 못했다');

    // 고른 모드를 지원하지 않는 엔진도 잠긴다 (모드를 바꾸면 풀린다).
    const quickOnly = (mode: string) =>
      field(config, { mode }, 'listen_engine').options.find(o => o.value === 'ear_quick')!;
    expect(quickOnly('batch').usable).toBe(false);
    expect(quickOnly('quick').usable).toBe(true);
  });

  it('서버가 막아 두면 항목 자체가 없다', () => {
    const config = fakeConfig();
    config.session.allow_profile_override = false;
    config.session.allow_mode_override = false;
    const names = buildFields(config, {}).map(f => f.name);
    expect(names).not.toContain('profile');
    expect(names).not.toContain('mode');
  });

  it('llm 절이 없으면 프로바이더·모델 항목이 없다', () => {
    const config = fakeConfig();
    config.llm = { ...config.llm, providers: [] };
    const names = buildFields(config, {}).map(f => f.name);
    expect(names).not.toContain('provider');
    expect(names).not.toContain('model');
  });
});

describe('고른 값이 세션에 실린다', () => {
  it('기본값은 전부 /v1/config 에서 온다', () => {
    const message = streamConfig(fakeConfig(), {}, 'ko');
    expect(message.source_lang).toBe('aa');
    expect(message.target_lang).toBe('bb');
    expect(message.profile).toBe('solo');
    expect(message.mode).toBe('batch');
    expect(message.sample_rate).toBe(16000);
    expect(message.locale).toBe('ko');
  });

  it('고른 값이 그대로 실린다', () => {
    const message = streamConfig(
      fakeConfig(),
      { source_lang: 'cc', target_lang: 'aa', mode: 'quick', listen_engine: 'ear_quick' },
      'ko',
    );
    expect(message.source_lang).toBe('cc');
    expect(message.target_lang).toBe('aa');
    expect(message.mode).toBe('quick');
    expect(message.stt_engine).toBeUndefined();
    // 엔진 필드 이름은 응답의 kind 에서 만들어진다. 컴파일 시점에 알 수 없는 키다.
    expect((message as unknown as Record<string, unknown>).listen_engine).toBe('ear_quick');
  });

  it('빈 값과 화면 전용 값은 나가지 않는다', () => {
    const message = streamConfig(fakeConfig(), { input_mode: 'auto', model: '  ' }, 'ko');
    const keys = Object.keys(message);
    // 입력 방식은 화면 전용이라 서버로 나가면 안 된다.
    expect(keys).not.toContain('input_mode');
    // 빈 값을 보내면 서버가 자기 기본값 대신 빈 값을 쓴다. 아예 넣지 않는다.
    expect(keys).not.toContain('model');
  });

  it('고를 수 없는 값을 들고 있으면 고를 수 있는 값으로 물러난다', () => {
    // 쓸 수 없는 프로필로 세션을 열어 서버에 거절당하는 일을 만들지 않는다.
    expect(streamConfig(fakeConfig(), { profile: 'duo' }, 'ko').profile).toBe('solo');
  });
});

describe('설정 화면 → 세션 (배선)', () => {
  it('칩을 누르면 그 값이 다음 세션의 config 메시지에 들어간다', async () => {
    const config = fakeConfig();
    let form: Settings = {};
    let tree: ReactTestRenderer.ReactTestRenderer | undefined;

    const render = () =>
      ReactTestRenderer.act(() => {
        const element = (
          <SettingsScreen
            {...common}
            config={config}
            onConfig={() => {}}
            form={form}
            onForm={next => {
              form = next;
            }}
          />
        );
        if (tree) tree.update(element);
        else tree = ReactTestRenderer.create(element);
      });

    await render();

    // 목표어의 'cc' 칩. 같은 글자가 사용어 쪽에도 있으므로 이름으로 집는다.
    const chip = (testID: string) =>
      tree!.root.findAll(
        node => node.props?.testID === testID && typeof node.props?.onPress === 'function',
      )[0];

    await ReactTestRenderer.act(() => {
      chip('target_lang:cc')!.props.onPress();
    });
    expect(form.target_lang).toBe('cc');

    // 그리고 그 값이 실제로 세션을 여는 메시지에 실린다.
    expect(streamConfig(config, form, 'ko').target_lang).toBe('cc');

    // 잠긴 칩은 눌리지 않는다 — Pressable 에 disabled 가 걸려 있어야 한다.
    await render();
    const locked = tree!.root.findAll(node => node.props?.testID === 'profile:duo');
    expect(locked.some(node => node.props.disabled === true)).toBe(true);
  });

  it('LiveScreen 이 그 값으로 WS 세션을 연다', async () => {
    const config = fakeConfig();
    const form: Settings = { target_lang: 'cc', mode: 'quick' };

    // 소켓을 가로챈다. LiveScreen 은 RN 의 전역 WebSocket 을 쓴다(핸드셰이크에 헤더를
    // 실을 수 있어서다). 그래서 여기서 전역을 바꿔 끼운다.
    const sent: string[] = [];
    class FakeSocket {
      binaryType = '';
      onopen: (() => void) | null = null;
      onmessage: unknown = null;
      onerror: unknown = null;
      onclose: ((event: unknown) => void) | null = null;
      constructor() {
        // 생성자에서 바로 부르면 openStream 이 아직 onopen 을 걸기 전이다.
        setTimeout(() => {
          if (this.onopen) this.onopen();
        }, 0);
      }
      send(data: string) {
        sent.push(data);
      }
      close() {
        if (this.onclose) this.onclose({ code: 1000, reason: '' });
      }
    }
    const realSocket = (globalThis as Record<string, unknown>).WebSocket;
    (globalThis as Record<string, unknown>).WebSocket = FakeSocket;

    const client = {
      baseUrl: 'http://server.test',
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify(config),
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    };

    let tree: ReactTestRenderer.ReactTestRenderer | undefined;
    try {
      await ReactTestRenderer.act(() => {
        tree = ReactTestRenderer.create(
          <LiveScreen {...common} makeClient={() => client} form={form} />,
        );
      });

      const start = tree!.root.findAll(
        node => node.props?.label === '통역 시작' && typeof node.props?.onPress === 'function',
      )[0];
      expect(start).toBeDefined();

      await ReactTestRenderer.act(async () => {
        start!.props.onPress();
        // 권한 → GET /v1/config → 소켓 열림(onopen) 까지 기다린다.
        await new Promise<void>(resolve => setTimeout(() => resolve(), 20));
      });

      // 소켓이 열리면 첫 메시지가 config 다 (서버는 그렇지 않으면 끊는다).
      expect(sent.length).toBeGreaterThan(0);
      const message = JSON.parse(sent[0] as string);
      expect(message.type).toBe('config');
      expect(message.target_lang).toBe('cc');
      expect(message.mode).toBe('quick');
      // 고르지 않은 것은 서버 기본값 그대로다.
      expect(message.source_lang).toBe('aa');
      expect(message.sample_rate).toBe(16000);
    } finally {
      if (tree) {
        await ReactTestRenderer.act(() => {
          tree!.unmount();
        });
      }
      (globalThis as Record<string, unknown>).WebSocket = realSocket;
    }
  });
});
