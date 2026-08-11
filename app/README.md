# app — 모바일 앱

최종 산출물인 모바일 앱이다. 프레임워크는 **React Native** 로 정했다 (`../APP.md`).
개발은 **Windows PC + Android** 로 시작한다. iOS 는 Mac 이 있어야 하므로 뒤로 미룬다.

**이 폴더가 곧 React Native 프로젝트 루트다** (RN 0.86.2 / React 19.2.3).
그 안에 **`src/api/` — 서버와 말을 주고받는 계층**이 먼저 들어와 있고, 그것만은 이미
실제 서버에 대고 검증돼 있다 (§5). 무엇이 있고 다음에 무엇을 하면 되는지가 이 문서다.

---

## 1. 지금 무엇이 있나

```
app/
  index.js            RN 진입점 (app.json 의 이름으로 App 을 등록한다)
  App.tsx             뿌리 — 서버 주소를 들고 두 화면을 전환한다
  app.json            RN 앱 이름 (RN 이 만든 것, 건드리지 않는다)
  app.config.json     서버 주소 · API 키 · 로케일 — 빈 값으로 커밋돼 있다 (§7)

  android/            Android 네이티브 프로젝트  ← 지금 빌드하는 것
  ios/                iOS 네이티브 프로젝트     ← Mac 이 생기면 쓴다. 지금은 손대지 않는다

  ui/
    ConnectScreen.tsx 연결 확인 화면 — 스파이크 (§7)
    LiveScreen.tsx    실시간 통역 화면 (§8)
    Button.tsx        두 화면이 함께 쓰는 버튼
    theme.ts          색과 공용 스타일 조각
  audio/
    pcm.ts            Float32↔PCM16 · 리샘플 · 프레이밍 · WAV 읽기 (RN 무의존)
    capture.ts        마이크 → 규격 PCM16 프레임
    playback.ts       tts.chunk → 순서대로 이어 재생
    module.ts         오디오 라이브러리를 늦게 부르는 한 겹 (§8)

  src/api/
    types.ts          서버 응답·WS 이벤트 타입 (서버 소스를 읽고 맞춘 것)
    http.ts           fetch 주입, URL 조립, 오류 봉투 → 예외
    config.ts         GET /v1/config
    stream.ts         WS 스트리밍 프로토콜 (바이너리 짝짓기 포함)
    translate.ts      POST /v1/translate/{text,audio}
    index.ts          입구 — 앱은 이것만 import 한다
  test/
    smoke.ts          실제 서버에 대고 도는 검증 (Node 전용)

  tsconfig.json       RN 앱 코드용 (§3)
  tsconfig.api.json   src/api 이식성 감시자 (§3)
  tsconfig.test.json  스모크 테스트용 (§3)
```

**아직 없는 것**: 온디바이스 ONNX, 네비게이션 라이브러리, 프로필·언어를 고르는 화면
(지금은 `/v1/config` 의 세션 기본값을 그대로 쓴다).

**의존성은 한 번에 하나씩만 늘린다.** 순수 RN + `src/api` 로 첫 빌드를 성공시킨 뒤
실시간 경로를 위해 `react-native-audio-api` **하나만** 더했다 (§8). 다음 차례인
`onnxruntime-react-native` 도 같은 방식으로 따로 넣는다 — 그래야 빌드가 깨졌을 때
"RN 자체가 안 되는 건지 방금 넣은 것 때문인지" 구분된다.

---

## 2. `src/api/` 는 React Native 에 의존하지 않는다

이 계층에는 `react-native` 도, `expo` 도, DOM 도, Node 전용 API 도 없다.
`fetch` 와 `WebSocket` 을 전역에서 찾지 않고 **주입받는다.**

```ts
import { fetchConfig, openStream, streamUrl } from './src/api';

const client = { baseUrl: 'https://translate.sinsan.kr', fetch, locale: 'ko' };
const config = await fetchConfig(client);

const session = openStream({
  url: streamUrl(client.baseUrl, config.stream.path),   // 경로도 서버가 알려준다
  webSocket: (url) => new WebSocket(url),
  config: { type: 'config', source_lang: 'ko', target_lang: 'en',
            sample_rate: config.audio.stt_sample_rate, locale: 'ko' },
  handlers: { 'llm.final': (e) => console.log(e.text) },
  onAudio: (chunk, audio) => play(audio),               // tts.chunk 와 짝지어 온다
});
```

