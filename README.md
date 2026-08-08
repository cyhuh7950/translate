# translate — 음성 번역 애플리케이션

STT → LLM → TTS 로 음성을 번역해 다시 음성으로 돌려주는 애플리케이션.
설계 전체는 [DESIGN.md](DESIGN.md) 참고.

## 엔진 레이어와의 관계

```
~/deploy/voice/       STT/TTS/LLM 엔진 (인프라)   ← 여러 앱이 공유 가능
~/deploy/translate/   번역 애플리케이션           ← 그 엔진을 소비하는 앱 하나
```

번역 앱은 엔진의 **HTTP API 만** 호출한다. `voice/` 의 코드를 import 하지 않는다.
두 폴더는 같은 `proxy-network` 에 붙어 컨테이너 이름으로 통신한다.

이 분리 덕분에
- 엔진을 다른 서버로 옮기거나 다른 구현으로 바꿔도 이 앱은 설정만 바뀐다
- 엔진 레이어는 번역 말고 다른 용도(회의록, 자막 등)에도 그대로 쓸 수 있다
- 두 저장소가 각자의 속도로 움직인다

## 구성

| 폴더 | 내용 |
|---|---|
| `orchestrator/` | 공용 기반(core) + 기능 모듈(modules), WebSocket·HTTP API |
| `web/` | 웹 클라이언트 (nginx + 정적 HTML/JS). 마이크 캡처, 결과 표시, 오디오 재생 |
| `config/` | **이 앱의 두뇌.** 엔진 레지스트리, LLM 프로바이더, 세션 프로필, 번역 언어, 기본값 |

### 오케스트레이터 안쪽 — core 와 modules

```
orchestrator/app/
├── core/                공용 기반. 어느 기능에도 종속되지 않는 것만 둔다
│   ├── config.py        설정 로더 / registry.py 구현체 레지스트리 / i18n.py 표시 언어
│   ├── engines.py       원격 엔진 레지스트리 / enginecall.py 선택·어댑터·주소
│   ├── speech.py        오디오↔텍스트, 화자 식별 — 흐름에 종속되지 않는 단계
│   ├── llm.py           프로바이더 레지스트리와 번역기
│   ├── sessions.py      세션 프로필과 참여자 모델 / voiceprints.py 음성 등록
│   ├── moduleapi.py     모듈 계약 (ModuleContext / @module)
│   └── adapters/        교체 가능한 구현체 (파일 하나 넣으면 자동 등록)
├── modules/
│   └── translate/       음성 번역 — pipeline.py 흐름, streaming.py WS, routes.py 입구
└── server.py            조립만 한다 (/health, /v1/config, /v1/speakers/*, /v1/admin/*)
```

**기능 하나 = 폴더 하나다.** `app/modules/` 아래 폴더를 넣으면 붙고 빼면 떨어진다 —
목록은 코드 어디에도 없다. 모듈은 `core` 만 알기 때문에 폴더째 다른 프로젝트로
옮겨 붙일 수 있다. 계약(라우트 / `/v1/config` 기여 / 수명주기 훅 / `ModuleContext`)은
[`orchestrator/app/core/moduleapi.py`](orchestrator/app/core/moduleapi.py) 상단 주석에 있다.

설정도 같은 경계를 따른다. **모듈은 자기 이름의 최상위 섹션 하나를 갖고,
다른 모듈의 섹션을 읽지 않는다.** 공용 섹션(`server`, `auth`, `session`, `audio`,
`engines`, `speaker_id`, `vad`, `turn`, `llm` …)은 core 의 것이고 누구나 읽어도 된다.

| | 라우트 |
|---|---|
| core | `/health`, `/v1/config`, `/v1/models`, `/v1/speakers/*`, `/v1/admin/*` |
| translate 모듈 | `/v1/translate/*`, WebSocket(`stream.path`) |

음성 등록(`/v1/speakers/*`)이 core 인 것은 어느 모듈이든 화자를 알아야 할 수 있어서다.

## 설계 원칙 (요약)

> **아무것도 소스에 고정하지 않는다.**

- 소스에는 "어떻게 하는가"의 구현만. 이름·주소·포트·개수·임계값·목록·순서·**기본값**은 전부 `config/`
- `os.getenv("PORT", "8101")` 같은 코드 폴백을 쓰지 않는다. 기본값은 `config/defaults.yaml` 에 둔다
- 구현체 선택을 `if/elif` 로 하지 않는다. 레지스트리에 등록하고 설정이 이름으로 고른다
- 엔진에 닿는 방법(프록시·서브도메인·직접 포트·사설망)을 시스템이 가정하지 않는다. 전부 URL 문자열
- 새 엔진·프로바이더·구현체 추가 시 **기존 파일을 열면 설계가 실패한 것**

전체 체크리스트는 DESIGN.md 6장 "설정 가능 항목".

## 개발 단계

설계는 최종 목표(실시간 양방향)에 맞춰 이미 끝났고, 개발만 둘로 나눈다.

| 단계 | 범위 | 필요 환경 |
|---|---|---|
| **1단계** | 단방향, 배치/PTT. 오케스트레이터 골격 → 배치 파이프라인 → LLM 프로바이더 → 웹 PTT → WebSocket+VAD | 오라클 CPU 엔진으로 가능 |
| **2단계** | 실시간 + 양방향. 스트리밍 STT/TTS → 실시간 모드 → 양방향 → 다중 기기 → 앱 | GPU 서버 필요 |

**1단계는 기능을 줄이는 것이지 구조를 줄이는 것이 아니다.**
참여자 모델·`from`/`to` 프로토콜·세그먼트 파이프라인은 1단계부터 들어간다.
지켜야 할 불변식 목록은 DESIGN.md 13장.

## 상태

**1단계 ①~④ 완료.** 오케스트레이터 골격, 배치 파이프라인, LLM 프로바이더 9종,
웹 클라이언트(PTT)가 동작한다. WebSocket·VAD(⑤)는 다음 단계.

```bash
./translatectl.sh start orchestrator web
./translatectl.sh config          # 엔진 가용성, 프로필, 프로바이더 확인
```

웹 클라이언트는 `http://<호스트>:8402`. 화면의 선택지(언어·프로필·엔진·프로바이더·스타일·보이스)는
전부 `GET /v1/config` 응답으로 그려지므로, 설정을 고치면 새로고침만으로 반영된다.

> 브라우저 마이크는 **보안 컨텍스트(HTTPS 또는 localhost)에서만** 열린다.
> 다른 기기에서 쓰려면 NPM 으로 HTTPS 를 붙일 것. 파일 업로드는 HTTP 에서도 된다.
