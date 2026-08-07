#!/bin/sh
#
# nginx 설정을 환경변수로 렌더링한다. nginx 는 환경변수를 직접 못 읽으므로
# 기동 직전에 envsubst 로 템플릿을 채운다.
#
# 두 가지를 여기서 한다.
#
#   1) 주소·포트·한계값을 템플릿에 채운다. 소스에는 기본값이 없다 —
#      값이 없으면 명확한 오류로 죽는다 (component.env 가 유일한 출처).
#   2) 오케스트레이터 API 키를 프록시 헤더로 주입한다.
#      키는 "환경변수의 이름"(ORCHESTRATOR_API_KEY_ENV)으로 간접 참조한다.
#      엔진/프로바이더 설정의 api_key_env 와 같은 방식이고, 덕분에 이 스크립트에
#      비밀값의 변수 이름조차 박히지 않는다.
#
# 키는 서버 쪽(nginx)에만 남는다. 정적 파일에도 응답에도 나가지 않는다.
#
set -eu

TEMPLATES=/etc/nginx/conf.templates
SNIPPETS=/etc/nginx/snippets

need() {
  # 값이 없으면 죽는다. 코드 폴백(`${VAR:-8402}`)을 두지 않는 것이 이 프로젝트의 규칙이다.
  eval "value=\${$1:-}"
  if [ -z "$value" ]; then
    echo "web: required setting '$1' is missing. Set it in web/component.env" >&2
    exit 1
  fi
}

for var in WEB_LISTEN_PORT ORCHESTRATOR_URL MAX_UPLOAD_SIZE PROXY_READ_TIMEOUT; do
  need "$var"
done

mkdir -p "$SNIPPETS"

# ---- 업스트림 인증 헤더 -------------------------------------------------------
#
# 헤더 값을 템플릿에 넣지 않고 별도 스니펫으로 뽑는 이유는, "키가 없으면 헤더가
# 아예 없다"를 조건문 없이 표현하기 위해서다. nginx 에는 if 가 마땅치 않다.
key=""
if [ -n "${ORCHESTRATOR_API_KEY_ENV:-}" ]; then
  key="$(printenv "$ORCHESTRATOR_API_KEY_ENV" 2>/dev/null || true)"
fi

if [ -n "$key" ]; then
  # 브라우저가 보낸 Authorization 은 여기서 덮어써진다. 신원은 프록시가 정한다.
  printf 'proxy_set_header Authorization "Bearer %s";\n' "$key" > "$SNIPPETS/upstream-auth.conf"
  echo "web: injecting Authorization header from \$$ORCHESTRATOR_API_KEY_ENV"
else
  # 오케스트레이터 인증이 꺼진 경우. 클라이언트가 보낸 헤더도 흘려보내지 않는다.
  printf 'proxy_set_header Authorization "";\n' > "$SNIPPETS/upstream-auth.conf"
  echo "web: no API key configured — proxying without an Authorization header"
fi
chmod 600 "$SNIPPETS/upstream-auth.conf"
unset key

# ---- 설정 템플릿 --------------------------------------------------------------
#
# 치환할 변수를 명시한다. 그래야 nginx 자신의 $host, $remote_addr 같은 변수가
# 실수로 지워지지 않는다.
VARS='${WEB_LISTEN_PORT} ${ORCHESTRATOR_URL} ${MAX_UPLOAD_SIZE} ${PROXY_READ_TIMEOUT}'

envsubst "$VARS" < "$TEMPLATES/orchestrator-proxy.conf.template" > "$SNIPPETS/orchestrator-proxy.conf"
envsubst "$VARS" < "$TEMPLATES/site.conf.template"               > /etc/nginx/conf.d/site.conf

echo "web: listening on ${WEB_LISTEN_PORT}, proxying /v1/ and /health to ${ORCHESTRATOR_URL}"
