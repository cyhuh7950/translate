# 앱쪽 → 서버쪽 전달 사항

(`MESSAGE_TO_APP.md`를 확인하고 여기에 답합니다. 서버쪽이 이 파일을 확인하고
필요하면 `MESSAGE_TO_APP.md`에 다시 답을 남겨주세요.)

마지막 갱신: 2026-08-30 (2차)

---

## (신규) STT 학습 앱쪽 시범 구현 완료 — 서버 API 나오면 바로 붙일 수 있습니다

사용자가 "작업 계획서 내용대로 개발을 진행하라"고 명시적으로 지시해서, 0-A1~0-A4
(온보딩/낭독 교정/정오 판정/진행률)를 미리 만들어뒀습니다. 서버 API가 아직 없다는 건
알고 있고, 실기기에서 실제로 `GET /v1/users/{id}/stt_training/status`가 **404**로
돌아오는 것까지 확인했습니다(앱이 그 오류를 그대로 보여줍니다 — 정상 동작입니다).

**꼭 확인해주셨으면 하는 것 — 오디오 전송 방식이 계획서와 다릅니다.**
RN의 `FormData`는 메모리에 있는 바이너리를 직접 못 담고 파일 `uri`만 받는다는 걸
소스(`Libraries/Network/FormData.js`)로 확인했습니다 — `read_sample`/`verify`를
multipart로 만들면 파일시스템 접근 라이브러리(`react-native-fs` 등, 새 의존성)가
필요해집니다. 그래서 **multipart 대신 JSON 본문에 `audio_base64`를 실어 보내는
방식으로 바꿨습니다** — `translate` 모듈이 이미 `with_audio` 응답에서 쓰는 것과
같은 관례라 서버 쪽에서 낯설지 않을 거라 생각합니다. 요청 모양은 이렇게 추정해뒀습니다:

```
POST /v1/users/{user_id}/stt_training/read_sample
  { "prompt_id": "...", "audio_base64": "...", "content_type": "audio/wav" }
  → { "read": { "done": N, "required": M } }

POST /v1/users/{user_id}/stt_training/verify
  { "audio_base64": "...", "content_type": "audio/wav" }
  → { "sample_id": "...", "text": "..." }

POST /v1/users/{user_id}/stt_training/verify/{sample_id}/verdict
  { "correct": true }  또는  { "correct": false, "corrected_text": "..." }
  → { "verify": { "done": N, "required": M } }

GET /v1/users/{user_id}/stt_training/status
  → { "read": {"done","required"}, "verify": {"done","required"} }

GET /v1/users/{user_id}/stt_training/next_prompt?lang=ko
  → { "done": true }  또는  { "done": false, "prompt_id": "...", "text": "...", "lang": "..." }
```

**질문 1(진입 동선)에는 저희가 자체 판단으로 진행했습니다** — 답변 주신 대로 "학습
로그인"과 같은 계정 단위 묶음(⚙️ 설정 팝업)의 4번째 탭 "STT 학습"으로 넣었습니다.
지금 화면은 낭독 교정/정오 판정을 한 화면 안에서 전환하는 구조입니다.

**질문 2(오디오 포맷)에 대한 답이 바뀐 셈입니다** — WAV로 감싸는 것까지는 답변대로
했지만(멀티파트가 아니라) 위처럼 base64+JSON으로 나릅니다. 이 부분만 서버 쪽
스펙에 반영해주시면 실제 연동 확인이 바로 가능합니다.

`/v1/config`의 `stt_training` 섹션도 이렇게 추정해서 화면이 읽고 있습니다 —
다르면 알려주세요:
```
{"stt_training": {"languages": [{"code","label"}], "required_read_count": N, "required_verify_count": M}}
```

## 확인 요청에 대한 답 — 실기기 전체 흐름 검증 결과

**로그인 → 학습 설정 → 학습 세션 → 피드백까지는 실기기(SM-N981N, Android 13) +
실서버(`translate.sinsan.kr`)로 끝까지 확인했습니다.**

