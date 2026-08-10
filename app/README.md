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
  App.tsx             연결 확인 화면 — 스파이크 (§7)
  app.json            RN 앱 이름 (RN 이 만든 것, 건드리지 않는다)
  app.config.json     서버 주소 · API 키 · 로케일 — 빈 값으로 커밋돼 있다 (§7)

  android/            Android 네이티브 프로젝트  ← 지금 빌드하는 것
  ios/                iOS 네이티브 프로젝트     ← Mac 이 생기면 쓴다. 지금은 손대지 않는다

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

**아직 없는 것**: 오디오 캡처·재생, WebSocket 화면, 온디바이스 ONNX, 네비게이션.
그것들은 실기기가 있어야 확인되므로 로컬 PC 에서 시작한다 (§6).

**첫 빌드는 의도적으로 순수 RN 이다.** `onnxruntime-react-native` 는 네이티브 빌드를
바꾸는 의존성이라, 지금 넣으면 첫 빌드가 깨질 때 "RN 자체가 안 되는 건지 ONNX 때문인지"
구분할 수 없다. 순수 RN + `src/api` 로 한 번 성공시킨 다음 ONNX 를 **하나만** 더한다 (§8).

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
npm run typecheck        # 세 설정을 모두 (§3) — 하나만 돌리면 이식성 보장이 새어나간다
npm run lint
npm test                 # jest — 지금은 App.tsx 가 렌더되는지만 본다

TRANSLATE_BASE_URL=https://translate.sinsan.kr \
TRANSLATE_AUDIO=/path/to/16k-mono.wav \
npm run smoke
```

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

기기가 이 PC 의 Metro 를 못 찾으면 `adb reverse tcp:8081 tcp:8081` 를 한 번 준다.

서버가 살아 있는지는 브라우저로 https://translate.sinsan.kr 을 열어보면 바로 안다 —
웹 클라이언트가 앱이 할 일을 이미 전부 하고 있다. 막히면 `web/static/app.js` 를 보면 된다.

---

## 7. `App.tsx` — 연결 확인 화면 (스파이크)

지금 앱을 띄우면 나오는 화면이다. 하는 일이 적은 것이 의도다. **이 화면이 확인하는 것은
딱 하나 — 실기기에서 `RN → src/api → 서버` 경로가 사는가.**

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

**오디오·WebSocket·ONNX 는 여기 없다.** 위험을 하나씩 더하는 순서를 지키는 것이고,
그 셋이 §8 이다. 화면 문구는 한국어를 그대로 썼다 — 스파이크라 i18n 대상이 아니다.

---

## 8. 다음 할 일 — `APP.md` §7 의 스파이크 세 가지

프레임워크 결정을 확정하는 실험이다. **가장 위험한 것부터** 찌른다.

1. **원시 PCM 캡처** — 16kHz mono PCM16 20ms 프레임이 실제로 나오는가.
   `web/static/capture-worklet.js` 와 같은 결과가 나오는지 파형으로 확인한다
2. **WS 왕복** — 그 프레임을 `session.sendAudio()` 로 그대로 흘려보내고
   `stt.final`/`llm.final`/`tts.chunk` 가 돌아오는가.
   **이미 Node 로는 통과했다** (§5). 남은 것은 "기기에서 나온 진짜 마이크 프레임"이다
3. **ONNX 로드** — `onnxruntime-react-native` 로 Supertonic 모델을 실기기에 올려
   추론이 도는가. 여기서 막히면 온디바이스 요구가 흔들리므로 가장 먼저 볼 가치가 있다.
   **의존성은 이것 하나만 따로 추가한다** — 순수 RN 빌드가 성공한 것을 확인한 뒤에

셋 다 되면 React Native 확정이다. 3번이 막히면 네이티브 Kotlin 으로 다시 본다.

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
