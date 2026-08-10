# app — 모바일 앱

최종 산출물인 모바일 앱이다. 프레임워크는 **React Native** 로 정했다 (`../APP.md`).
개발은 **Windows PC + Android** 로 시작한다. iOS 는 Mac 이 있어야 하므로 뒤로 미룬다.

지금 이 폴더에 들어 있는 것은 앱 껍데기가 아니라 **`src/api/` — 서버와 말을 주고받는
계층 하나**다. 왜 그것만 있는지, 그리고 다음에 무엇을 하면 되는지가 이 문서다.

---

## 1. 지금 무엇이 있나

```
app/
  src/api/
    types.ts        서버 응답·WS 이벤트 타입 (서버 소스를 읽고 맞춘 것)
    http.ts         fetch 주입, URL 조립, 오류 봉투 → 예외
    config.ts       GET /v1/config
    stream.ts       WS 스트리밍 프로토콜 (바이너리 짝짓기 포함)
    translate.ts    POST /v1/translate/{text,audio}
    index.ts        입구 — 앱은 이것만 import 한다
  test/
    smoke.ts        실제 서버에 대고 도는 검증
```

**아직 없는 것**: RN 프로젝트, 화면, 오디오 캡처·재생, 온디바이스 ONNX.
그것들은 실기기가 있어야 확인되므로 로컬 PC 에서 시작한다 (§5).

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

규칙은 컴파일러가 지킨다. `tsconfig.json` 이 `lib: ES2020` + `types: []` 이라
`window`·`document`·`Buffer`·`process` 를 쓰는 순간 타입 체크가 깨진다.
(테스트는 Node API 를 쓰므로 `tsconfig.test.json` 이 따로 본다.)

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

## 3. 서버는 옮기지 않는다

앱은 이미 열려 있는 **`translate.sinsan.kr` 을 부르는 클라이언트**일 뿐이다.
STT·LLM·TTS·VAD·화자 식별·오류 문구가 전부 서버에 있고, 앱은 마이크와 스피커,
그리고 화면을 담당한다. 앱 작업 때문에 서버를 고칠 일은 없어야 한다 —
프로토콜이 바뀌어야 한다면 그때는 서버와 이 폴더를 **한 커밋에서** 함께 고친다.
(`app/` 이 `orchestrator/`·`web/` 과 나란히 있는 이유다.)

---

## 4. 검증하기 (Node — 실기기 없이)

Node 22 이상이면 된다. 서버 주소는 환경변수로 준다.

```bash
cd app
npm install
npm run typecheck        # src/api 만 — 환경 의존이 없는지까지 함께 본다
npm run typecheck:test   # 테스트까지

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
WS 오류 이벤트.

---

## 5. 로컬 PC 에서 시작하기 (Windows + Android)

### 필요한 것

| | |
|---|---|
| **Node LTS** (22 이상) | https://nodejs.org — `node -v` 로 확인 |
| **JDK 17** | Android Studio 가 함께 설치해준다 (Temurin 17 도 됨) |
| **Android Studio** | SDK Platform 35 + Platform-Tools + Build-Tools |
| **실기기 또는 에뮬레이터** | **실기기를 권한다** — 마이크·에코·지연이 이 앱의 전부인데 에뮬레이터에서는 그게 실제와 다르다 |
| **Git** | |

환경변수 `ANDROID_HOME` 을 SDK 경로로 잡고 `platform-tools` 를 PATH 에 넣는다.
`adb devices` 에 기기가 보이면 준비가 된 것이다.

### 어디서 시작하나

```bash
git clone <이 저장소> translate
cd translate/app
npm install
npm run typecheck
```

여기까지가 지금 있는 것이다. 이어서 RN 프로젝트를 이 폴더 안에 만들고
(`npx @react-native-community/cli init` 등) `src/api/` 를 **그대로** 쓴다.
이 계층은 이미 서버에 대고 검증돼 있으므로 손대지 않아도 된다.
서버가 살아 있는지는 브라우저로 https://translate.sinsan.kr 을 열어보면 바로 안다 —
웹 클라이언트가 앱이 할 일을 이미 전부 하고 있다. 막히면 `web/static/app.js` 를 보면 된다.

---

## 6. 다음 할 일 — `APP.md` §7 의 스파이크 세 가지

프레임워크 결정을 확정하는 실험이다. **가장 위험한 것부터** 찌른다.

1. **원시 PCM 캡처** — 16kHz mono PCM16 20ms 프레임이 실제로 나오는가.
   `web/static/capture-worklet.js` 와 같은 결과가 나오는지 파형으로 확인한다
2. **WS 왕복** — 그 프레임을 `session.sendAudio()` 로 그대로 흘려보내고
   `stt.final`/`llm.final`/`tts.chunk` 가 돌아오는가.
   **이미 Node 로는 통과했다** (§4). 남은 것은 "기기에서 나온 진짜 마이크 프레임"이다
3. **ONNX 로드** — `onnxruntime-react-native` 로 Supertonic 모델을 실기기에 올려
   추론이 도는가. 여기서 막히면 온디바이스 요구가 흔들리므로 가장 먼저 볼 가치가 있다

셋 다 되면 React Native 확정이다. 3번이 막히면 네이티브 Kotlin 으로 다시 본다.

---

## 7. 알아두면 좋은 프로토콜 사실

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
