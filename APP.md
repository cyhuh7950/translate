# 모바일 앱 프레임워크 선택

최종 목적지는 모바일 앱이다(`DESIGN.md` §10). 지금 웹 클라이언트는 기능 테스트 벡터이고,
검증된 것을 앱으로 옮긴다. 그 앱을 무엇으로 만들지 정하기 위한 문서다.

**전제** — 개발 PC 는 Windows, **Android 를 먼저** 만든다. iOS 는 Mac 이 있어야 하므로 뒤로 미룬다.
다만 "iOS 를 영영 안 만든다"가 아니므로 그 확장 비용도 비교에 넣는다.

---

## 결론

**React Native 를 권한다.** 다만 근거가 하나에 크게 쏠려 있으므로, 아래 §7 의 하루짜리
실험으로 확인한 뒤 확정하는 것을 권한다.

결정을 가르는 것은 UI 도 생태계도 아니고 **온디바이스 STT/TTS 를 실제로 돌릴 수 있는가**다.
설계상 이건 선택 기능이 아니라 요구사항이고(`DESIGN.md` §10), Moonshine·Supertonic 은 둘 다
ONNX 모델이라 **기기에서 ONNX Runtime 이 돌아야** 한다.

| | ONNX Runtime |
|---|---|
| React Native | **Microsoft 공식 패키지** `onnxruntime-react-native` (v1.24.3, 2026-03 갱신) |
| Flutter | **커뮤니티 플러그인만** 존재 (`flutter_onnxruntime`, `onnxruntime`, `onnxruntime_v2` 등 3종 이상) |
| 네이티브 Kotlin | 공식 Android 패키지. 1급 지원 |

Flutter 쪽 플러그인들이 못 쓴다는 뜻은 아니지만, **우리 요구사항의 유일한 하드 블로커에서
공식 지원이 있느냐 없느냐**는 개인이 유지하는 프로젝트에서 무시하기 어려운 차이다.
플러그인이 방치되면 우리가 떠안아야 하고, 그건 이 프로젝트의 규모를 넘는다.

---

## 1. 앱에 요구되는 것

`DESIGN.md` 에서 앱이 해야 한다고 정해둔 것들이다. 이것이 비교의 축이 된다.

| # | 요구 | 출처 | 성격 |
|---|---|---|---|
| 1 | **온디바이스 STT/TTS** — Moonshine·Supertonic 을 앱에 내장, 서버/기기 선택 | §10 | 하드 요구 |
| 2 | **원시 PCM 캡처** — 16kHz mono PCM16, 20ms 프레임을 WS 바이너리로 | §11 | 하드 요구 |
| 3 | **청크 오디오 재생** — TTS 청크가 도착하는 대로 이어 재생 | §3, §11 | 하드 요구 |
| 4 | **AEC(에코 제거)** — `full_duplex` 의 전제. 앱만 되는 것 | §10 | 2단계 |
| 5 | **백그라운드 동작 + 푸시** — 서버가 먼저 말을 거는 경로(기능 3) | §10, §12 | 2단계 |
| 6 | **다국어 표시** | §6 | 이미 서버가 해결 |

6번은 앱 쪽 부담이 거의 없다. 오류 문구를 서버가 요청 로케일로 렌더해서 주기 때문에
(`config/messages/*.yaml`), 앱은 **자기 로케일만 실어 보내면** 된다. 프레임워크 선택과 무관하다.

---

## 2. 축별 비교

✅ 공식·문제없음 / ⚠️ 되지만 직접 붙여야 함 / ❌ 부담 큼

