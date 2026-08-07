#!/usr/bin/env bash
#
# translatectl.sh — 번역 앱 컴포넌트 제어
#
# voice/voicectl.sh 와 같은 방식이다. 컴포넌트 목록을 하드코딩하지 않고
# 하위 폴더에서 component.env 를 찾아 자동 인식한다. 새 컴포넌트는 폴더만 만들면 된다.
#
# 엔진은 이 스크립트가 관리하지 않는다. 엔진은 voice 저장소의 voicectl.sh 소관이고,
# 오케스트레이터는 config/engines.yaml 에 적힌 URL 로 호출할 뿐이다.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NET="proxy-network"
CONFIG_DIR="$ROOT/config"

c_red=$'\033[31m'; c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_dim=$'\033[2m'; c_bld=$'\033[1m'; c_off=$'\033[0m'

die() { echo "${c_red}오류:${c_off} $*" >&2; exit 1; }

components() {
  local d name
  for d in "$ROOT"/*/; do
    name="$(basename "$d")"
    [[ $name == _* || $name == config ]] && continue
    [[ -f "$d/component.env" && -f "$d/docker-compose.yml" ]] || continue
    echo "$name"
  done
}

meta() {
  local file="$ROOT/$1/component.env" key="$2"
  [[ -f $file ]] || return 0
  sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$file" | head -1 | sed 's/[[:space:]]*$//'
}

secret() {
  local file="$CONFIG_DIR/secrets.env" key="$1"
  [[ -f $file ]] || return 0
  sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$file" | head -1 | sed 's/[[:space:]]*$//'
}

valid() { local c; for c in $(components); do [[ $c == "$1" ]] && return 0; done; return 1; }

require_components() {
  [[ $# -gt 0 ]] || {
    echo "${c_ylw}컴포넌트를 지정하세요.${c_off} 전체를 한꺼번에 띄우지 않는 것이 기본 동작입니다."
    echo "사용 가능: $(components | tr '\n' ' ')"
    exit 1
  }
  local c
  for c in "$@"; do valid "$c" || die "그런 컴포넌트가 없습니다: $c (사용 가능: $(components | tr '\n' ' '))"; done
}

dc() { local c="$1"; shift; ( cd "$ROOT/$c" && docker compose --env-file component.env -f docker-compose.yml "$@" ); }

ensure_net() {
  docker network inspect "$NET" >/dev/null 2>&1 || die "공용 네트워크 '$NET' 가 없습니다.
  서버 공통 인프라입니다. 없다면:  docker network create $NET"
}

check_config() {
  [[ -d "$CONFIG_DIR" ]] || die "설정 디렉터리가 없습니다: $CONFIG_DIR"
  [[ -f "$CONFIG_DIR/secrets.env" ]] || {
    echo "${c_ylw}주의:${c_off} config/secrets.env 가 없습니다."
    echo "  인증이 꺼진 채로 뜨고, LLM 프로바이더는 전부 사용 불가로 표시됩니다."
    echo "  ${c_dim}cp config/secrets.env.example config/secrets.env && chmod 600 config/secrets.env${c_off}"
  }
}

container_of() { echo "translate-$1"; }
is_running() { [[ "$(docker inspect -f '{{.State.Running}}' "$(container_of "$1")" 2>/dev/null)" == "true" ]]; }
image_exists() { docker image inspect "translate-$1:latest" >/dev/null 2>&1; }

cmd_list() {
  printf "${c_bld}%-14s %-13s %-6s %-9s %s${c_off}\n" 컴포넌트 종류 포트 이미지 상태
  local c img state
  for c in $(components); do
    img=$(image_exists "$c" && echo "있음" || echo "${c_dim}없음${c_off}")
    is_running "$c" && state="${c_grn}실행중${c_off}" || state="${c_dim}정지${c_off}"
    printf "%-14s %-13s %-6s %-9b %b\n" "$c" "$(meta "$c" COMPONENT_KIND)" "$(meta "$c" PORT)" "$img" "$state"
  done
}

cmd_build() { require_components "$@"; local c; for c in "$@"; do echo "${c_bld}[$c] 빌드${c_off}"; dc "$c" build; done; }

cmd_start() {
  require_components "$@"; ensure_net; check_config
  local c port
  for c in "$@"; do
    image_exists "$c" || { echo "${c_dim}[$c] 이미지가 없어 먼저 빌드합니다${c_off}"; dc "$c" build; }
    echo "${c_bld}[$c] 기동${c_off}"; dc "$c" up -d
    port="$(meta "$c" PORT)"
    echo "  확인: curl http://localhost:${port}/health"
  done
}

cmd_stop()    { require_components "$@"; local c; for c in "$@"; do echo "${c_bld}[$c] 정지${c_off}"; dc "$c" down; done; }
cmd_restart() { require_components "$@"; local c; for c in "$@"; do echo "${c_bld}[$c] 재시작${c_off}"; dc "$c" restart; done; }

cmd_status() {
  local targets=("$@")
  [[ ${#targets[@]} -eq 0 ]] && mapfile -t targets < <(components)
  printf "${c_bld}%-14s %-10s %-11s %-6s %-10s %s${c_off}\n" 컴포넌트 상태 헬스 포트 메모리 응답
  local c port state hz mem resp
  for c in "${targets[@]}"; do
    port="$(meta "$c" PORT)"
    if is_running "$c"; then
      state="${c_grn}실행중${c_off}"
      hz="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}' "$(container_of "$c")" 2>/dev/null)"
      mem="$(docker stats --no-stream --format '{{.MemUsage}}' "$(container_of "$c")" 2>/dev/null | cut -d/ -f1 | tr -d ' ')"
      resp="$(curl -s -m 3 "http://localhost:${port}/health" 2>/dev/null | sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
      [[ -z $resp ]] && resp="${c_red}무응답${c_off}"
    else
      state="${c_dim}정지${c_off}"; hz="-"; mem="-"; resp="-"
    fi
    printf "%-14s %-10b %-11s %-6s %-10s %b\n" "$c" "$state" "${hz:--}" "$port" "${mem:--}" "$resp"
  done
}

cmd_logs() {
  [[ $# -ge 1 ]] || die "사용법: $0 logs <컴포넌트> [-f]"
  local c="$1"; shift; valid "$c" || die "그런 컴포넌트가 없습니다: $c"
  dc "$c" logs --tail 100 "$@"
}

# 설정이 실제로 어떻게 해석됐는지 확인한다. 엔진 가용성과 프로필 사용 여부가 한눈에 보인다.
cmd_config() {
  local port key auth=()
  port="$(meta orchestrator PORT)"
  key="$(secret TRANSLATE__auth__api_key)"
  [[ -n $key ]] && auth=(-H "Authorization: Bearer $key")
  is_running orchestrator || die "orchestrator 가 실행 중이 아닙니다. 먼저 $0 start orchestrator"
  curl -sS -m 10 "${auth[@]}" "http://localhost:${port}/v1/config" | python3 -m json.tool
}

usage() {
  cat <<EOF
${c_bld}translatectl.sh${c_off} — 번역 앱 컴포넌트 제어

  ${c_bld}$0 list${c_off}                     컴포넌트 목록과 상태
  ${c_bld}$0 start${c_off}   <컴포넌트...>     지정한 것만 기동
  ${c_bld}$0 stop${c_off}    <컴포넌트...>     지정한 것만 정지
  ${c_bld}$0 restart${c_off} <컴포넌트...>
  ${c_bld}$0 build${c_off}   <컴포넌트...>
  ${c_bld}$0 status${c_off}  [컴포넌트...]     상태/헬스/메모리
  ${c_bld}$0 logs${c_off}    <컴포넌트> [-f]
  ${c_bld}$0 config${c_off}                   해석된 설정 (엔진 가용성, 프로필, 프로바이더)

사용 가능: $(components | tr '\n' ' ')

${c_dim}엔진은 voice 저장소의 voicectl.sh 로 관리합니다.${c_off}
EOF
}

SUB="${1:-}"; [[ $# -gt 0 ]] && shift || true
case "$SUB" in
  list|ls)   cmd_list "$@" ;;
  build)     cmd_build "$@" ;;
  start|up)  cmd_start "$@" ;;
  stop|down) cmd_stop "$@" ;;
  restart)   cmd_restart "$@" ;;
  status|ps) cmd_status "$@" ;;
  logs)      cmd_logs "$@" ;;
  config)    cmd_config "$@" ;;
  ""|-h|--help|help) usage ;;
  *)         die "모르는 명령: $SUB (도움말: $0 --help)" ;;
esac
