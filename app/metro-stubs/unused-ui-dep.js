/**
 * 쓰지 않는 UI 의존성 자리에 놓는 빈 모듈.
 *
 * `react-native-audio-api` 의 메인 진입점(`src/api.ts`)이 `AudioControls` 라는 **화면
 * 컴포넌트를 조건 없이 재수출**한다. 그 컴포넌트가 `react-native-reanimated` 와
 * `react-native-gesture-handler` 를 import 하는데, 두 모듈은 그 패키지의
 * `peerDependencies` 에 **선언돼 있지도 않다** (패키지 쪽 포장 문제).
 *
 * 우리는 `AudioRecorder` 와 `AudioContext` 만 쓰고 `AudioControls` 는 화면에 올리지
 * 않는다. 그런데 Metro 는 진입점에서 도달 가능한 모듈을 전부 따라가므로, 쓰지 않아도
 * 해석에 실패해 **번들 자체가 만들어지지 않는다**(HTTP 500 → 앱은 "Unable to load
 * script").
 *
 * 그래서 그 둘을 이 빈 모듈로 돌린다. 안전한 이유는 확인했다 — 두 모듈은
 * `AudioControls` 컴포넌트 **함수 안**과 `audioControlUtils` 의 훅 안에서만 쓰이고
 * 모듈 스코프에서 실행되는 것이 없다. 우리가 그 컴포넌트를 렌더하지 않는 한 이 파일의
 * 값이 읽히는 일은 없다.
 *
 * 대안은 두 라이브러리를 실제로 설치하는 것이었다. 쓰지도 않는 네이티브 의존성을 둘
 * 늘리고 babel 설정과 재빌드가 따라붙는 쪽이라, 지금은 이 편이 가볍다.
 * **언젠가 `AudioControls` 를 쓰게 되면 그때는 진짜로 설치해야 한다** — 그러면
 * `metro.config.js` 의 규칙을 지우면 된다.
 */

// 접근하면 조용히 undefined 를 주는 대신 무엇이 잘못됐는지 알리도록 한다.
// (여기까지 오면 위 전제가 깨진 것이다.)
module.exports = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === '__esModule') return true;
      if (prop === 'default') return undefined;
      throw new Error(
        `이 앱은 react-native-audio-api 의 AudioControls 를 쓰지 않으므로 ` +
          `'${String(prop)}' 는 스텁으로 비워져 있다. ` +
          `실제로 필요해졌다면 react-native-reanimated / react-native-gesture-handler 를 ` +
          `설치하고 metro.config.js 의 stub 규칙을 지울 것 (metro-stubs/unused-ui-dep.js 참고).`,
      );
    },
  },
);