| 축 | React Native | Flutter | 네이티브 Kotlin |
|---|---|---|---|
| **온디바이스 ONNX** | ✅ MS 공식 패키지 | ⚠️ 커뮤니티 플러그인 3종 | ✅ 공식 |
| **원시 PCM 캡처** | ⚠️ 라이브러리 다수, 골라야 함 | ⚠️ 라이브러리 있음 | ✅ `AudioRecord` 직접 |
| **PCM 청크 재생** | ⚠️ 라이브러리 있음 | ⚠️ 라이브러리 있음 | ✅ `AudioTrack` 직접 |
| **AEC** | ⚠️ 네이티브 모듈 필요 | ⚠️ 네이티브 모듈 필요 | ✅ `AcousticEchoCanceler` 직접 |
| **백그라운드·푸시(FCM)** | ✅ 성숙 | ✅ 성숙 | ✅ 1급 |
| **웹 클라이언트 재사용** | ⚠️ 부분적(아래 §4) | ❌ 없음(Dart) | ❌ 없음 |
| **iOS 확장 비용** | 낮음(같은 코드) | 낮음(같은 코드) | ❌ 전부 다시 |
| **Windows 개발** | ✅ | ✅ | ✅ |
| **Android 단독 작업량** | 보통 | 보통 | **가장 적음** |

---

## 3. AEC — 세 방식 모두 네이티브 코드가 필요하다

이건 프레임워크 선택으로 해결되지 않는다는 점을 분명히 해둔다.

Android 의 AEC 는 `AudioRecord` 를 `VOICE_COMMUNICATION` 소스로 열거나, 그 세션 ID 에
`AcousticEchoCanceler` 를 붙여서 켠다. **일반 오디오 라이브러리가 노출해주지 않는다.**
React Native 든 Flutter 든 결국 작은 네이티브 모듈을 직접 쓰게 된다.

따라서 AEC 는 RN 과 Flutter 를 가르는 축이 아니라, **"크로스플랫폼 + 네이티브 모듈 약간"과
"완전 네이티브" 사이의 축**이다. 그리고 AEC 는 2단계(`full_duplex`) 사안이므로 지금 결정을
좌우할 필요는 없다 — 다만 어느 쪽을 골라도 언젠가 네이티브 코드를 조금 쓰게 된다는 것은
알고 시작하는 게 좋다.

---

## 4. 웹 클라이언트 재사용 — 과대평가하지 말 것

`web/static/app.js` 는 1849줄이다. React Native 를 고르면 이걸 그대로 쓸 수 있다고
말하기 쉬운데, 정직하게 나누면 이렇다.

| 옮겨지는 것 | 다시 만드는 것 |
|---|---|
| WS 프로토콜 처리(`hfConfigMessage`, `hfEvent`, `hfHandlers`) | 마이크 캡처(`getUserMedia`, `AudioWorklet`) |
| 세그먼트·턴 상태 관리(`hfTurn`, `state`) | 오디오 재생(WebAudio `AudioContext`) |
| 로케일 처리(`t()`, `loadLocale`, `resolveLocale`) | DOM 조작 전부 |
| `/v1/config` → 설정 컨트롤 매핑 **규칙** | 그 컨트롤의 실제 렌더 |
| 지표 포맷(`formatMetrics`) | `MediaRecorder` 경로 |

즉 **문자 그대로 복사되는 건 300~500줄 남짓**이고, I/O 와 렌더링은 어차피 다시 쓴다.
React Native 의 이점은 "코드를 그대로 옮긴다"보다 **같은 언어라 옮기는 동안 생각이 안
끊긴다**에 가깝다.

**진짜 이점은 프레임워크와 무관한 데 있다.** 판단이 전부 서버에 있어서(설정 스키마·프로필·
라우팅·오류 문구·로케일) 어느 프레임워크로 만들든 앱은 얇은 껍데기다. 이건 웹을 테스트
벡터로 삼은 설계가 이미 벌어둔 것이고, 프레임워크를 잘못 골라도 크게 손해 보지 않는다는
뜻이기도 하다.

---

## 5. 네이티브 Kotlin 을 고르는 것이 맞는 경우

**"Android 만 만들고 iOS 는 안 한다"가 확실하다면 네이티브가 최선이다.** 오디오
파이프라인(원시 PCM·AEC·저지연 재생)이 이 앱의 심장인데, 그 셋 모두 네이티브가 1급이고
크로스플랫폼은 전부 남의 래퍼를 거친다. 실시간 통역에서 오디오 문제는 디버깅이 가장 괴로운
축이라 이 차이가 작지 않다.

