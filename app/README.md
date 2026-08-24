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
  App.tsx             뿌리 — 설정을 들고 세 화면을 전환한다
  app.json            RN 앱 이름 (RN 이 만든 것, 건드리지 않는다)
  app.config.json     서버 주소 · API 키 · 로케일 — 빈 값으로 커밋돼 있다 (§7).
                       한 번 입력하면 storage.ts 가 기기에 남겨 다시 고칠 필요가 없다
  storage.ts          고른 설정을 기기에 남긴다 — 앱을 껐다 켜도 그대로다 (§10)

  android/            Android 네이티브 프로젝트  ← 지금 빌드하는 것
  ios/                iOS 네이티브 프로젝트     ← Mac 이 생기면 쓴다. 지금은 손대지 않는다

  ui/
    ConnectScreen.tsx 연결 확인 화면 — 스파이크 (§7)
    SettingsScreen.tsx 설정 화면 — 통역할 언어·프로필·모드·엔진 (§10)
    settings.ts       그 화면이 그릴 폼의 모델 + WS config 메시지 조립 (§10)
    inputMode.ts      입력 방식 구현 레지스트리 — 누르고 말하기 / 핸즈프리 (§8)
    LiveScreen.tsx    실시간 통역 화면 (§8)
    EnrollScreen.tsx  화자 등록 화면 — 목소리 등록 · 조회 · 삭제 (§11)
    Button.tsx        네 화면이 함께 쓰는 버튼
    theme.ts          색과 공용 스타일 조각
  audio/
    pcm.ts            Float32↔PCM16 · 리샘플 · 프레이밍 · WAV 읽기/쓰기 · base64 (RN 무의존)
    capture.ts        마이크 → 규격 PCM16 프레임
    playback.ts       tts.chunk → 순서대로 이어 재생
    module.ts         오디오 라이브러리를 늦게 부르는 한 겹 (§8)

  src/api/
    types.ts          서버 응답·WS 이벤트 타입 (서버 소스를 읽고 맞춘 것)
    http.ts           fetch 주입, URL 조립, 오류 봉투 → 예외
    config.ts         GET /v1/config
    speakers.ts       화자 등록 GET/POST/DELETE /v1/speakers* (§11)
    stream.ts         WS 스트리밍 프로토콜 (바이너리 짝짓기 포함)
    translate.ts      POST /v1/translate/{text,audio}
    index.ts          입구 — 앱은 이것만 import 한다
  test/
    smoke.ts          실제 서버에 대고 도는 검증 (Node 전용)

  tsconfig.json       RN 앱 코드용 (§3)
  tsconfig.api.json   src/api 이식성 감시자 (§3)
  tsconfig.test.json  스모크 테스트용 (§3)
