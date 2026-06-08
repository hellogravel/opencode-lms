#!/bin/sh
set -eu

# Write a fresh opencode config every container start. Deterministic:
# whatever you pass in via env always wins, no stale state in the volume.
# The opencode-data volume still persists logs, memory, etc.

CONFIG_DIR=/home/coder/.config/opencode
CONFIG="$CONFIG_DIR/opencode.jsonc"

mkdir -p "$CONFIG_DIR"

# JSON-escape the api key via node (always available in this image). Avoids
# building broken JSON if the key ever contains a quote or backslash.
ESCAPED_API_KEY=$(node -e 'process.stdout.write(JSON.stringify(process.env.LM_STUDIO_API_KEY || ""))')

cat > "$CONFIG" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "disabled_providers": ["opencode", "lmstudio"],
  "model": "${LMS_MODEL:-lms/google/gemma-4-e4b}",
  "provider": {
    "lms": {
      "name": "LM Studio",
      "options": {
        "baseURL": "${LMS_BASE_URL:-http://host.docker.internal:1234}",
        "apiKey": $ESCAPED_API_KEY,
        "autoDownload": ${LMS_AUTO_DOWNLOAD:-false},
        "disableAutoLoad": ${LMS_DISABLE_AUTO_LOAD:-false}
      }
    }
  },
  "plugin": ["opencode-lms@file:/home/coder/opencode-lms"]
}
EOF

# Surface the resolved config to the container log so the user can see what's
# actually loaded — minus the api key.
echo "[opencode-lms docker] wrote $CONFIG with:"
echo "  model=${LMS_MODEL:-lms/google/gemma-4-e4b}"
echo "  baseURL=${LMS_BASE_URL:-http://host.docker.internal:1234}"
echo "  apiKey=$( [ -n "${LM_STUDIO_API_KEY:-}" ] && echo "(set, ${#LM_STUDIO_API_KEY} chars)" || echo "(unset)" )"
echo "  autoDownload=${LMS_AUTO_DOWNLOAD:-false}"
echo "  disableAutoLoad=${LMS_DISABLE_AUTO_LOAD:-false}"

exec "$@"
