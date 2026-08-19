/**
 * jest 용 AsyncStorage 목 — 메모리 사전 하나.
 *
 * v3(`@react-native-async-storage/async-storage`)는 패키지에 jest 목을 넣어 주지 않고,
 * 실물은 네이티브 모듈을 찾다 던진다. 그러면 `storage.ts` 가 그것을 잡아 조용히 빈 값으로
 * 넘어가므로 테스트는 통과하지만 **저장이 되는지는 아무것도 확인하지 못한다.**
 * 그래서 목을 두고, 실제로 넣고 꺼내지는지까지 본다.
 *
 * `jest.config.js` 의 moduleNameMapper 가 이 파일로 바꿔 끼운다.
 */

const store = new Map();

const asyncStorage = {
  async getItem(key) {
    return store.has(key) ? store.get(key) : null;
  },
  async setItem(key, value) {
    store.set(key, String(value));
  },
  async removeItem(key) {
    store.delete(key);
  },
  async clear() {
    store.clear();
  },
  /** 테스트가 상태를 확인하거나 비울 때 쓴다 (실물에는 없다). */
  __store: store,
};

module.exports = {
  __esModule: true,
  default: asyncStorage,
  createAsyncStorage: () => asyncStorage,
};