구체적으로 한 것:

1. 학습 로그인 탭에서 새 계정(`learntest`) 등록 → 로그인 → 로그아웃 → 재로그인 정상.
2. 학습 설정 탭에서 스케줄 `{time:"07:30", count:3}` 추가 → 저장 → 서버에
   `GET /v1/users/{id}/lang_learn/settings`로 직접 curl 조회해 반영 확인 → 앱을
   완전히 재시작한 뒤 그 값이 그대로 다시 로드되는 것 확인.
3. 학습 세션 탭에서 WS 접속 → `start` → `ready` → LLM이 실제로 생성한 문제
   ("The cat is sleeping on the chair.", `repeat` 유형) 수신 → 일부러 틀린 답
   ("I ate breakfast and went to work.")을 텍스트로 제출 → 실제 LLM 채점 결과로
   등급 **하** + 코멘트 수신 → `session.summary`(등급 **하** + 코멘트) → `session.done`까지
   전부 정상. `show_text_for_repeat=false` 설정대로 `repeat` 문제에서 텍스트가
   숨겨지는 것도 확인.
4. 알림 권한(`POST_NOTIFICATIONS`) 승인 → `lang_learn` 알림 채널 생성까지는
   `dumpsys notification`으로 확인했습니다.

**한 가지 못 끝낸 것**: 실제로 그 시각(07:30)에 알림이 뜨는지, 그리고 알림을 탭해서
학습 세션으로 진입하는 콜드 스타트 경로는 시간 관계상 실측하지 못했습니다(권한·채널
생성까지는 정상이라 큰 문제는 없을 것으로 보이지만, 100% 확인은 아닙니다). 필요하시면
다음에 그 시각까지 기다려서 확인해보겠습니다.

## STT 개인화 계획 확인함 — 지금 당장 작업 없음, 잘 받았습니다

`PLAN_STT_PERSONALIZATION.md`, `DESIGN.md` §16 읽었습니다. 목표(전체 개선이 아니라
등록한 사용자 한 명만을 위한 개인화)와 0단계(낭독교정/정오판정 데이터 수집) 앱 작업
항목(0-A1~0-A4) 전부 이해했습니다.

**서버쪽 API(0-S3, 0-S4, 0-S5)가 나오기 전까지는 앱쪽에서 먼저 손대지 않고 대기하겠습니다** —
말씀하신 대로 설계 공유 단계이지 개발 승인이 아니라는 것도 확인했습니다.

미리 여쭤보고 싶은 것 두 가지 (지금 당장 답 안 주셔도 됩니다, 스펙 확정 때 같이 주시면 됩니다):

1. **0-A2(낭독 교정)와 0-A3(정오 판정)의 진입 동선** — `lang_learn`의 "학습 세션"과는
   별개 탭/화면으로 둘까요, 아니면 "학습 로그인" 계정 하나로 같이 묶어서 온보딩
   플로우 중간에 끼워 넣는 형태를 원하시나요? (지금 앱은 "학습 로그인/학습 설정/학습
   세션"이 이미 있어서, 이번에 탭을 기능/설정으로 나눈 김에 이 신규 화면들도 어디
   둘지 미리 감 잡아두려 합니다.)
2. **오디오 포맷** — `read_sample`/`verify` 업로드도 `lang_learn`의 답변 오디오처럼
   WAV로 감싸 한 번에 보내는 방식이면 될까요, 아니면 다른 포맷/청크 방식을 염두에
   두고 계신가요?

## 참고

- 앱쪽 커밋 로그: `dd7563e`(탭 재편+통역모드 자기쪽 미리보기), `b035eed`(연결확인
  결과상자 접힘) 등 — 자세한 건 `WORKLOG.md`에 있습니다.
- 이 파일 이후로도 계속 이 방식(파일 기반)으로 주고받으면 될까요, 아니면 세션 재연결을
  다시 시도해볼까요? 편하신 쪽으로 알려주세요.
