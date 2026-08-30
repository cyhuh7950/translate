/**
 * `ui/LoginScreen.tsx` 배선 검사 (`DESIGN.md` §15).
 *
 * 서버가 세션 토큰을 내주지 않는다는 계약(`orchestrator/app/server.py` 의 로그인 라우트
 * 주석)이 화면에도 그대로 지켜지는지 본다 — 로그인 성공 시 `user_id`+이름만 `onUser` 로
 * 올라가고, PIN은 입력창에서 지워진다. 오류는 서버가 준 문장을 그대로 띄운다(카탈로그 없음).
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import { LoginScreen } from '../ui/LoginScreen';
import { light } from '../ui/theme';

const common = {
  colors: light,
  errorText: (err: unknown) => String(err),
};

/** `/v1/users`, `/v1/users/login` 이 줄 법한 응답을 흉내 낸다. */
function fakeClient(responses: Record<string, unknown>) {
  return {
    baseUrl: 'http://server.test',
    fetch: async (url: string) => {
      const path = new URL(url).pathname;
      const body = responses[path];
      if (body === undefined) throw new Error(`no stub for ${path}`);
      if (body instanceof Error) {
        return {
          ok: false,
          status: 400,
          headers: { get: () => 'application/json' },
          text: async () =>
            JSON.stringify({ detail: body.message, error: { code: 'users.invalid_credentials', params: {} } }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
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

function findByLabel(tree: ReactTestRenderer.ReactTestRenderer, label: string) {
  return tree.root.findAll(
    node => node.props?.label === label && typeof node.props?.onPress === 'function',
  )[0];
}

function setText(tree: ReactTestRenderer.ReactTestRenderer, placeholder: string, value: string) {
  const input = tree.root.findAll(node => node.props?.placeholder === placeholder)[0];
  ReactTestRenderer.act(() => {
    input.props.onChangeText(value);
  });
}

test('로그인 안 했으면 이름+PIN 입력 폼이 그려진다', async () => {
  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <LoginScreen {...common} makeClient={() => null} user={null} onUser={() => {}} />,
    );
  });
  expect(findByLabel(tree!, '로그인')).toBeDefined();
  expect(findByLabel(tree!, '처음이면 등록')).toBeDefined();
});

test('로그인하면 user_id와 이름만 onUser로 올라간다 — PIN은 들고 있지 않는다', async () => {
  const client = fakeClient({ '/v1/users/login': { user_id: 'u_123' } });
  const onUser = jest.fn();

  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <LoginScreen {...common} makeClient={() => client} user={null} onUser={onUser} />,
    );
  });

  setText(tree!, '예: 철수', '철수');
  setText(tree!, '숫자 4자리 이상', '1234');

  await ReactTestRenderer.act(async () => {
    findByLabel(tree!, '로그인').props.onPress();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(onUser).toHaveBeenCalledWith({ id: 'u_123', name: '철수' });
});

test('처음이면 등록 — 등록 후 곧바로 로그인해 user_id를 받는다', async () => {
  const client = fakeClient({
    '/v1/users': { user: { id: 'u_new', name: '영희', created_at: '2026-08-25T00:00:00Z' } },
    '/v1/users/login': { user_id: 'u_new' },
  });
  const onUser = jest.fn();

  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <LoginScreen {...common} makeClient={() => client} user={null} onUser={onUser} />,
    );
  });

  setText(tree!, '예: 철수', '영희');
  setText(tree!, '숫자 4자리 이상', '4321');

  await ReactTestRenderer.act(async () => {
    findByLabel(tree!, '처음이면 등록').props.onPress();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(onUser).toHaveBeenCalledWith({ id: 'u_new', name: '영희' });
});

test('서버가 거절하면 문장을 그대로 오류 상자에 띄운다', async () => {
  const client = fakeClient({
    '/v1/users/login': new Error('이름 또는 PIN 이 올바르지 않습니다'),
  });

  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <LoginScreen {...common} makeClient={() => client} user={null} onUser={() => {}} />,
    );
  });

  setText(tree!, '예: 철수', '없는사람');
  setText(tree!, '숫자 4자리 이상', '0000');

  await ReactTestRenderer.act(async () => {
    findByLabel(tree!, '로그인').props.onPress();
    await Promise.resolve();
    await Promise.resolve();
  });

  const texts = tree!.root.findAll(node => typeof node.props?.children === 'string');
  const shown = texts.map(node => String(node.props.children));
  expect(shown.join('\n')).toContain('이름 또는 PIN 이 올바르지 않습니다');
});

test('로그인돼 있으면 이름을 보여주고, 로그아웃하면 onUser(null)이 불린다', async () => {
  const onUser = jest.fn();
  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <LoginScreen
        {...common}
        makeClient={() => null}
        user={{ id: 'u_1', name: '철수' }}
        onUser={onUser}
      />,
    );
  });

  const texts = tree!.root.findAll(node => typeof node.props?.children === 'string');
  expect(texts.map(node => String(node.props.children))).toContain('철수');

  findByLabel(tree!, '로그아웃').props.onPress();
  expect(onUser).toHaveBeenCalledWith(null);
});
