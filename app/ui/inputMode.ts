/**
 * 입력 방식 레지스트리 — **앱이 마이크를 어떻게 다루는지**.
 *
 * 웹 클라이언트(`web/static/app.js` 의 `inputModes` / `defineInputMode`)와 같은 구조다.
 * 여기에는 **구현만** 있고 목록·순서·기본값은 `/v1/config` 의 `client.input_modes` ·
 * `client.default_input_mode` 가 정한다. 이름 상수(`ptt`, `handsfree`)는 **"이 구현의
 * 이름"이지 목록이 아니다** — 서버가 목록에서 이름을 빼면 그 방식은 화면에서 사라지고,
 * 앱이 구현하지 않은 이름은 목록에 있어도 무시된다(웹의 `names.filter(name => name in
 * inputModes)` 와 같은 규칙이다).
 *
 * 세션 `mode`(`batch`/`ptt`/`realtime` — 서버가 어느 엔진·경로를 쓰는가)와 **다른 축이다.**
 * 이름이 겹치지만 섞이지 않는다. 세션 `mode` 는 `engines[].modes` 에서 오고 서버로 나가며,
 * 여기 있는 `input_mode` 는 화면 전용이라 서버로 나가지 않는다.
 */

export interface InputModeImpl {
  /**
   * 버튼을 누르는 동안만 캡처하는가.
   *
   * true  누른 동안만 마이크를 열고, 떼면 멈춘 뒤 `control/flush` 로 세그먼트를 확정한다.
   *       누르지 않은 동안에는 프레임이 하나도 나가지 않으므로 배경 소음이 VAD·STT 에
   *       닿지 않는다.
   * false 연결한 동안 계속 캡처한다. 발화 경계는 서버 VAD 가 잡는다.
   */
  holdToTalk: boolean;
}

const inputModes: Record<string, InputModeImpl> = {
  ptt: { holdToTalk: true },
  handsfree: { holdToTalk: false },
};

/** 앱에 구현이 있는 이름인가. 없는 이름은 고를 수 있게 만들지 않는다. */
export function implemented(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(inputModes, name);
}

/**
 * 이 이름이 "누르고 말하기"인가.
 *
 * 모르는 이름·빈 이름이면 false 다 — 그러면 지금까지의 동작(연결한 동안 연속 캡처)이
 * 그대로 남는다. 고르는 화면은 구현이 있는 이름만 내놓으므로 정상 경로에서 여기에
 * 모르는 이름이 오지는 않는다.
 */
export function holdsToTalk(name: string): boolean {
  const impl = inputModes[name];
  return impl ? impl.holdToTalk : false;
}