반대로 **iOS 를 언젠가 만든다면** 네이티브는 그 시점에 전부 다시 만드는 것을 뜻한다.
`DESIGN.md` 가 앱을 최종 목적지로 못 박은 이상 iOS 가 영영 없을 것 같지는 않다.

---

## 6. 권고 정리

| 상황 | 선택 |
|---|---|
| iOS 를 언젠가 만든다 (기본 가정) | **React Native** |
| Android 만, 오디오 품질이 최우선 | 네이티브 Kotlin |
| UI 완성도를 크게 중시하고 온디바이스 엔진을 **포기** 가능 | Flutter |

Flutter 를 권하지 않는 이유는 Flutter 가 나빠서가 아니라 **우리 요구사항의 하드 블로커
(온디바이스 ONNX)에서 공식 지원이 없는 유일한 선택지**이기 때문이다. 온디바이스를 요구사항에서
빼면 Flutter 도 충분히 좋은 답이 된다 — 그건 설계 변경이므로 별도로 논의할 사안이다.

---

## 7. 결정을 확정할 실험 (하루)

문서로 더 비교하는 것보다 이게 빠르고 확실하다. React Native 로 **가장 위험한 세 가지만**
먼저 찔러본다.

1. **원시 PCM 캡처** — 16kHz mono PCM16 프레임이 실제로 나오는가. 웹의
   `capture-worklet.js` 가 하는 일과 같은 결과가 나오는지 파형으로 확인
2. **WS 왕복** — 그 프레임을 `translate.sinsan.kr` 의 `/v1/stream` 에 그대로 보내고
   `stt.final`/`llm.final`/`tts.chunk` 가 돌아오는가. **서버는 전혀 손대지 않는다**
3. **ONNX 로드** — `onnxruntime-react-native` 로 Supertonic 모델을 실기기에 올려
   추론이 도는가. 여기서 막히면 온디바이스 요구가 흔들리므로 가장 먼저 확인할 가치가 있다

셋 다 되면 프레임워크는 확정이다. 3번이 막히면 네이티브로 기운다.

이 실험은 **로컬 PC 에서** 한다. 서버 쪽은 아무것도 바뀌지 않는다 —
앱은 이미 열려 있는 `translate.sinsan.kr` 을 부르는 클라이언트일 뿐이다.

---

## 8. 확인하지 못한 것

정직하게 남긴다. 아래는 실기기 없이는 문서로 결론 낼 수 없다.

- **Supertonic·Moonshine 의 실기기 성능** — 오라클 ARM CPU 에서 Supertonic 이
  `TOTAL_STEPS=6` 으로 3.3초였다(`DESIGN.md` §4). 휴대폰 SoC 에서 얼마나 나오는지는
  재봐야 한다. 온디바이스 TTS 가 서버보다 느리면 이 요구사항 자체를 다시 볼 일이다
- **PCM 라이브러리의 실제 품질** — RN·Flutter 모두 후보가 여럿인데, 20ms 프레임을
  끊김 없이 흘리는지는 붙여봐야 안다
- **배터리** — 온디바이스 추론 + 상시 마이크의 전력 소모

---

## 참고

- [onnxruntime-react-native (npm)](https://www.npmjs.com/package/onnxruntime-react-native) — Microsoft 공식
- [ONNX Runtime React Native 문서](https://onnxruntime.ai/docs/get-started/with-javascript/react-native.html)
- [flutter_onnxruntime (pub.dev)](https://pub.dev/packages/flutter_onnxruntime) — 커뮤니티
- [onnxruntime (pub.dev)](https://pub.dev/packages/onnxruntime) — 커뮤니티
- [AcousticEchoCanceler (Android)](https://developer.android.com/reference/android/media/audiofx/AcousticEchoCanceler)
- [Android 오디오 전처리 효과 구현](https://source.android.com/docs/core/audio/implement-pre-processing)
- [react-native-audio (원시 입력 스트림)](https://github.com/birdofpreyru/react-native-audio)
- [react-native-audio-pcm-stream](https://github.com/mybigday/react-native-audio-pcm-stream)
- [react-native-pcm-player](https://github.com/AminAllahham/react-native-pcm-player)
