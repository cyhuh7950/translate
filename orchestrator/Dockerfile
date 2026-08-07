# 번역 오케스트레이터
#
# 추론 라이브러리가 없어 순수 파이썬이다. 아키텍처를 가리지 않으므로
# 개발용 ARM64 오라클에서도, 운영용 x86_64 에서도 같은 정의로 빌드된다.
#
# 빌드 컨텍스트는 상위 폴더다:  docker build -f orchestrator/Dockerfile ..
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONPATH=/app \
    TRANSLATE_CONFIG_DIR=/config

# ffmpeg: 업로드 오디오 디코딩과 세그먼트 처리에 쓴다. curl 은 헬스체크용.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl \
 && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app
COPY orchestrator/requirements.txt ./requirements.txt
RUN pip install --upgrade pip wheel setuptools \
 && pip install -r requirements.txt

COPY orchestrator/app ./app

# 설정은 이미지에 굽지 않는다. 볼륨으로 주입해 재빌드 없이 바뀌게 한다.
VOLUME ["/config"]

EXPOSE 8401
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS "http://localhost:8401/health" || exit 1

CMD ["python", "-m", "app.server"]
