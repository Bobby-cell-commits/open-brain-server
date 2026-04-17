# Minimal container for MCP registry listings (Glama automated probe).
# Runs the open-brain MCP Edge Function as a standalone Deno HTTP server.
#
# For real self-hosted deployment see docker/docker-compose.yml (full stack:
# Postgres + pgvector, PostgREST, Supabase edge-runtime, Caddy, cron).

FROM denoland/deno:2.1.4

WORKDIR /app

# Copy only the MCP function and its shared helpers. Other functions
# (telegram-bot, run-pipeline, monitor-pipeline, refresh-graph-analysis)
# are not needed for the MCP listing probe.
COPY supabase/functions/open-brain-mcp /app/supabase/functions/open-brain-mcp
COPY supabase/functions/_shared /app/supabase/functions/_shared

# Pre-cache npm: specifiers + transitive deps so container start is fast
# and deterministic (no network required at runtime).
RUN deno cache /app/supabase/functions/open-brain-mcp/index.ts

# Deno.serve() default port
EXPOSE 8000

CMD ["deno", "run", "-A", "/app/supabase/functions/open-brain-mcp/index.ts"]