RN 에서 바뀌는 것은 `fetch`/`WebSocket` 을 넘기는 그 줄뿐이다. 덕분에 **실기기 없이
이 서버에서 Node 로 전부 검증할 수 있었고**, 로컬에서는 오디오와 ONNX 에만 집중하면 된다.
`App.tsx` 가 실제로 그 한 줄만 쓴다 — `const rnFetch: FetchLike = fetch;` 이고 캐스팅이 없다.

### 서버 주소도, 경로도, 기본값도 소스에 없다

`DESIGN.md` 앞부분의 원칙 그대로다. `baseUrl` 은 호출자가 주고, WS 경로는
`/v1/config` 의 `stream.path` 에서 오고, 프레임 크기는
`audio.stt_sample_rate × stream.client_frame_ms` 로 계산한다(`frameBytes()`).
프로필·언어·엔진·프로바이더 목록도 전부 그 응답에서 온다 — 앱에 목록이 없다.

### 오류 문구는 서버가 만든다

서버는 오류를 이렇게 준다.

```json
{"detail": "그런 프로필이 없습니다: 'nope'",
 "error": {"code": "profile.unknown", "params": {"profile": "nope"}}}
```

`detail` 은 **요청 로케일로 이미 렌더된 문장**이라 그대로 화면에 띄우면 된다
(`ApiError.message` / `StreamError.message` 가 그 값이다). 분기가 필요할 때만 `code` 를 본다.
**앱에 문구 카탈로그를 만들지 않는다.** 앱이 할 일은 로케일을 실어 보내는 것뿐이다.

---

## 3. tsconfig 가 세 개인 이유

`src/api` 의 이식성은 **컴파일러가 지키고 있다.** `types: []` + `lib: ES2020` 이라
`fetch`·`WebSocket`·`window`·`Buffer`·`process` 같은 전역이 아예 존재하지 않고,
그중 하나라도 쓰는 순간 타입 체크가 깨진다. 이것이 "Node 로 검증하고 RN 에서 그대로 쓴다"를
가능하게 한 장치라 잃으면 안 된다.

그런데 RN 의 tsconfig 는 `@react-native/typescript-config` 를 확장하고 `types: ["jest"]` 를
쓴다 — 그대로 덮으면 위 보장이 사라진다. 그래서 하나를 셋으로 나눴다.

| 파일 | 보는 것 | 역할 |
|---|---|---|
| `tsconfig.json` | `App.tsx`, `src/`, `__tests__/` | **RN 것.** IDE·Metro·eslint·jest 가 이름만 보고 집는 파일이라 이 이름을 RN 에 준다. `test/`(Node 전용)와 `dist/`(빌드 산출물)는 제외 |
| `tsconfig.api.json` | `src/` | **이식성 감시자.** `types: []` + `lib: ES2020`. 이 파일이 위의 규칙을 강제한다 |
| `tsconfig.test.json` | `src/`, `test/` | 스모크 테스트용. `tsconfig.api.json` 을 확장해 `types: ["node"]` 만 더한다. `dist/` 로 컴파일해 Node 로 돌린다 |

`src/api` 가 RN 설정에도 함께 들어오는 것은 괜찮다 — 앱이 실제로 import 하는 코드이니
같이 봐야 한다. 이식성은 `tsconfig.api.json` 이 지키고, `npm run typecheck` 가 **셋을 다**
돌리므로 실수는 잡힌다. 하나만 돌리고 넘어가지 말 것.

---

## 4. 서버는 옮기지 않는다

앱은 이미 열려 있는 **`translate.sinsan.kr` 을 부르는 클라이언트**일 뿐이다.
STT·LLM·TTS·VAD·화자 식별·오류 문구가 전부 서버에 있고, 앱은 마이크와 스피커,
그리고 화면을 담당한다. 앱 작업 때문에 서버를 고칠 일은 없어야 한다 —
프로토콜이 바뀌어야 한다면 그때는 서버와 이 폴더를 **한 커밋에서** 함께 고친다.
(`app/` 이 `orchestrator/`·`web/` 과 나란히 있는 이유다.)

---

## 5. 검증하기 (Node — 실기기 없이)