```

**아직 없는 것**: 온디바이스 ONNX, 네비게이션 라이브러리.

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

`npm test` 는 이런 것들을 본다.

- `__tests__/screens.test.tsx` — **네 화면이 실제로 그려지는지**, 폼이 `/v1/config` 응답에서
  만들어지는지(모드 목록이 엔진들의 합집합인지, 못 쓰는 항목이 이유와 함께 잠기는지),
  그리고 **고른 값이 WS `config` 메시지까지 가는지**. 마지막 것은 전역 `WebSocket` 을
  가짜로 바꿔 끼우고 `LiveScreen` 이 실제로 내보내는 첫 메시지를 읽는다 — 화면만 있고
  반영은 안 되는 것을 잡으려는 테스트다.
  **입력 방식도 같은 방식으로 본다** (§8) — 누르고 말하기에서 버튼을 누르지 않으면
  오디오가 한 프레임도 나가지 않는지, 누르면 나가고 떼면 `control/flush` 가 나가는지,
  시작하기도 전에 뗀 오터치가 `flush` 를 보내지 않는지, 핸즈프리는 여전히 연결 즉시
  캡처하는지. 마이크 목의 `onAudioReady` 를 가로채 **버퍼가 올라온 것과 같은 처리**를
  손으로 일으켜 소켓으로 나간 바이트를 센다.
  **화자 등록도 같은 원칙으로 본다** (§11) — 참여자 후보가 프로필에서 그대로 나오는지
  (듣기만 하는 참여자는 빠지고, 참여자가 없으면 자유 입력으로 떨어지는지), 그리고
  클립을 녹음해 등록을 눌렀을 때 **실제로 나가는 `FormData`** 를 본다 — `fetch` 를
  가짜로 끼워 `speaker_id`/`mode`/`files` 개수를 확인하고, 서버가 렌더한 `warning` 문장이
  그대로 뜨는지도 본다
- `__tests__/App.test.tsx` — App.tsx 가 렌더되는지
- `__tests__/capture.test.ts` — `audio/capture.ts` 의 **배선**. 라이브러리를 늦게 부르는
  경로가 이어지는지, `/v1/config` 규격이 그대로 `onAudioReady` 옵션으로 가는지,
  성공 봉투(`{status:'success'}`)를 실패로 오해하지 않는지
- `__tests__/pcm.test.ts` — **`audio/pcm.ts` 의 계산.** PCM16 변환·클리핑,
  20ms 프레이밍(320샘플 = 640바이트, 자투리는 다음 프레임으로), 48k→16k 리샘플
  (샘플 수와 주파수가 보존되는지), WAV 읽기(**헤더의 44.1kHz 를 쓰고 fallback 을 쓰지 않는지**,
  스테레오 다운믹스, 헤더도 `sr` 도 없으면 조용히 재생하지 않고 던지는지), **WAV 쓰기**
  (encode → decode 왕복으로 샘플이 보존되는지, 44바이트 표준 헤더가 맞는지 — 화자 등록
  클립 업로드용, §11), base64 인코딩(Node 의 `Buffer` 인코딩과 같은 결과를 내는지)

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
셋으로 늘어난 지금도 네비게이션 라이브러리 대신 상태 하나로 전환한다.

`텍스트 번역` 이 쓰는 언어는 **설정 화면에서 고른 값**이다 (§10). 아무것도 고르지
않았으면 `/v1/config` 의 세션 기본값 그대로다. 어느 쪽이 쓰였는지는 `설정 조회` 결과의
`고른 언어` 줄에 그대로 뜬다.

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

### 입력 방식 — 마이크를 어떻게 다루는가

**설정 화면에서 고른 `input_mode` 를 이 화면이 따른다.** 목록·순서·기본값은 `/v1/config`
의 `client.input_modes` · `client.default_input_mode` 에서 오고, 구현은
`ui/inputMode.ts` 에 있다 (웹의 `inputModes` 레지스트리와 같은 구조다). 앱에 구현이 없는
이름은 설정 화면에 나오지 않는다 — 고르면 아무 일도 안 하는 항목을 만들지 않기 위해서다.

| | 마이크 | 세그먼트 경계 |
|---|---|---|
| **핸즈프리** | `ready` 뒤에 열어 계속 흘려보낸다 | 서버 VAD (`vad.silence_ms`) |
| **누르고 말하기** | **버튼을 누르는 동안만** 연다 | 손을 뗄 때 `control/flush` → 서버가 그 자리에서 확정 |

누르고 말하기가 필요한 이유는 두 가지다. 시끄러운 곳에서 VAD 자동 판정보다 사용자가 직접
경계를 정하는 편이 안정적이고, **누르지 않는 동안 프레임이 하나도 나가지 않으므로** 배경
소음이 VAD·STT 에 닿지 않는다.

`flush` 를 받은 서버는 `_drain_vad(force=True)` 로 침묵을 기다리지 않고 세그먼트를 닫으며
사유를 `forced` 로 표시한다 (`streaming.py`). 너무 짧은 것은 서버의 `vad.min_speech_ms`
가 걸러내고, 앱은 **캡처가 실제로 시작된 뒤에 뗐을 때만** `flush` 를 보낸다.

**세션 `mode` 와 헷갈리지 말 것.** 이름이 겹치지만 다른 축이다.

| | 무엇인가 | 어디서 오나 |
|---|---|---|
| `mode` (세션) | 서버가 어느 엔진·경로를 쓸지 | `engines[].modes` 의 합집합. 서버로 나간다 |
| `input_mode` (클라이언트) | 앱이 마이크를 어떻게 다루는지 | `client.input_modes`. **서버로 나가지 않는다** |

손을 떼는 것을 `onPressOut` 하나에만 맡기지 않는다. RN 의 `Pressability` 는 손가락이
버튼 밖으로 미끄러지거나(`LEAVE_PRESS_RECT`) 스크롤이 터치를 가져갈 때
(`RESPONDER_TERMINATED`) 도 `onPressOut` 을 부르지만, **언마운트 때는 부르지 않는다**
(`reset()` 이 설정을 얼린다). 그래서 화면을 벗어날 때(탭 전환·언마운트)와 앱이 뒤로
넘어갈 때(`AppState`) 도 같은 정리를 지나가게 해뒀다 — 화면이 사라진 뒤에도 마이크가
도는 것이 이 방식에서 가장 나쁜 실패다.

### 화면에서 무엇을 보는가

| | |
|---|---|
| **상태** | 대기 중 / 말하는 중 / 처리 중 / 재생 중 — `vad` 와 재생 상태로 바뀐다. 그 아래에 `입력 방식 <이름>` 과 버튼 상태(누르는 중 / 대기 / 연속 캡처)가 함께 뜬다 |
| **누르고 말하기 버튼** | 그 방식으로 열렸을 때만 나온다. 누르는 동안 색이 바뀌고 문구가 `듣는 중 — 손을 떼면 번역한다` 로 바뀐다 |
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
3. **설정** 탭에서 사용어·목표어를 고른다 (§10). 아래 `세션을 이 값으로 연다` 상자가
   실제로 나갈 메시지다
4. **실시간 통역** 탭 → `통역 시작` → 마이크 권한 허용
5. **세션** 상자에 `서버 확정 규격 16000Hz 1ch pcm16 · 20ms` 가 뜨는지, 그리고
   **`프로필 / 모드` 가 설정 탭에서 고른 것과 같은지** 본다 — 이 줄이 서버가 확정한 값이다
6. 말한다 → 상태가 `말하는 중` 으로 바뀌고 레벨 미터가 움직이는지, `보낸 프레임` 이 느는지
7. 말을 멈춘다 → `처리 중` → **SEG 0** 에 원문 → 번역문 → **소리** → 지표

**누르고 말하기로 열었으면** 6·7 대신 이렇게 본다.

1. `보낸 프레임` 이 **0 에서 멈춰 있는지** — 누르지 않았는데 늘면 게이트가 새는 것이다
2. 버튼을 누른 채 말한다 → 그동안만 프레임이 늘고 레벨 미터가 움직인다
3. 손을 뗀다 → 바로 `처리 중` → SEG (침묵 600ms 를 기다리지 않는다)
4. 누른 채로 손가락을 버튼 밖으로 밀어 보고, 화면을 스크롤해 본다 → 두 경우 다 캡처가
   멈춰야 한다 (`보낸 프레임` 이 더 늘지 않는다)
5. 누른 채로 다른 탭으로 가거나 홈 버튼을 누른다 → 마이크가 남지 않아야 한다

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

---

## 10. 설정 화면 — `ui/SettingsScreen.tsx` + `ui/settings.ts`

**통역할 언어를 여기서 고른다.** 이것이 없을 때 앱은 `/v1/config` 의 세션 기본값
(ko→en)으로 고정돼 있어 통역기로 쓸 수 없었다.

### 폼을 하드코딩하지 않는다

웹 클라이언트(`web/static/app.js` 의 `renderSettings`)와 같은 규칙이다. DOM 코드를 옮긴
것이 아니라 **같은 규칙을 RN 쪽에서 다시 썼다.** `ui/settings.ts` 에 목록이 하나도 없다 —
언어 코드도, 프로필 이름도, 모드 이름도, 엔진 이름도. 서버에 언어가 하나 늘면
**앱을 고치지 않아도** 화면에 늘어난다.

| 항목 | `/v1/config` 의 어디에서 | 규칙 |
|---|---|---|
| 사용어 / 목표어 | `languages[]` | `label` 을 보여주고 `code` 를 보낸다. 로케일별 표시 이름은 서버가 이미 렌더해서 준다 |
| 세션 프로필 | `profiles[]` | `available:false` 는 누를 수 없고 `reason` 이 함께 뜬다. `session.allow_profile_override` 가 false 면 항목 자체가 없다 |
| 모드 | `engines[].modes` 의 **합집합** | 목록이 코드에 없다. `session.allow_mode_override` 가 false 면 항목 자체가 없다 |
| 입력 방식 | `client.input_modes` | 기본값은 `client.default_input_mode`. **서버로 나가지 않는다** — 앱이 마이크를 어떻게 다루는지이고, 실시간 화면이 다음에 여는 세션부터 따른다 (§8). 앱에 구현이 없는 이름은 걸러낸다 |
| 엔진 | `engines[]` | `kind` 별로 하나씩 — `stt`/`tts` 를 코드가 알지 못하고 응답의 `kind` 를 훑는다. 필드 이름도 `<kind>_engine` 으로 만들어진다 |
| LLM 프로바이더 | `llm.providers[]` | 프로바이더가 없는 서버면 항목 자체가 없다 |
| LLM 모델 | `GET /v1/models` (별도 요청) | 프로바이더를 고르면 그 프로바이더의 모델만 나온다. 목록을 **못 받았으면 막지 않고** 자유 입력으로 남기고, 자리표시로 무엇이 쓰이는지(`default_model`) 또는 왜 못 받았는지(서버가 렌더한 `reason`)를 보여준다 |

기본값은 전부 `session.default_*` 와 `client.default_input_mode` 에서 온다.
고르려던 값이 고를 수 없게 되면(서버 설정이 바뀌었을 때 등) **첫 번째 고를 수 있는 값으로
물러난다** — 쓸 수 없는 프로필로 세션을 열어 거절당하지 않기 위해서다. 웹과 같은 규칙이다.

RN 에는 `<select>` 가 없어서 눌러 고르는 **칩**으로 뒀다. 피커 라이브러리를 넣지 않은 것은
의도다 — 이번 변경은 네이티브를 건드리지 않아 **재빌드 없이 Metro 새로고침만으로** 확인된다.

### 고른 값이 실제로 쓰인다

화면만 있고 반영이 안 되면 의미가 없으므로 배선을 짧게 뒀다.

```
SettingsScreen  →  App.tsx 의 form  →  streamConfig(config, form, locale)  →  WS config
                                    →  chosenLanguages(config, form)      →  텍스트 번역
