# Docker test harness

A reproducible sandbox for testing the `opencode-lms` plugin end-to-end
against a real LM Studio server. Spin it up, point it at your LMS, and
you get a working OpenCode server with this plugin loaded — without
touching your host's OpenCode config.

Useful when:

- You're iterating on the plugin and want a clean OpenCode runtime to
  smoke-test against.
- You're evaluating the plugin and want to try it before installing it
  into your host environment.
- Something behaves differently against the real OpenCode loader than
  against the unit tests, and you need to reproduce.

## What this is

- Ubuntu 24.04 base, non-root `coder` user (UID 1000).
- OpenCode CLI installed from `https://opencode.ai/install`.
- The plugin source from the parent directory is copied in at build
  time via BuildKit's `additional_contexts`, `npm ci && npm run build`
  runs inside the image, and the Dockerfile pre-populates OpenCode's
  plugin cache at
  `~/.cache/opencode/packages/@hellogravel/opencode-lms@file:/home/coder/opencode-lms/`
  so the runtime's "auto" installer finds it ready to import. The
  generated config references it as
  `"plugin": ["@hellogravel/opencode-lms@file:/home/coder/opencode-lms"]` —
  the `<name>@file:<path>` form is the npm spec OpenCode actually
  parses (a bare `file:/...` entry silently fails to install).
- The container's `opencode.jsonc` is **regenerated on every start** by
  the entrypoint from env vars. Persistent state (logs, memory) lives
  in the `opencode-data` named volume; the config is deliberately not
  persisted so you always know exactly what you're testing.
- Networked to LM Studio via `host.docker.internal` (the Docker host)
  by default. Override with `LMS_BASE_URL` to point at any reachable
  server.
- The server requires `OPENCODE_SERVER_PASSWORD` for auth.

## Prerequisites

- Docker with BuildKit (default in modern Docker Desktop).
- LM Studio running somewhere the container can reach. From a Mac with
  LMS on the same machine, `host.docker.internal:1234` works. For LMS
  on another host on your LAN, set `LMS_BASE_URL=http://<ip>:1234`.
- `~/sandbox` on the host (mounted as the container's `/workspace` —
  the scratch dir for any code edits the agent makes).
- A populated `.env` — see `.env.example`.

## Setup

```sh
cd opencode-lms/docker
mkdir -p ~/sandbox
cp .env.example .env
echo "OPENCODE_SERVER_PASSWORD=$(openssl rand -hex 16)" >> .env
chmod 600 .env
# Edit .env: set LM_STUDIO_API_KEY (if your LMS has auth on)
# and LMS_BASE_URL (if your LMS is not on the Docker host).
```

## Commands

```sh
docker compose up --build -d         # build + start (detached)
docker compose up --build            # foreground; Ctrl-C stops cleanly
docker compose logs -f               # follow logs — watch for plugin init
docker compose exec opencode bash    # shell into the container
docker compose down                  # stop, keep volumes
docker compose down -v               # stop and wipe volumes
docker compose build --no-cache      # rebuild from scratch
```

The OpenCode server listens on `http://localhost:4096`. Use the
password from `.env` to authenticate.

## What to look for in logs

On first request to an unloaded model:

```
[opencode-lms docker] wrote /home/coder/.config/opencode/opencode.jsonc with:
  model=lms/google/gemma-4-e4b
  baseURL=http://host.docker.internal:1234
  apiKey=(set, 35 chars)
  ...
[opencode-lms] LM Studio plugin initialized
[opencode-lms] Discovered 12 model(s) at http://host.docker.internal:1234
[opencode-lms] Auto-loading model google/gemma-4-e4b
[opencode-lms] Load started (google/gemma-4-e4b)
[opencode-lms] Loading google/gemma-4-e4b: 20%
[opencode-lms] Loading google/gemma-4-e4b: 100%
[opencode-lms] Model loaded in 4.3s
```

If you see a "health check failed" block instead, the URL list there
tells you what the plugin actually tried — usually that's a network or
auth issue with the LMS endpoint and not the plugin itself.

## Configuration knobs (set in `.env`)

| Env var | Default | What it controls |
|---|---|---|
| `OPENCODE_SERVER_PASSWORD` | required | OpenCode server auth password |
| `LM_STUDIO_API_KEY` | (empty) | Bearer token sent to LM Studio; required if LM Studio has auth on |
| `LMS_BASE_URL` | `http://host.docker.internal:1234` | LM Studio base URL (no `/v1` suffix). Override when LMS isn't on the Docker host. |
| `LMS_MODEL` | `lms/google/gemma-4-e4b` | Default OpenCode model |
| `LMS_AUTO_DOWNLOAD` | `false` | If `true`, an unknown model triggers a download via `/api/v1/models/download` |
| `LMS_DISABLE_AUTO_LOAD` | `false` | If `true`, the plugin won't auto-load missing models |

To switch models without rebuilding:

```sh
LMS_MODEL=lms/qwen/qwen3.6-35b-a3b docker compose up -d
```

## Design notes

- **Self-contained build context.** The `additional_contexts` entry
  for the plugin source is `..` (the package root). No host-specific
  paths — `git clone && docker compose up --build` works from anywhere.
- **Plugin pre-staged in opencode's cache.** A bare `file:` plugin
  spec doesn't parse; the canonical form is `<name>@file:<path>`. We
  pre-populate `~/.cache/opencode/packages/@hellogravel/opencode-lms@file:/.../`
  with the right shape so OpenCode's auto-install finds it ready and
  skips the npm registry fetch — fast startup, works offline.
- **Config regenerated every start.** Deterministic surface: whatever
  is in `.env` always wins. The `opencode-data` volume still
  accumulates logs / memory / session state across restarts.
- **Config written under `options`.** OpenCode's `ProviderConfig`
  schema only carries `options` as an open bucket — top-level fields
  it doesn't recognize get silently stripped. The plugin reads from
  `options.*` first with top-level fallback.

## File layout

```
docker/
├── Dockerfile             # Single-stage Ubuntu + node + opencode + plugin build
├── docker-compose.yml     # additional_context resolves to '..' (the package root)
├── entrypoint.sh          # Writes opencode.jsonc from env vars on every start
├── .dockerignore
├── .env                   # local-only, gitignored at the repo root
├── .env.example           # template
└── README.md              # this file
```

Volumes managed by compose:

- `opencode-config` — `/home/coder/.config/opencode` (config is overwritten on start; anything else OpenCode drops here persists)
- `opencode-data` — `/home/coder/.local/share/opencode` (logs, memory, runtime state)