Node 22 이상이면 된다. 서버 주소는 환경변수로 준다.

```bash
cd app
npm install
npm run verify           # ← 기기에 올리기 전에 반드시 이것부터

TRANSLATE_BASE_URL=https://translate.sinsan.kr \
TRANSLATE_AUDIO=/path/to/16k-mono.wav \
npm run smoke            # 서버까지 함께 (네트워크 필요)
```

`npm run verify` 는 넷을 순서대로 돌린다. **하나라도 깨지면 기기로 가지 않는다.**

| | 무엇을 잡는가 |
|---|---|
| `bundle:check` | 모듈 해석·문법. 깨지면 기기에서 "Unable to load script" 가 뜬다 |
| `typecheck` | 세 설정 모두 (§3). 하나만 돌리면 이식성 보장이 새어나간다 |
| `lint` | |
| `test` | **두 화면이 실제로 그려지는지**, 리샘플·프레이밍·WAV 파싱, 스텁의 불활성 |

**이 관문은 사고를 두 번 겪고 만들었다.** 한 번은 번들이 만들어지지 않는 채로 기기에
올려 "Unable to load script" 가 떴고, 한 번은 스텁이 모듈 평가 중에 예외를 던져 앱이
화면 한 번 못 그리고 종료됐다. 둘 다 `bundle:check` 와 렌더 테스트로 잡혔을 것들이다.
게다가 그때 있던 렌더 테스트는 `SafeAreaProvider` 가 인셋을 못 재 **빈 트리를 그리며
통과하고 있었다** — 지금은 `jest.setup.js` 가 그것을 막는다.

| 환경변수 | |
|---|---|
| `TRANSLATE_BASE_URL` | 필수 |
| `TRANSLATE_API_KEY` | 서버에 `auth.api_key` 가 설정돼 있을 때만 |
| `TRANSLATE_AUDIO` | 16kHz mono PCM16 WAV. 없으면 WS 오디오 왕복을 건너뛴다 |
| `TRANSLATE_LOCALE_A` / `_B` | 오류 문구를 비교할 두 로케일 (기본 `ko` / `en`) |

스모크 테스트가 보는 것: `/v1/config` 로케일별 파싱 · 텍스트 번역 왕복 ·
오류 봉투(`code`/`params` 파싱과 로케일별 `detail`) · WS 왕복
(`ready` → 오디오 전송 → `stt.final` → `llm.final` → `tts.chunk`+바이너리 → `tts.done` → `metrics`) ·
WS 오류 이벤트. **29개 전부 통과가 정상이다** — RN 을 얹은 뒤에도 같다.

`npm test` 는 두 가지를 본다.

- `__tests__/App.test.tsx` — App.tsx 가 렌더되는지
- `__tests__/capture.test.ts` — `audio/capture.ts` 의 **배선**. 라이브러리를 늦게 부르는
  경로가 이어지는지, `/v1/config` 규격이 그대로 `onAudioReady` 옵션으로 가는지,
  성공 봉투(`{status:'success'}`)를 실패로 오해하지 않는지
- `__tests__/pcm.test.ts` — **`audio/pcm.ts` 의 계산.** PCM16 변환·클리핑,
  20ms 프레이밍(320샘플 = 640바이트, 자투리는 다음 프레임으로), 48k→16k 리샘플
  (샘플 수와 주파수가 보존되는지), WAV 읽기(**헤더의 44.1kHz 를 쓰고 fallback 을 쓰지 않는지**,
  스테레오 다운믹스, 헤더도 `sr` 도 없으면 조용히 재생하지 않고 던지는지)

그러느라 `react-native-audio-api` 는 그 패키지가 제공하는 목(`react-native-audio-api/mock`)
으로 바꿔 끼운다 (`jest.config.js`). jest 는 네이티브 모듈이 없는 Node 에서 돌기 때문이다.

**여기서 확인되지 않는 것이 있다.** 위는 전부 Node 에서 도는 검사라
`ui/LiveScreen.tsx`·`audio/capture.ts`·`audio/playback.ts` 가 **실기기에서** 도는지는
알려주지 않는다. 마이크가 실제로 열리는지, `onAudioReady` 가 요청한 규격대로 올려주는지,
스피커에서 제 속도로 나는지는 §8 의 "실기기에서 볼 것"으로만 확인된다.
`audio/pcm.ts` 가 그 사이에서 계산을 맡고 있으므로, 실기기에서 소리가 이상하면
**"계산이 틀렸나"는 이 테스트가 이미 답해준 셈**이고 네이티브 쪽부터 보면 된다.