```

- `LiveScreen` 은 세션을 열 때마다 `/v1/config` 를 새로 받아 그 위에 `form` 을 얹는다.
  그래서 서버가 목록을 바꿔도 고른 값이 낡은 채로 나가지 않는다
- 빈 값은 **아예 넣지 않는다.** 서버는 없는 키에만 자기 기본값을 쓰므로(`streaming.py` 의
  `_options`) 빈 문자열을 보내면 기본값 대신 빈 값이 적용되는 자리가 생긴다
- 화면 아래 `세션을 이 값으로 연다` 상자가 그 메시지를 그대로 편다. 실기기에서 반영 여부를
  눈으로 확인하는 자리이고, 서버가 확정한 값은 실시간 화면의 `세션` 상자(`ready`)에 뜬다

### 알려진 한계

- ~~저장하지 않는다~~ → **저장한다** (`storage.ts`). 서버 주소·API 키·고른 값이 기기에
  남아 앱을 껐다 켜도 채워져 있다. `@react-native-async-storage/async-storage` 를
  §1 의 규칙대로 **하나만** 따로 추가했으므로, 이 변경을 받은 뒤에는 재빌드가 한 번 필요하다.
  API 키가 기기에 **평문으로** 남는다는 것은 알고 쓸 것 — 한 사람이 자기 서버에 붙는
  개인 서비스라 그렇게 두었다(`storage.ts` 첫 주석에 근거를 적었다)
- **입력 방식은 세션을 열 때 정해진다.** 실시간 화면이 이 값을 따르지만(§8), 이미 열려
  있는 세션 중간에 바꾸면 다음 연결부터 적용된다. 값 자체는 여전히 서버로 나가지 않는다
  (웹에서도 transient 다)
- **보이스·번역 문체(`style`)는 넣지 않았다.** 응답에는 있다(`engines[].voices`,
  `llm.styles`). 웹에는 이미 있으므로 같은 규칙으로 더하면 된다

---

## 11. 화자 등록 화면 — `ui/EnrollScreen.tsx`

**다른 과제 #22(STT 품질)에 직접 닿는 기능이다.** 등록된 목소리만 통역하게 하면 TV 소리나
옆 사람 말이 파이프라인에 아예 들어가지 않는다. 서버·웹 클라이언트(`web/static/app.js` 의
`enrollVoice`/`toggleEnrollRecording`/`speakerCandidates`)에는 이미 있던 것을 앱에 옮겼다 —
DOM 코드를 그대로 가져온 것이 아니라 같은 규칙을 RN 으로 다시 썼다.

```
GET    /v1/speakers          등록된 화자 목록 (임베딩 벡터는 절대 없다 — 서버가 안 준다)
POST   /v1/speakers/enroll   클립들의 평균 임베딩을 등록 (같은 id 는 대체)
DELETE /v1/speakers/{id}     즉시 삭제
```

세 엔드포인트는 `src/api/speakers.ts` 에 있다(`fetchSpeakers`/`enrollSpeaker`/
`deleteSpeaker`). 정책·임계값·자동 등록 여부·등록 수는 여기 없다 — `GET /v1/config` 의
`speaker_id` 절(`types.ts` 의 `SpeakerIdView`)에서 온다.

### 참여자 후보 — 프로필을 벗어나지 않는다

등록 id 는 **세션 참여자 id 와 같아야** 대조가 된다. 그래서 화면은 후보 목록을 지어내지
않고 지금 고른 세션 프로필의 `/v1/config` 의 `profiles[].participants` 를 그대로 쓴다.
말하는 참여자(`input: true`)만 후보로 남고, 프로필이 참여자를 안 주면(빈 배열) 자유
입력으로 id 를 받는다 — 웹의 `speakerCandidates()` 와 같은 규칙이다.

### 녹음 — 새 캡처 코드를 만들지 않았다

`audio/capture.ts` 의 `MicCapture` 를 그대로 쓴다. 실시간 화면의 PTT 패턴(누르는 동안
프레임을 모으고, 떼면 확정)을 따르되 여기서는 버튼이 **토글**이다 — 누르면 시작하고,
다시 누르면 그 클립 하나를 마친다. 오디오 라이브러리를 늦게 부르는 것도 `MicCapture` 가
이미 해주므로(`audio/module.ts`) 이 화면은 신경 쓸 필요가 없다 — **이 부분에서 실제로
앱이 죽은 적이 있어서(§8) 새 코드를 얹지 않고 검증된 것을 재사용했다.**

클립마다 PCM16 프레임을 모아 `audio/pcm.ts` 의 `concatPcm16()` + `encodeWav()` 로 표준
WAV 로 감싼다. 여러 개의 짧은 클립을 모을수록 평균 임베딩이 안정적이다 — 등록 응답의
`min_pairwise_similarity` 가 그 근거다(웹과 같은 이유).

### 업로드 — RN 의 `Blob` 이 원시 바이트를 감쌀 수 없다

멀티파트로 파일을 올리려면 보통 `Blob` 을 만드는데, RN 의 `Blob` 생성자는 **다른
`Blob`/문자열로만** 만들 수 있다(`react-native/Libraries/Blob/Blob.js` 의 주석 —
"Currently we only support creating Blobs from other Blobs"). 인메모리로 인코딩한
WAV(`ArrayBuffer`)를 감쌀 방법이 없다는 뜻이다.

그래서 WAV 바이트를 base64 로 인코딩해(`audio/pcm.ts` 의 `bytesToBase64()` — RN 에는
`btoa` 가 없어서 직접 짰다) `data:audio/wav;base64,...` URI 로 만들고, RN 의
`FormData` 에는 표준 파일 자리(`{uri, name, type}`)로 올린다. RN 의 네트워킹 계층이
`data:` URI 를 파일 소스로 직접 읽어준다
(`ReactAndroid/.../RequestBodyUtil.kt` 의 `getFileInputStream` — 안드로이드로 확인했다,
iOS 는 아직 다루지 않는다). **새 네이티브 의존성 없이 되는 방법이라 이것을 골랐다** —
`react-native-blob-util` 같은 라이브러리를 더하지 않아도 된다.

### 화면에서 무엇을 보는가

| | |
|---|---|
| **정책** | `speaker_id.policy`/`threshold`/`auto_enroll`/등록 수. `GET /v1/speakers` 를 받은 뒤에는 그쪽 값(더 최신)을 우선한다 — 등록·삭제 직후 반영되도록. 정책 이름은 서버 값을 그대로 보여준다(앱에 이름을 박지 않는다) |
| **화자 ID** | 참여자 후보가 있으면 칩, 없으면 자유 입력 |
| **이름** | 선택. 비우면 서버가 id 를 쓴다 |
| **클립 녹음** | 토글 버튼. 누르면 시작, 다시 누르면 그 클립을 목록에 추가한다. 클립마다 길이(초)와 삭제 버튼이 있다 |
| **등록** | 클립을 전부 WAV 로 인코딩해 한 번에 올린다. 결과로 등록된 이름/발화 수를 보여주고, **`warning` 이 있으면 그대로** 보여준다(서버가 렌더한 문장 — 유사도가 낮아 다른 사람 목소리가 섞였을 수 있다는 뜻) |
| **등록된 화자** | `GET /v1/speakers` 조회 결과. 각 항목에 삭제 버튼(`DELETE /v1/speakers/{id}`) |

### 실기기에서 볼 것

1. **설정** 탭에서 참여자가 있는 프로필을 고른다(있다면). **화자 등록** 탭에서 그 참여자
   id 가 후보 칩으로 뜨는지 본다
2. **클립 녹음** 을 눌러 몇 마디 말하고 다시 눌러 멈춘다 — 3~5 개쯤 짧은 클립을 모은다
   (많을수록 평균이 안정적이다)
3. **등록** 을 누른다 — 등록된 이름/발화 수가 뜨는지, 클립들이 서로 다른 사람처럼
   들렸다면 `warning` 문장이 뜨는지 본다
4. **등록된 화자** 목록에 방금 등록한 사람이 보이는지, 삭제하면 목록에서 없어지는지 본다
5. **정책이 실제로 갈리는지** — 서버의 `speaker_id.policy` 가 `strict`/`enrolled_first` 면
   **실시간 통역** 탭으로 가서, 등록한 사람이 말하면 통역되고 **다른 사람(또는 TV 소리)이
   말하면 `speaker.rejected` 로 그 세그먼트가 건너뛰어지는지** 확인한다(§8, "건너뜀" 표시)

### 막혔을 때 어디를 보나

| 증상 | 볼 곳 |
|---|---|
| 화자 ID 후보가 하나도 안 뜬다 | 지금 프로필의 `participants` 가 비어 있다는 뜻 — 자유 입력으로 떨어진 것이 맞는지 확인. `설정` 탭에서 프로필을 바꿔본다 |
| 등록을 눌러도 반응이 없다 | 클립이 하나도 없거나 화자 ID 가 비어 있으면 버튼이 잠긴다 — 클립 목록에 `클립 N개` 가 뜨는지 먼저 본다 |
| 등록 요청이 서버 오류로 끝난다 | 문장을 그대로 읽는다. `speaker.enroll_needs_files` 면 클립을 더 모아야 하고(`config/defaults.yaml` 의 `speaker_id.min_enroll_files`), `audio.too_large` 면 클립을 줄여야 한다(`server.max_upload_bytes`) |
| 등록은 됐는데 통역 때 계속 걸러진다 | `min_pairwise_similarity` 경고가 떴었는지 다시 등록해 본다 — 클립에 다른 사람 목소리나 소음이 섞였을 수 있다 |
| 마이크가 안 열린다 | §8 의 "막혔을 때" 표와 같다 — `MicCapture` 를 그대로 쓰므로 원인도 같다 |
