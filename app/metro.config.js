const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */

/**
 * `react-native-audio-api` 가 끌고 오지만 이 앱이 쓰지 않는 모듈들.
 *
 * 그 패키지의 진입점이 화면 컴포넌트(AudioControls)를 조건 없이 재수출하고, 그것이
 * 아래 둘을 import 한다 — 그런데 둘 다 그 패키지의 peerDependencies 에 선언조차
 * 돼 있지 않다. 우리는 AudioRecorder / AudioContext 만 쓰므로 빈 모듈로 돌린다.
 * 왜 안전한지는 metro-stubs/unused-ui-dep.js 에 적었다.
 */
const STUBBED = new Set(['react-native-reanimated', 'react-native-gesture-handler']);
const STUB = path.resolve(__dirname, 'metro-stubs/unused-ui-dep.js');

const config = {
  resolver: {
    resolveRequest: (context, moduleName, platform) => {
      if (STUBBED.has(moduleName)) {
        return { type: 'sourceFile', filePath: STUB };
      }
      // 나머지는 Metro 기본 해석에 맡긴다.
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