---

## 6. 로컬 PC 에서 시작하기 (Windows + Android)

### 필요한 것

| | |
|---|---|
| **Node LTS** (22 이상) | https://nodejs.org — `node -v` 로 확인 |
| **JDK 17** | Android Studio 가 함께 설치해준다 (Temurin 17 도 됨) |
| **Android Studio** | SDK Platform 35 + Platform-Tools + Build-Tools |
| **실기기 또는 에뮬레이터** | **실기기를 권한다** — 마이크·에코·지연이 이 앱의 전부인데 에뮬레이터에서는 그게 실제와 다르다 |
| **Git** | |

환경변수 `ANDROID_HOME` 을 SDK 경로로 잡고 `platform-tools` 를 PATH 에 넣는다.

### 빌드해서 기기에 올리기

```bash
git clone <이 저장소> translate
cd translate/app
npm install
npm run typecheck

adb devices              # 기기가 목록에 보여야 한다. 안 보이면 USB 디버깅부터
npm run android          # 첫 빌드는 Gradle 이 의존성을 받으므로 오래 걸린다
```

`npm run android` 가 Metro(`npm start`)를 함께 띄운다. 이미 떠 있으면 그것을 쓴다.
앱을 고치면 저장만으로 반영된다 — 네이티브(`android/`)를 건드렸을 때만 다시 빌드한다.

**이전에 빌드해 둔 APK 가 있으면 한 번은 다시 빌드해야 한다.** `react-native-audio-api` 는
네이티브(C++/oboe)를 얹는 의존성이고 `AndroidManifest.xml` 에 `RECORD_AUDIO` 가 늘었다.
JS 만 새로고침하면 실시간 화면에서 마이크가 안 열린다.

기기가 이 PC 의 Metro 를 못 찾으면 `adb reverse tcp:8081 tcp:8081` 를 한 번 준다.

서버가 살아 있는지는 브라우저로 https://translate.sinsan.kr 을 열어보면 바로 안다 —
웹 클라이언트가 앱이 할 일을 이미 전부 하고 있다. 막히면 `web/static/app.js` 를 보면 된다.

---

## 7. 연결 확인 화면 (스파이크) — `ui/ConnectScreen.tsx`

앱을 띄우면 처음 나오는 화면이다. 하는 일이 적은 것이 의도다. **이 화면이 확인하는 것은
딱 하나 — 실기기에서 `RN → src/api → 서버` 경로가 사는가.**

**실시간 화면이 생겼다고 이 화면을 지우지 않았다.** 실시간 경로가 막혔을 때
"서버는 살아 있다"를 확인할 유일한 수단이라서다. 위쪽 탭으로 오간다 —
화면이 둘뿐이라 네비게이션 라이브러리 대신 상태 하나로 전환한다.

| 누르면 | |
|---|---|
| **설정 조회** | `GET /v1/config` → server_id · 로케일 · 프로필 수 · 준비된 엔진 수 · 언어 수 · 세션 기본 언어 · WS 경로 · 마이크 규격 |
| **텍스트 번역** | `POST /v1/translate/text` → 번역문 · 프로바이더 · 모델 · 소요 시간 |

곁들여 세 가지를 함께 본다.

1. **주입 구조가 실제로 도는가** — `const rnFetch: FetchLike = fetch;` 한 줄이다.
   캐스팅 없이 타입 체크를 통과하는 것 자체가 `FetchLike` 가 Node 와 RN 양쪽에
   맞게 선언됐다는 증거다 (스모크 테스트에서 Node 전역을 넘기던 자리와 같다)
2. **주소가 소스에 없는가** — 서버 주소·API 키·로케일은 `app.config.json` 에서 읽는다.
   저장소에는 **빈 값으로** 커밋돼 있으므로 그대로 두면 화면에서 입력하게 되고,
   매번 타이핑이 귀찮으면 그 파일에 적어두면 된다. 소스에는 여전히 없다.
   단 그 파일은 추적되는 파일이니 **실제 API 키를 적었으면 커밋에 섞지 말 것**
   (`git checkout -- app.config.json` 으로 되돌린다)
