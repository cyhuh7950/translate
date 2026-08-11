/**
 * 쓰지 않는 UI 의존성 자리에 놓는 **불활성** 모듈.
 *
 * 왜 필요한가
 * ----------
 * `react-native-audio-api` 의 진입점(`src/api.ts`)이 화면 컴포넌트 `AudioControls` 를
 * 조건 없이 재수출한다. 그 컴포넌트가 `react-native-reanimated` 와
 * `react-native-gesture-handler` 를 import 하는데, 둘 다 그 패키지의
 * `peerDependencies` 에 **선언돼 있지도 않다** (패키지 쪽 포장 문제).
 *
 * 우리는 `AudioRecorder` 와 `AudioContext` 만 쓰고 `AudioControls` 는 화면에 올리지
 * 않는다. 그런데 Metro 는 진입점에서 도달 가능한 모듈을 전부 따라가므로, 쓰지 않아도
 * 해석에 실패해 번들 자체가 만들어지지 않는다.
 *
 * 왜 아무것도 하지 않는 객체인가 (중요)
 * ------------------------------------
 * 처음엔 "실수로 쓰이면 알려주자"며 접근 시 예외를 던지는 Proxy 로 만들었다.
 * **그것이 앱을 죽였다.** Babel 이 `import Animated, { useSharedValue } from '...'` 를
 * `_interopRequireWildcard(require('...'))` 로 바꾸는데, 이 함수는 **모듈 평가 시점에
 * 객체의 속성을 훑는다.** 그 순간 Proxy 가 던져 번들 실행이 시작도 못 하고 끝났다.
 *
 * 그래서 지금은 아무 일도 하지 않는다. `__esModule: true` 를 두어
 * `_interopRequireWildcard` 가 훑지 않고 이 객체를 그대로 돌려주게 한다.
 * 속성은 전부 `undefined` 이고, 그 값이 실제로 쓰이는 곳은 우리가 렌더하지 않는
 * `AudioControls` 컴포넌트 **함수 안**뿐이다 (모듈 스코프에서 쓰는 곳이 없음을 확인했다).
 *
 * 교훈: 스텁은 조용해야 한다. 도움을 주려고 똑똑하게 굴면 그 자체가 사고가 된다.
 *
 * 언젠가 `AudioControls` 를 쓰게 되면 두 라이브러리를 실제로 설치하고
 * `metro.config.js` 의 규칙을 지우면 된다.
 */

module.exports = { __esModule: true, default: undefined };
