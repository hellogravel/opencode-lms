#!/bin/sh
set -eu
cd "$(dirname "$0")"

# Loader smoke test: boot the docker harness (latest OpenCode, plugin baked in)
# and assert GET /config/providers returns 200 and lists "lmstudio".
#
# This catches loader-level breakage the fetch-stubbed unit suite structurally
# can't — stray entry-module exports (the 0.3.0-dev incident: OpenCode's legacy
# loader calls every function export as a plugin and a helper's undefined
# return 500s provider listing), plugin-module shape changes, and future
# OpenCode releases (the image installs OpenCode unpinned, so re-running this
# after an OpenCode release is the pin-bump check).
#
# Requires a populated docker/.env (see README.md) AND a reachable LM Studio
# (with LM_STUDIO_API_KEY set if auth is on): a provider that discovers zero
# models is dropped from /config/providers, so the "lmstudio" assertion needs
# discovery to succeed. (The loader-crash class still shows as a 500 either
# way; only the listing assertion needs LMS.) Exits nonzero with the last
# response + recent container logs on failure.

PORT="${OPENCODE_PORT:-4096}"
URL="http://127.0.0.1:${PORT}/config/providers"
TRIES="${SMOKE_TRIES:-30}"

[ -f .env ] || { echo "smoke: docker/.env missing — see docker/README.md setup" >&2; exit 1; }
PW=$(grep -m1 '^OPENCODE_SERVER_PASSWORD=' .env | cut -d= -f2- || true)
[ -n "${PW:-}" ] || { echo "smoke: OPENCODE_SERVER_PASSWORD empty in docker/.env" >&2; exit 1; }

mkdir -p "$HOME/sandbox" # compose bind-mounts it

cleanup() { docker compose down >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

docker compose build
docker compose up -d

CODE=000
BODY=""
i=0
while [ "$i" -lt "$TRIES" ]; do
  i=$((i + 1))
  RESP=$(curl -s -u "opencode:$PW" --max-time 5 -w '\n%{http_code}' "$URL" 2>/dev/null || printf '\n000')
  CODE=$(printf '%s' "$RESP" | tail -n 1)
  BODY=$(printf '%s' "$RESP" | sed '$d')
  [ "$CODE" = "200" ] && break
  sleep 2
done

if [ "$CODE" != "200" ]; then
  echo "smoke: FAIL — $URL never returned 200 (last code $CODE after $i tries)" >&2
  printf 'last response body:\n%s\n' "$BODY" >&2
  docker compose logs --tail 40 >&2 || true
  exit 1
fi

case "$BODY" in
*lmstudio*) ;;
*)
  echo 'smoke: FAIL — 200 but no "lmstudio" in /config/providers body' >&2
  printf 'body:\n%s\n' "$BODY" >&2
  exit 1
  ;;
esac

echo "smoke: OK — /config/providers 200 and lists lmstudio"
