module.exports = {
  preset: '@react-native/jest-preset',

  // jest 는 네이티브 모듈이 없는 Node 에서 돈다. react-native-audio-api 가 제공하는
  // 목 진입점으로 바꿔 끼운다 (패키지의 `mock/` 서브패스). 이렇게 해야 App.tsx 렌더
  // 테스트가 오디오 라이브러리를 건드리지 않고 지나간다.
  moduleNameMapper: {
    '^react-native-audio-api$': 'react-native-audio-api/mock',
  },

  // 그 목 진입점은 ESM 으로 배포돼 있어 babel 을 태워야 한다. RN 기본값은
  // node_modules 를 건너뛰므로 이 패키지만 예외로 둔다.
  transformIgnorePatterns: [
    'node_modules/(?!(@react-native|react-native|react-native-audio-api)/)',
  ],
};
