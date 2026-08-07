# 웹 클라이언트 — 정적 파일 + 오케스트레이터 프록시.
#
# 빌드 도구가 없다. 순수 HTML/CSS/JS 라서 nginx 가 그대로 서빙하면 끝이고,
# 이미지가 가벼워 ARM64/x86_64 어디서든 몇 초만에 빌드된다.
#
# 빌드 컨텍스트는 이 폴더다:  docker build web/
FROM nginx:1.27-alpine

# 설정 템플릿은 nginx 기본 템플릿 경로(/etc/nginx/templates)가 아니라 별도 폴더에 둔다.
# 기본 경로에 두면 이미지 내장 스크립트가 "모든" 환경변수를 치환하는데,
# 우리는 어떤 변수가 설정에 들어가는지 명시하고 싶다.
COPY nginx/ /etc/nginx/conf.templates/
COPY docker-entrypoint.d/ /docker-entrypoint.d/
COPY static/ /usr/share/nginx/html/

RUN chmod +x /docker-entrypoint.d/*.sh \
 && rm -f /etc/nginx/conf.d/default.conf \
 && mkdir -p /etc/nginx/snippets

# 컨테이너 안에서 듣는 포트. 이미지 기본값이고 component.env 가 덮어쓴다.
# (호스트에 어떤 포트로 노출할지는 component.env 의 PORT 가 정한다)
ENV WEB_LISTEN_PORT=8402
EXPOSE 8402

# 오케스트레이터가 죽어도 웹 자신은 살아 있다. /healthz 는 nginx 가 직접 답한다.
# (/health 는 규약대로 오케스트레이터로 프록시된다)
# $WEB_LISTEN_PORT 는 빌드가 아니라 실행 시점의 셸이 푼다.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:$WEB_LISTEN_PORT/healthz" || exit 1
