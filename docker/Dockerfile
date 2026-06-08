# syntax=docker/dockerfile:1.7

# Single-stage runtime — no Rust toolchain, no separate builder needed.
# The opencode-lms plugin is plain TypeScript; we install + tsc inside the
# final image.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl git jq openssh-client ca-certificates ripgrep \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN userdel -r ubuntu 2>/dev/null || true \
    && useradd -m -s /bin/bash -u 1000 coder \
    && mkdir -p /workspace \
    && chown coder:coder /workspace

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER coder
WORKDIR /home/coder

RUN mkdir -p /home/coder/.local/share/opencode \
             /home/coder/.config/opencode

# Install the OpenCode CLI to /home/coder/.opencode/
RUN curl -fsSL https://opencode.ai/install | bash
ENV PATH=/home/coder/.opencode/bin:$PATH

# Bake in the opencode-lms plugin source. Only copy the files needed to
# build — skipping node_modules and dist lets us avoid host/container
# arch mismatches and recreate dist cleanly in the image.
COPY --from=opencode-lms --chown=coder:coder package.json package-lock.json tsconfig.json /home/coder/opencode-lms/
COPY --from=opencode-lms --chown=coder:coder src/ /home/coder/opencode-lms/src/

RUN cd /home/coder/opencode-lms \
    && npm ci \
    && npm run build

# OpenCode loads each `config.plugin` entry as an npm spec by creating
# ~/.cache/opencode/packages/<spec>/ and running `npm install` there.
# A bare "file:/path" entry doesn't parse — it needs the `<name>@file:<path>`
# form (matching how a real published plugin like @codenomad/... loads).
# To avoid a slow first-run install (and to let this image work offline),
# we mimic what opencode would do at runtime: build the cache directory
# now, with our plugin's deps already resolved. `--install auto` then
# finds node_modules populated and skips the npm step entirely.
#
# The cache dir name *literally* contains the `@file:/...` spec, which
# becomes a deeply nested path on disk — that's exactly how OpenCode's
# own cache stores it for other file:-installed plugins.
RUN CACHE_DIR="/home/coder/.cache/opencode/packages/opencode-lms@file:/home/coder/opencode-lms" \
    && mkdir -p "$CACHE_DIR" \
    && cd "$CACHE_DIR" \
    && printf '{"dependencies":{"opencode-lms":"file:/home/coder/opencode-lms"}}' > package.json \
    && npm install --no-audit --no-fund --no-progress --omit=optional

WORKDIR /workspace
EXPOSE 4096

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
