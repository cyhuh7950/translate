/**
 * 고른 값을 기기에 남긴다. 앱을 껐다 켜도 서버 주소를 다시 입력하지 않게 하는 것이 목적이다.
 *
 * 왜 늦게 부르는가
 * ---------------
 * `@react-native-async-storage/async-storage` 는 네이티브 모듈이다. 파일 맨 위에서 값으로
 * import 하면, 네이티브가 없을 때(JS 만 새로고침하고 APK 를 다시 빌드하지 않은 경우)
 * 그 예외가 **번들 평가 중에** 터져 앱 전체가 뜨지 않는다. 오디오 라이브러리에서 실제로
 * 그렇게 앱이 죽었고(`audio/module.ts` 참고), 같은 실수를 반복하지 않는다.
 *
 * 그래서 타입만 위에서 가져오고 실물은 쓸 때 부른다. 게다가 **이 계층은 절대 던지지 않는다** —
 * 저장은 편의이고, 실패해도 앱은 그대로 동작해야 한다. 실패는 조용히 넘기는 대신
 * 개발자용 로그만 남긴다.
 *
 * 무엇을 남기는가
 * --------------
 * 작은 JSON 하나로 뭉쳐 한 키에 넣는다. 항목이 늘거나 이름이 바뀌어도 마이그레이션이
 * 필요 없고, 읽을 때 모르는 키는 무시하면 된다.
 *
 * ★ API 키도 함께 남는다. 기기 저장소에 **평문으로** 들어간다는 뜻이다. 이 앱은 한 사람이
 *   자기 서버에 붙는 개인 서비스라 그 편이 실용적이라고 판단했다(`DESIGN.md` §12 의
 *   "단일 사용자, 개인 서비스"). 여러 사람이 쓰는 앱이 된다면 이 결정을 다시 봐야 한다 —
 *   그때는 키를 남기지 않거나 보안 저장소(Keychain/Keystore)를 쓴다.
 */

import type { AsyncStorage } from '@react-native-async-storage/async-storage';

/** 저장 키. 하나만 쓴다. */
const KEY = 'translate.settings.v1';

/** 남기는 것. 전부 선택적이다 — 없으면 그 항목만 기본값으로 시작한다. */
export interface Saved {
  serverUrl?: string;
  apiKey?: string;
  locale?: string;
  /** 설정 화면에서 고른 값 (`ui/settings.ts` 의 `Settings`). */
  form?: Record<string, string>;
}

/**
 * 실물 모듈. 네이티브가 없으면 여기서 던지므로 부르는 쪽이 반드시 감싼다.
 * `require` 인 이유는 `audio/module.ts` 와 같다 — 동적 `import()` 는 jest 에서
 * `--experimental-vm-modules` 없이 돌지 않는다.
 */
function storage(): AsyncStorage {
  return require('@react-native-async-storage/async-storage').default;
}

/**
 * 남겨둔 값을 읽는다. 없거나 읽지 못하면 **빈 객체**다 — 호출자는 그냥 기본값으로 시작하면 된다.
 * 저장된 JSON 이 깨져 있어도 같다.
 */
export async function load(): Promise<Saved> {
  try {
    const raw = await storage().getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    // 모양을 믿지 않는다. 기기에 남아 있던 것은 예전 버전이 쓴 것일 수 있다.
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as Saved;
  } catch (err) {
    console.warn('[storage] 저장된 설정을 읽지 못했다 — 기본값으로 시작한다', err);
    return {};
  }
}

/** 값을 남긴다. 실패해도 던지지 않는다 — 다음 실행에서 기본값으로 시작할 뿐이다. */
export async function save(value: Saved): Promise<void> {
  try {
    await storage().setItem(KEY, JSON.stringify(value));
  } catch (err) {
    console.warn('[storage] 설정을 남기지 못했다', err);
  }
}

/** 남긴 것을 지운다 (`기본값으로` 를 눌렀을 때). */
export async function clear(): Promise<void> {
  try {
    await storage().removeItem(KEY);
  } catch (err) {
    console.warn('[storage] 저장된 설정을 지우지 못했다', err);
  }
}
