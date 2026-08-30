# 작업 로그

세션이 끊겨도 어디까지 했는지 알 수 있도록 남기는 기록. 최신 항목이 위.

## 2026-08-30 (4)
- 학습 설정 화면(`ui/LangLearnSettingsScreen.tsx`) 구현 — PLAN_LANG_LEARN.md 앱 작업 2번.
  스케줄(추가/삭제)·학습 언어·난이도(adaptive/manual)·feedback_mode·show_text_for_repeat를
  `GET/PUT /v1/users/{id}/lang_learn/settings`로 조회·저장. 학습 언어/난이도 목록은
  `/v1/config`에서 온다(하드코딩 없음). 저장에 성공하면 `notifications.ts`의
  `scheduleLangLearnNotifications`로 기기 알림을 다시 예약.
- `src/api/langlearn.ts`에 `putLangLearnSettings` 추가.
- 알림 탭 → 학습 세션 진입 배선(PLAN 앱 작업 3번 마지막 조각) — `App.tsx`에
  `onLangLearnNotificationPress(() => setTab('learn'))`를 걸어, 콜드 스타트/포그라운드
  알림 탭 모두 학습 세션 탭으로 이동하게 함. 새 탭 "학습 설정"도 추가(로그인/설정/세션 사이).
- `__tests__/learn-settings.test.tsx` 추가(PUT 바디·notifee 재예약 호출 검증). `npm run
  verify` 전체 통과(11개 스위트, 79개 테스트).
- 실기기+실서버 종단 확인: `learntest` 계정으로 스케줄 07:30/3문제 저장 →
  `GET .../lang_learn/settings`로 서버 반영 확인 → 앱 재시작 후 그 값이 그대로
  다시 로드되는 것 확인 → POST_NOTIFICATIONS 권한 승인 → `lang_learn` 알림 채널
  생성까지 확인(`dumpsys notification`). **주의**: 실제 OS `AlarmManager`에 알람이
  등록됐는지는 `dumpsys alarm`으로 이 기기(Samsung One UI)에서 끝내 확인하지
  못했다 — 채널 생성·권한 승인·JS 쪽 성공 콜백까지는 다 맞고 단위 테스트도 notifee
  API 호출 자체(파라미터 포함)를 검증하지만, 07:30에 실제로 알림이 뜨는지는
  아직 실측하지 못한 상태. 다음에 시간 여유가 있으면 그 시각까지 기다려서 확인할 것.
- 다음: 위 알림 실측 확인 외에 남은 항목 없음 — DESIGN.md §15 1단계(로그인·설정·
  세션·로컬알림) 앱쪽 구현이 전부 끝났다.

## 2026-08-30 (3)
- 학습 세션(문제 풀이) 화면(`ui/LearnScreen.tsx`) 구현 — PLAN_LANG_LEARN.md 앱 작업 4번.
  `src/api/langlearn.ts`(WS 클라이언트, `getLangLearnSettings`), `audio/pcm.ts`의
  `encodeWav`(음성 답변을 WAV로 감싸 한 번에 전송)를 새로 추가. WS 경로·기본 문제 수는
  `/v1/config`의 `lang_learn` 섹션에서 읽는다(하드코딩 없음).
- `__tests__/learn.test.tsx` 추가 — start/ready/problem/answer/feedback/summary/done
  왕복을 가짜 소켓으로 검증. `npm run verify` 전체(번들·typecheck·lint·test) 통과.
- 실기기 + 실서버(`translate.sinsan.kr`)로 종단 검증 완료: 로그인(`learntest` 계정 신규
  등록) → 학습 세션 시작 → LLM이 생성한 문제 수신 → 텍스트 답변 제출 → 실제 LLM 채점
  피드백·총평 수신 → session.done까지 전부 정상 확인.
- 다음: 학습 설정 화면(PLAN 앱 작업 2번, 스케줄/난이도/피드백모드 편집)과 알림→세션
  진입 연결(`notifications.ts`의 `onLangLearnNotificationPress`가 아직 어디에도
  안 걸려 있음)이 남음.

## 2026-08-30 (2)
- 앱 런처 아이콘을 기본 RN 로봇 아이콘에서 자체 디자인(파란 배경 + 흰 말풍선 + 음성 파형)으로 교체.
  imagemagick/sharp가 없는 환경이라 `scripts/gen-icon.py`(Pillow)로 직접 그려서 밀도별 PNG 생성.
- 실기기(SM-N981N, Android 13) USB 연결 → `gradlew.bat installDebug`로 설치 → Metro 기동 후 정상 구동 확인(홈 화면 앱 서랍에서 새 아이콘 확인).
  주의: git bash에서 `npx react-native run-android`를 돌리면 `gradlew.bat`을 못 찾는 문제가 있었음 — PowerShell에서 `gradlew.bat`을 직접 실행해서 우회함.
- 다음: 없음.

## 2026-08-30
- 학습 로그인(`ui/LoginScreen.tsx`) + 통역모드 화면(`ui/FaceToFaceScreen.tsx`) + 로컬 알림(`notifications.ts`, notifee 기반)을 `App.tsx`에 통합.
  최상단에 번역모드/통역모드 전환 추가, 로그인은 하단 탭 중 하나로 추가.
- 관련 테스트(`__tests__/login.test.tsx`, `__tests__/facetoface.test.tsx`, `__tests__/notifications.test.ts`, `__tests__/screens.test.tsx`) 전부 통과 확인 후 커밋.
- `app/app.config.json`의 `serverUrl`은 로컬 테스트용 실제 주소로 바뀌어 있었음 — 커밋 원칙(빈 값으로 유지)에 따라 **커밋하지 않고 워킹트리에만 남겨둠**. 실기기 테스트 시 필요하면 로컬에서 채워 쓸 것.
- 다음: 없음 (이번 배치 작업은 여기까지). 새 작업 시작 시 이 파일 위에 새 항목 추가.
