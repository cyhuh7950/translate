/* eslint-env jest */
/**
 * jest 가 화면을 **실제로 그리게** 만든다.
 *
 * `SafeAreaProvider` 는 화면 인셋을 측정하기 전까지 자식을 렌더하지 않는다. 테스트
 * 환경에는 측정할 화면이 없으므로 아무것도 안 그려지는데, 렌더 테스트는 예외가 안 났다는
 * 이유로 **통과**한다. 실제로 그런 상태였다 — `App` 렌더 테스트가 빈 트리를 그리며
 * 초록불을 내고 있었고, 그 사이 실기기에서는 앱이 죽었다.
 *
 * 라이브러리가 제공하는 목이 인셋을 고정값으로 채워 자식을 바로 그리게 한다.
 */
jest.mock('react-native-safe-area-context', () =>
  require('react-native-safe-area-context/jest/mock').default,
);
