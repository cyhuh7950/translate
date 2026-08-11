/**
 * 두 화면이 **실제로 그려지는지** 본다.
 *
 * 이 테스트가 있는 이유는, 앱이 실기기에서 화면 한 번 안 그려보고 종료된 적이 있기
 * 때문이다. 그때 있던 렌더 테스트는 `App` 하나뿐이었는데, `App` 은 **연결 확인 탭으로
 * 시작**하므로 `LiveScreen` 은 아예 마운트되지 않았다 — 가장 위험한 화면이 검증에서
 * 통째로 빠져 있었다.
 *
 * 오디오 라이브러리는 jest 설정이 목으로 바꿔 끼운다(네이티브가 없는 Node 에서 돈다).
 * 그러니 이 테스트가 잡는 것은 **우리 화면 코드의 렌더 시점 사고**다 — 실제로 났던
 * 종류가 그것이다. 네이티브 쪽 문제는 여전히 기기/에뮬레이터에서만 드러난다.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import App from '../App';
import { ConnectScreen } from '../ui/ConnectScreen';
import { LiveScreen } from '../ui/LiveScreen';
import { light } from '../ui/theme';

/** 두 화면이 공통으로 받는 것. App.tsx 가 넘기는 모양과 같다. */
const common = {
  colors: light,
  // 서버에 실제로 붙지 않는다. 렌더만 보는 테스트다.
  makeClient: () => null,
  locale: 'ko',
  errorText: (err: unknown) => String(err),
};

describe('화면 렌더', () => {
  it('ConnectScreen 이 그려진다', async () => {
    await ReactTestRenderer.act(() => {
      ReactTestRenderer.create(<ConnectScreen {...common} />);
    });
  });

  it('LiveScreen 이 그려진다', async () => {
    await ReactTestRenderer.act(() => {
      ReactTestRenderer.create(<LiveScreen {...common} />);
    });
  });

  it('App 이 그려진다 (연결 확인 탭으로 시작)', async () => {
    await ReactTestRenderer.act(() => {
      ReactTestRenderer.create(<App />);
    });
  });

  it('App 에서 실시간 탭으로 넘겨도 그려진다', async () => {
    let tree: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(<App />);
    });

    // 탭은 label 로 찾는다 — 화면에 보이는 글자와 같아서 깨져도 이유가 분명하다.
    const liveTab = tree!.root.findAll(
      (node) => node.props?.label === '실시간 통역' && typeof node.props?.onPress === 'function',
    )[0];

    expect(liveTab).toBeDefined();

    await ReactTestRenderer.act(() => {
      liveTab.props.onPress();
    });
  });
});