3. **문구를 앱이 만들지 않는가** — 번역 언어는 `/v1/config` 의
   `session.default_source_lang`/`default_target_lang` 에서 오고, 오류는 서버가 로케일로
   렌더한 `detail`(+`code`)을 **그대로** 띄운다

**오디오·WebSocket 은 여기 없다.** 위험을 하나씩 더하는 순서를 지키는 것이고,
그것이 §8 이다. 화면 문구는 한국어를 그대로 썼다 — 스파이크라 i18n 대상이 아니다.

---

## 8. 실시간 통역 화면 — `ui/LiveScreen.tsx`

**마이크로 말하면 번역된 음성이 나오는 경로다.** 웹 클라이언트(`web/static/app.js` 의
handsfree 입력 방식)가 하는 일을 앱으로 옮긴 것이고, 흐름도 같다.

```
권한 → GET /v1/config → WS 열기(config 전송) → ready → 마이크 캡처 시작
     → PCM16 20ms 프레임 …  → vad / stt / llm / tts.chunk(+오디오) / metrics
```

### 화면에서 무엇을 보는가

| | |
|---|---|
| **상태** | 대기 중 / 말하는 중 / 처리 중 / 재생 중 — `vad` 와 재생 상태로 바뀐다 |
| **레벨 미터 · 보낸 프레임** | 마이크가 실제로 듣고 있는지, 프레임이 실제로 나가고 있는지. **막혔을 때 여기부터 본다** |
| **세션** | `ready` 가 알려준 session_id · 프로필 / 모드 / 턴 정책 · **서버가 확정한 입력 규격** · VAD 백엔드 |
| **SEG n** | 세그먼트 하나. 원문(`stt.*`) → 번역문(`llm.*`, 수신자별) → 지표(`metrics`) |
| **오류** | 서버가 준 `error.message` **그대로.** 앱이 문장을 만들지 않는다 |
| **기록** | 리샘플 통지 · 너무 짧은 발화 · 재생한 오디오 규격 · 소켓 종료 코드 등 진단 부스러기 |

지표는 서버가 보낸 키를 그대로 편다 — `stt_ms`, `llm_ms.<수신자>`, `tts_ms.<수신자>`,
`total_ms`, `audio_duration_s` …. **앱에 키 목록이 없다.** 서버가 지표를 하나 더하면
이 파일을 고치지 않아도 화면에 뜬다.

`speaker.rejected` 는 오류가 아니라 "이 세그먼트를 처리하지 않았다"이므로
세그먼트에 사유만 붙여 표시하고 오류 상자에는 넣지 않는다.

### 권한을 거부하면

`통역 시작`을 누르면 먼저 `RECORD_AUDIO` 를 묻는다 (`PermissionsAndroid`).

| 답 | 화면 |
|---|---|
| 허용 | 그대로 진행 — 설정 조회 → WS → 캡처 |
| 거부 | **오류 상자**: "마이크 권한이 거부됐다. 권한 없이는 캡처를 시작할 수 없다." 다시 누르면 다시 묻는다 |
| 다시 묻지 않음 | **오류 상자**: 기기의 설정 → 앱 → 권한에서 직접 켜야 한다고 알린다. 안드로이드가 더 이상 대화상자를 띄우지 않으므로 앱에서 할 수 있는 것이 없다 |

권한이 없으면 **WS 도 열지 않는다.** 마이크 없이 세션만 열려 있는 상태를 만들지 않기 위해서다.

### 실기기에서 볼 것

1. 앱을 띄우고 서버 주소를 넣는다 (탭을 바꿔도 주소는 그대로 남는다)
2. **연결 확인** 탭에서 `설정 조회` 가 되는지 먼저 본다 — 여기가 안 되면 실시간도 안 된다
3. **실시간 통역** 탭 → `통역 시작` → 마이크 권한 허용
4. **세션** 상자에 `서버 확정 규격 16000Hz 1ch pcm16 · 20ms` 가 뜨는지 본다
5. 말한다 → 상태가 `말하는 중` 으로 바뀌고 레벨 미터가 움직이는지, `보낸 프레임` 이 느는지
6. 말을 멈춘다 → `처리 중` → **SEG 0** 에 원문 → 번역문 → **소리** → 지표

