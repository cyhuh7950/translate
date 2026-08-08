"""
공용 기반 — 기능 모듈들이 함께 쓰는 것들만 여기 둔다.

여기 있는 것의 기준은 하나다: **어느 기능에도 종속되지 않는가.**
번역이 사라져도 남아야 하는 것이면 core 이고, 번역이 사라지면 같이 사라질 것이면
`app/modules/translate/` 다.

    config      설정 로더 (기본값을 소스에 두지 않기 위한 장치)
    registry    구현체 레지스트리 (@register / discover)
    i18n        표시 언어 처리
    audio       PCM ↔ WAV 컨테이너 도구
    engines     원격 엔진 레지스트리와 가용성 관측
    enginecall  엔진 선택 · 어댑터 생성 · 엔드포인트 해석
    speech      오디오↔텍스트·화자식별 (흐름에 종속되지 않는 단계들)
    llm         LLM 프로바이더 레지스트리와 번역기
    preprocess  입력 오디오 전처리 (배경 음성 게이트)
    sessions    세션 프로필과 참여자 모델
    voiceprints 화자 등록 저장소와 임베딩 엔진 호출부
    diagnostics 세그먼트 덤프
    moduleapi   모듈 계약 (ModuleContext / @module)
    adapters/   교체 가능한 구현체들 (파일 하나 넣으면 자동 등록)
"""
