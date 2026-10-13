# Real Claude Code in a Linux box, for testing effigentd + Tetragon against a real agent.
# Auth: pass CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY.
FROM node:22-bookworm-slim
RUN apt-get update -qq && apt-get install -y -qq curl git ca-certificates >/dev/null && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 && claude --version
RUN useradd -m dev && mkdir -p /work && chown dev /work && echo "API_KEY=sk-test-not-real" > /work/.env && chown dev /work/.env
USER dev
WORKDIR /work
CMD ["claude"]