### 막혔을 때 어디를 보나

| 증상 | 볼 곳 |
|---|---|
| 화면이 아예 안 뜬다 / 빨간 화면 | **Metro 로그** (`npm start` 를 띄운 창). JS 오류는 거기 전부 찍힌다 |
| `통역 시작` 이 오류 상자로 끝난다 | 문장을 읽는다. **서버 문장이면 서버 문제**(코드가 함께 뜬다), 권한 문장이면 기기 설정 |
| 프레임은 나가는데 아무 이벤트가 없다 | 서버 쪽 VAD. `기록` 에 "발화가 너무 짧아 버려졌다"가 뜨는지, 레벨 미터가 실제로 움직이는지 |
| `보낸 프레임` 이 0 에서 안 는다 | 마이크가 안 열린 것이다. `adb logcat -s AudioPlayer AndroidAudioRecorder ReactNativeJS` — oboe 가 스트림을 못 연 이유가 여기 찍힌다 |
| 소리가 이상하다 (빠르거나 느리다) | `기록` 의 `TTS 오디오 wav 44100Hz 1ch` 줄. 이 값과 실제 재생이 어긋나면 재생 컨텍스트 문제다 (`audio/playback.ts` 의 주석) |
| 서버가 살아 있는지 모르겠다 | **연결 확인** 탭. 그것도 안 되면 브라우저로 서버 웹 클라이언트를 열어본다 — 앱이 할 일을 이미 전부 하고 있다 |

`adb logcat` 은 `adb logcat *:S ReactNativeJS:V` 로 JS 로그만 걸러 보는 편이 빠르다.

### 라이브러리를 어떻게 썼나 — `react-native-audio-api` 0.13.2

**캡처는 `AudioRecorder` 하나로 한다.** 웹의 `getUserMedia` + `AudioContext(rate)` +
AudioWorklet 조합에 해당한다.

```ts
recorder.onAudioReady(
  { sampleRate, bufferLength: frameSamples, channelCount },   // 전부 /v1/config 에서
  event => { /* event.buffer 는 Float32 AudioBuffer */ },
);
await recorder.start();
```

이 라이브러리의 **워크릿 노드**(`createWorkletNode` 등)를 쓰지 않은 이유는
`react-native-worklets` 를 함께 깔아야 하기 때문이다 — package.json 의
`peerDependenciesMeta` 에서 optional 이라 없어도 설치는 되지만 그 기능만 못 쓴다.
20ms 프레임을 소켓으로 흘려보내는 데는 `onAudioReady` 로 충분하고, 의존성도 하나로 끝난다.

**규격은 믿지 않는다.** `onAudioReady` 의 옵션은 라이브러리 문서가 "선호값"이라고 적어둔
것이고, 실제 값은 기기에 따라 다를 수 있다고 그 doc comment에 그대로 있다. 그래서
올라온 버퍼의 `sampleRate` 를 확인하고 어긋나면 `audio/pcm.ts` 의 리샘플러가 맞춘다
(`capture-worklet.js` 와 같은 선형 보간이다). 서버는 다른 레이트를 받으면 끊는다.

**재생은 청크의 샘플레이트로 `AudioContext` 를 연다.**

```ts
const context = new AudioContext({ sampleRate });   // tts.chunk 의 sr (또는 WAV 헤더)
const buffer = context.createBuffer(1, samples.length, sampleRate);
buffer.copyToChannel(samples, 0);
```

컨텍스트 레이트를 굳이 맞추는 이유는 **이 라이브러리가 버퍼와 컨텍스트의 레이트가 다를 때
리샘플해주지 않기 때문이다** — `AudioBufferBaseSourceNode` 가 playbackRate·detune 만
곱하고 버퍼의 sampleRate 는 보지 않는다(라이브러리 C++ 소스에서 확인). 44.1k 버퍼를
48k 컨텍스트에 넣으면 그만큼 빨라진다. 컨텍스트를 44100 으로 열면 기기 출력까지는
안드로이드 쪽(oboe)이 맞춰준다.

청크는 프라미스 체인으로 한 줄로 세우고 재생 시각을 직전 청크 끝에 붙인다 —
지금은 세그먼트당 청크가 하나지만 여러 개가 이어서 와도 순서대로 재생된다.

