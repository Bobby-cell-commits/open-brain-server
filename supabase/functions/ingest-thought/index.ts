// ingest-thought: DEPRECATED — replaced by telegram-bot.
// Returns 410 Gone for all requests to prevent runtime errors
// from stale function signatures after the multi-tenant migration.

Deno.serve(() =>
  new Response(
    JSON.stringify({ error: "This endpoint has been decommissioned. Use telegram-bot instead." }),
    { status: 410, headers: { "Content-Type": "application/json" } },
  )
);
