module.exports = {
  preset: '@react-native/jest-preset',

  // RN 스위트는 **첫 렌더**에 react-native 를 변환하는 비용을 치른다 — 실측으로 같은
  // 파일에서 첫 렌더 2~3초, 이후 렌더는 16~37ms 다. 스위트가 늘어 워커들이 코어를
  // 나눠 쓰면 그 첫 렌더 하나가 jest 기본값 5초를 넘겨 "시간 초과"로 죽는다.
  // 무엇이 멈춘 것이 아니므로 한도를 올린다. 실제로 오래 걸리는 테스트를 숨기지 않도록
  // 느린 테스트가 생기면 --verbose 로 개별 시간을 확인할 것.
  testTimeout: 30000,

  // 화면이 실제로 그려지도록 하는 준비. 왜 필요한지는 jest.setup.js 에 적었다.
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],

  // jest 는 네이티브 모듈이 없는 Node 에서 돈다. react-native-audio-api 가 제공하는
  // 목 진입점으로 바꿔 끼운다 (패키지의 `mock/` 서브패스). 이렇게 해야 App.tsx 렌더
  // 테스트가 오디오 라이브러리를 건드리지 않고 지나간다.
  moduleNameMapper: {
    '^react-native-audio-api$': 'react-native-audio-api/mock',
    // AsyncStorage v3 는 jest 목을 함께 배포하지 않는다. 실물은 네이티브를 찾다 던지고,
    // storage.ts 가 그것을 잡아 조용히 넘어가므로 저장 동작을 아무것도 확인할 수 없다.
    // 메모리 사전 목으로 바꿔 끼워 실제로 넣고 꺼내지는지까지 본다.
    '^@react-native-async-storage/async-storage$': '<rootDir>/__mocks__/async-storage.js',
    // notifee 도 네이티브 모듈이다. 패키지가 공식 제공하는 jest 목으로 바꿔 끼운다.
    '^@notifee/react-native$': '<rootDir>/node_modules/@notifee/react-native/jest-mock.js',
  },

  // 그 목 진입점은 ESM 으로 배포돼 있어 babel 을 태워야 한다. RN 기본값은
  // node_modules 를 건너뛰므로 이 패키지만 예외로 둔다.
  transformIgnorePatterns: [
    'node_modules/(?!(@react-native|react-native|react-native-audio-api|@notifee)/)',
  ],
};