**라이브러리를 파일 맨 위에서 값으로 import 하지 않았다** (`audio/module.ts`).
이 라이브러리는 import 되는 순간 네이티브 모듈을 설치하고 못 찾으면 그 자리에서 던지는데,
그 예외가 번들 평가 중에 터지면 **앱 전체가 뜨지 않는다** — 연결 확인 화면까지 함께 죽는다.
JS 만 새로고침하고 APK 를 다시 빌드하지 않았을 때 실제로 그렇게 된다. 그래서 타입만 위에서
가져오고 실물은 마이크를 열 때 부른다. 그러면 그 실패가 **실시간 화면의 오류 상자에만** 뜨고
연결 확인 화면은 그대로 산다 — "지금 되는 것을 잃지 않는다"가 이 한 겹의 목적이다.

### 다음 — 온디바이스 ONNX

남은 스파이크는 `onnxruntime-react-native` 로 Supertonic 모델을 실기기에 올리는 것이다
(`APP.md` §7). **의존성은 그것 하나만 따로 추가한다** — 실시간 경로가 도는 것을 확인한 뒤에.
여기서 막히면 온디바이스 요구가 흔들리므로 네이티브 Kotlin 으로 다시 본다.

---

## 9. 알아두면 좋은 프로토콜 사실

서버 소스를 읽고 확인한 것들이다. 실기기 작업에서 걸리기 쉬운 순서로 적는다.

- **샘플레이트를 서버가 맞춰주지 않는다.** `config` 에 실은 `sample_rate` 가
  `audio.stt_sample_rate` 와 다르면 리샘플링 대신 `stream.sample_rate` 오류로 끊긴다.
  기기 마이크가 48kHz 로 열리면 앱이 16kHz 로 내려야 한다
- **오디오는 `ready` 를 받은 뒤에 보낸다** (`sendAudio()` 가 그때까지 보내지 않는다).
  서버는 config 를 거절하면 소켓을 닫으므로, 그전에 보낸 프레임은 버려질 수도 있고
  세션이 열린 뒤 뒤늦게 처리될 수도 있다 — 어느 쪽이든 규격 확인(`ready.audio`)이
  끝나기 전에 마이크를 흘려보낼 이유가 없다
- **`tts.chunk` 다음 바이너리 프레임이 그 청크의 오디오다.** 서버가 송신 락으로 순서를
  보장한다. 지금은 세그먼트당 청크가 하나(`seq: 0`)로 통째로 오지만, 프로토콜은 여러 개를
  전제하므로 이어붙일 수 있게 만들어 두는 편이 낫다
- **TTS 출력 샘플레이트는 입력과 다르다.** 입력은 16kHz 인데 합성 결과는 엔진이 정한다
  (실측 44.1kHz). 재생 쪽은 `tts.chunk` 의 `sr` 을 보고 열어야 한다
- **`speaker.rejected` 는 오류가 아니다.** 등록되지 않은 목소리라 그 세그먼트를 건너뛴 것이고,
  같은 사유가 뒤따르는 `metrics` 의 `skipped` 에도 실린다
- **`vad` 의 `dropped: true`** 는 발화가 `min_speech_ms` 에 못 미쳐 버려졌다는 뜻이다.
  파이프라인이 돌지 않으므로 "처리 중" 표시를 되돌려야 한다
- **`stt.partial` 과 `llm.delta` 는 아직 오지 않는다** (2단계). 프로토콜과 타입에는 이미 있다
- **`to` 의 타입이 이벤트마다 다르다.** 발화자 쪽(ready·vad·stt.\*)은 수신자 **배열**,
  수신자 쪽(llm.\*·tts.\*)은 **문자열**이다. 다중 기기에서는 자기 id 가 `to` 에 있는 것만 본다
- **재생 상태를 알려주면 좋다.** `session.playback('start'|'end')` 가 서버의 추정을 덮는다.
  `half_duplex` 에서 마이크가 다시 열리는 시점이 여기 달려 있다
- **모르는 이벤트는 흘려보낸다.** 서버가 단계를 늘려도 앱이 깨지지 않게 하기 위한 규약이고,
  `stream.ts` 도 그렇게 되어 있다
