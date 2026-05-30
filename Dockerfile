# Multi-stage build: Rust BE + Node FE → single lightweight image.
#
# Stage 1: build the Rust BE binary (release).
# Stage 2: build the FE static bundle (pnpm + vite).
# Stage 3: tiny runtime with just the binary + static files.
#
# Usage:
#   docker compose up -d          # BE on :4318, FE on :5174
#   docker compose down

# ── Stage 1: Rust build ──────────────────────────────────────
FROM rust:1.95-bookworm AS rust-builder

WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates/ crates/

# Build release binary. We don't need dev deps (test fixtures etc.).
RUN cargo build --release -p agentgrove-server \
    && strip target/release/agentgrove

# ── Stage 2: FE build ────────────────────────────────────────
FROM node:24-bookworm-slim AS fe-builder

# Install pnpm via corepack (ships with Node 24).
RUN corepack enable pnpm

WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY apps/web/ apps/web/
RUN pnpm -C apps/web build

# ── Stage 3: runtime ─────────────────────────────────────────
FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# Non-root user for safety.
RUN useradd -m agentgrove
USER agentgrove
WORKDIR /home/agentgrove

# Copy the BE binary.
COPY --from=rust-builder /src/target/release/agentgrove ./agentgrove

# Copy the FE static bundle.
COPY --from=fe-builder /src/apps/web/dist ./web-dist

# State directory lives inside the container. Mount a volume
# if you want persistence across container restarts:
#   docker run -v ag-data:/home/agentgrove/.data ...
ENV AGENTGROVE_STATE_DIR=/home/agentgrove/.data
RUN mkdir -p /home/agentgrove/.data

# BE listens on 4317, FE static files are served by a simple
# HTTP server (we use `npx serve` in compose, or the user can
# point any static file server at web-dist/).
EXPOSE 4317
EXPOSE 5173

# Default: start the BE. The compose file overrides this to also
# serve the FE.
CMD ["./agentgrove"]
