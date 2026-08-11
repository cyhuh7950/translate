/**
 * 스텁이 **조용한지** 지킨다.
 *
 * 이 테스트가 있는 이유는 실제로 앱을 죽여봤기 때문이다. 스텁을 "실수로 쓰이면
 * 알려주자"며 접근 시 예외를 던지는 Proxy 로 만들었더니, Babel 이 import 를 옮긴
 * `_interopRequireWildcard` 가 **모듈 평가 시점에 속성을 훑다가** 그 예외를 맞아
 * 번들이 시작도 못 했다. 화면 한 번 안 그려보고 앱이 종료됐다.
 *
 * 그래서 지키는 것은 하나다 — **스텁을 만지는 어떤 동작도 던지지 않는다.**
 * 아래는 Babel 이 실제로 만들어내는 접근 패턴을 그대로 흉내 낸다.
 */

const STUB_PATH = '../metro-stubs/unused-ui-dep';

/** Babel 의 `_interopRequireWildcard` 가 하는 일을 축약한 것. */
function interopRequireWildcard(obj: any): any {
  if (obj && obj.__esModule) {
    return obj; // ← 이 갈래로 빠지는 것이 우리가 노리는 동작이다
  }
  const newObj: any = {};
  // __esModule 이 없으면 이렇게 **전부 훑는다.** 던지는 스텁은 여기서 터졌다.
  for (const key of Object.keys(obj)) {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (desc && (desc.get || desc.set)) {
      Object.defineProperty(newObj, key, desc);
    } else {
      newObj[key] = obj[key];
    }
  }
  newObj.default = obj;
  return newObj;
}

describe('metro 스텁', () => {
  it('불러오는 것만으로 던지지 않는다', () => {
    expect(() => require(STUB_PATH)).not.toThrow();
  });

  it('_interopRequireWildcard 를 통과해도 던지지 않는다', () => {
    const mod = require(STUB_PATH);
    expect(() => interopRequireWildcard(mod)).not.toThrow();
  });

  it('__esModule 이 참이라 interop 이 속성을 훑지 않는다', () => {
    const mod = require(STUB_PATH);
    expect(mod.__esModule).toBe(true);
    expect(interopRequireWildcard(mod)).toBe(mod);
  });

  it('없는 이름을 꺼내도 던지지 않고 undefined 를 준다', () => {
    const mod = require(STUB_PATH);
    // AudioControls 가 실제로 꺼내는 이름들. 값이 없는 것은 괜찮다 —
    // 그 값이 쓰이는 곳은 우리가 렌더하지 않는 컴포넌트 함수 안뿐이다.
    for (const name of ['default', 'useSharedValue', 'useAnimatedRef', 'Gesture', '아무거나']) {
      expect(() => mod[name]).not.toThrow();
      expect(mod[name]).toBeUndefined();
    }
  });

  it('열거·직렬화 같은 흔한 조작에도 던지지 않는다', () => {
    const mod = require(STUB_PATH);
    expect(() => Object.keys(mod)).not.toThrow();
    expect(() => JSON.stringify(mod)).not.toThrow();
    expect(() => ({ ...mod })).not.toThrow();
  });
});
