/**
 * 설정이 실제로 남고 다시 읽히는지 본다.
 *
 * 저장이 없던 동안 앱을 켤 때마다 서버 주소를 다시 입력해야 했다. 그래서 붙인 기능인데,
 * 저장 계층은 **절대 던지지 않도록** 만들어져 있어서(실패해도 앱은 돌아야 하므로) 잘못
 * 만들면 "조용히 아무것도 저장하지 않는" 상태가 되고 테스트도 통과한다.
 * 그 함정을 막는 것이 이 파일의 목적이다.
 */

import * as storage from '../storage';

// 목의 속살. 실물에는 없지만 테스트가 상태를 확인할 때 쓴다.
const mock = require('@react-native-async-storage/async-storage').default as {
  __store: Map<string, string>;
};

beforeEach(() => {
  mock.__store.clear();
});

describe('설정 저장', () => {
  it('아무것도 없으면 빈 객체다 (기본값으로 시작한다)', async () => {
    expect(await storage.load()).toEqual({});
  });

  it('남긴 것을 그대로 다시 읽는다', async () => {
    const value = {
      serverUrl: 'https://example.invalid',
      apiKey: 'k',
      locale: 'ko',
      form: { source_lang: 'aa', model: 'alpha-small' },
    };
    await storage.save(value);
    expect(await storage.load()).toEqual(value);
  });

  it('실제로 저장소에 쓴다 (조용히 아무것도 안 하는 것을 막는다)', async () => {
    await storage.save({ serverUrl: 'https://example.invalid' });
    // 키가 하나 생겼고 그 안에 값이 들어 있다.
    expect(mock.__store.size).toBe(1);
    expect([...mock.__store.values()][0]).toContain('example.invalid');
  });

  it('지우면 다시 빈 객체다', async () => {
    await storage.save({ serverUrl: 'https://example.invalid' });
    await storage.clear();
    expect(await storage.load()).toEqual({});
  });

  it('깨진 JSON 이 남아 있어도 던지지 않고 빈 객체를 준다', async () => {
    // 예전 버전이 쓴 것이거나 저장 중에 끊긴 경우.
    mock.__store.set('translate.settings.v1', '{이건 JSON 이 아니다');
    await expect(storage.load()).resolves.toEqual({});
  });

  it('객체가 아닌 것이 남아 있어도 빈 객체를 준다', async () => {
    mock.__store.set('translate.settings.v1', '"문자열"');
    await expect(storage.load()).resolves.toEqual({});
  });
});
