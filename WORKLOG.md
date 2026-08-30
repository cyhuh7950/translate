# 작업 로그

세션이 끊겨도 어디까지 했는지 알 수 있도록 남기는 기록. 최신 항목이 위.

## 2026-08-30
- 학습 로그인(`ui/LoginScreen.tsx`) + 통역모드 화면(`ui/FaceToFaceScreen.tsx`) + 로컬 알림(`notifications.ts`, notifee 기반)을 `App.tsx`에 통합.
  최상단에 번역모드/통역모드 전환 추가, 로그인은 하단 탭 중 하나로 추가.
- 관련 테스트(`__tests__/login.test.tsx`, `__tests__/facetoface.test.tsx`, `__tests__/notifications.test.ts`, `__tests__/screens.test.tsx`) 전부 통과 확인 후 커밋.
- `app/app.config.json`의 `serverUrl`은 로컬 테스트용 실제 주소로 바뀌어 있었음 — 커밋 원칙(빈 값으로 유지)에 따라 **커밋하지 않고 워킹트리에만 남겨둠**. 실기기 테스트 시 필요하면 로컬에서 채워 쓸 것.
- 다음: 없음 (이번 배치 작업은 여기까지). 새 작업 시작 시 이 파일 위에 새 항목 추가.
