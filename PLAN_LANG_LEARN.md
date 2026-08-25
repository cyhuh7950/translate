# 작업 계획 — 사용자 모델 + 언어 학습 (1단계)

설계는 `DESIGN.md` §15 를 따른다. 여기서는 그걸 서버쪽/앱쪽 작업 단위로 쪼갠다.
**테넌트는 이번 1단계에 포함하지 않는다** — 지금 배포 전체가 암묵적 테넌트 1개다.

담당: 서버 = 이 세션, 앱 = `translate-54`("번역 앱 작업", `D:\Project\translate`).

---

## 서버 작업 (`orchestrator/`)

### 순서

1. **사용자 모델 (`core.users`, 가칭)**
   - 사용자 = `{id, name, pin_hash, created_at}`. 이름/별칭 + PIN, 계정 가입 아님
   - 저장소: 사용자 한 명 기준이 아니라 **여러 명 기준**으로 새로 잡는다 (기존 "단일 사용자
     저장소" 가정 폐기 — DESIGN.md §15)
   - `POST /v1/users` — 사용자 등록 (이름 + PIN)
   - `POST /v1/users/login` — 이름 + PIN → 짧은 세션 토큰 (또는 매 요청에 `user_id`+PIN,
     구현 시점에 택일)
   - 기존 API 키는 그대로 서버 전체 접근 키로 유지. 그 위에 `user_id` 만 추가로 싣는다

2. **기존 기능을 사용자에 연결**
   - 화자 등록(voice print) — 지금은 서버 전체에 하나로 쌓이는지 확인하고, `user_id` 로
     나눠 저장하도록 변경
   - STT 개인화용 음성 샘플 축적 — 신규. `user_id` 별로 일부 발화를 저장해뒀다가 주기적으로
     재학습에 쓸 수 있게 저장 구조만 먼저 만든다 (재학습 파이프라인 자체는 이번 범위 밖,
     저장까지만)
   - 번역 세션 참여 이력에 `user_id` 를 붙일지는 열린 질문 — 굳이 안 붙여도 1단계 목표에는
     영향 없음. 시간 되면 붙이고 아니면 다음으로 미룬다

3. **`modules/lang_learn` 신규 모듈**
   - `core.speech`·`core.llm`·`core.sessions`·`core.users` 만 참조 (§1 경계)
   - 설정 스키마 (사용자별, DESIGN.md §15 그대로):
     ```yaml
     lang_learn:
       schedule: [{time: "08:00", count: 3}, {time: "20:00", count: 5}]
       target_lang: "en"
       level_mode: "adaptive"       # adaptive | manual
       manual_level: null
       feedback_mode: "both"        # immediate | summary | both
       show_text_for_repeat: false
     ```
   - `GET/PUT /v1/users/{id}/lang_learn/settings` — 학습 설정 조회/저장
   - 신규 WS 엔드포인트 (`/v1/stream` 과 별개) — 문제 생성(LLM, `answer_type`: repeat/compose)
     → 답변 수신(음성이면 STT) → LLM 평가(내부 점수 0~100 → 등급 변환) → feedback_mode 따라
     즉시/총평 전송 → 이력 저장
   - 프로토콜 이벤트: `problem` / `answer.received` / `feedback` / `session.summary` / `session.done`
     (DESIGN.md §15 예시 그대로)
   - 적응형 난이도: 최근 세션 내부 점수를 다음 세션 프롬프트의 난이도 힌트로 반영

4. **검증**
   - 사용자 두 명 이상 만들어서 화자등록/학습 이력이 서로 섞이지 않는지 확인
   - `npm run smoke` 상당의 서버쪽 스모크 테스트에 학습 세션 왕복 시나리오 추가
   - 기존 번역 기능(화자등록 포함)이 사용자 모델 도입 후에도 그대로 동작하는지 회귀 확인

### 앱에 알려줘야 할 것 (서버가 확정하는 즉시 공유)

- `POST /v1/users`, `POST /v1/users/login` 요청/응답 스펙
- `lang_learn` 설정 스키마와 학습 WS 프로토콜 이벤트 목록
- 화자 등록·번역 기존 API 에 `user_id` 가 추가되는지 여부 (추가되면 그 시점에 앱도 같이 고쳐야 함)

---

## 앱 작업 (`app/`, 담당: `translate-54`)

### 순서

1. **로그인 화면 (이름 + PIN)**
   - 계정 가입 아님 — 서버가 준 `POST /v1/users`/`login` 에 맞춰 가볍게
   - 로그인 상태를 기기에 저장 (`storage.ts` 확장) — 앱을 껐다 켜도 재로그인 불필요

2. **학습 설정 화면**
   - 스케줄(시각·문제 수, 리스트 — 하루 여러 세트), 학습 언어, 난이도(`level_mode`
     adaptive/manual + manual 선택 시 등급), `feedback_mode`, `show_text_for_repeat`
   - §10 규칙과 동일 — 목록·기본값을 하드코딩하지 않고 서버 설정 응답 기반으로 그린다

3. **기기 로컬 알림 스케줄링**
   - 서버 FCM 푸시 없음 — 앱이 스스로 예약 (DESIGN.md §15 결정 사항)
   - 학습 설정이 바뀌면 기존 예약 취소하고 재예약
   - 알림 탭 → 학습 세션 화면으로 진입

4. **학습 세션 화면**
   - `problem` 이벤트 렌더링 — `answer_type` 이 `repeat` 이면 TTS 재생(+ `show_text_for_repeat`
     설정에 따라 텍스트 동시 표시), `compose` 면 텍스트로 뜻/상황 표시
   - 답변 캡처 — 음성(마이크, 기존 `audio/capture.ts` 재사용) 또는 텍스트 입력
     (`answer_type` 에 따라 UI 분기)
   - `feedback` 이벤트를 문제마다 표시(즉시 모드), `session.summary` 를 세션 끝에 표시
   - 등급(상/중/하)만 표시 — 내부 점수는 서버만 가지고 있음

5. **검증**
   - 실기기에서 알림 → 학습 세션 진입 → 문제 여러 개(두 타입 섞어서) → 피드백까지
     한 바퀴 도는지 확인
   - `npm run verify` 통과 확인 후 서버에 완료 보고

### 서버에 확인해야 할 것

- 로그인 응답 형태(토큰 발급 여부), 학습 WS 엔드포인트 경로, 프로토콜 이벤트 정확한 필드
- 화자 등록/번역 API 에 `user_id` 가 언제 추가되는지 (추가되기 전까지는 기존 방식대로 동작)

---

## 진행 순서 제안

서버가 1(사용자 모델)·2(기존 기능 연결)를 먼저 끝내고 API 스펙을 앱에 공유 →
앱은 그 사이 1(로그인 화면)·3(로컬 알림)을 먼저 만들어두고, 서버 3(`lang_learn` 모듈)이
끝나면 4(학습 세션 화면)를 붙인다. 완전히 순차적일 필요는 없고, 스펙만 먼저 확정되면
병렬로 진행 가능하다.
