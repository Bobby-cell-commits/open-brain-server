// Main router for supabase edge-runtime (self-hosted).
// Based on the official Supabase Docker main function.
//
// Receives all HTTP requests and dispatches to Edge Functions
// via EdgeRuntime.userWorkers (isolated V8 contexts).
//
// JWT verification is disabled — OB handles auth internally
// via x-brain-key at the Edge Function layer.

const FUNCTIONS_DIR = "/home/deno/functions";

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, x-brain-key, Authorization",
      },
    });
  }

  const url = new URL(req.url);
  const pathParts = url.pathname.split("/");
  const serviceName = pathParts[1];

  if (!serviceName || serviceName === "") {
    // Health check — root path returns ok
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const servicePath = `${FUNCTIONS_DIR}/${serviceName}`;

  // Forward all environment variables to the User Worker.
  // User Workers can't access host env vars directly.
  const envVarsObj = Deno.env.toObject();
  const envVars = Object.keys(envVarsObj).map((k) => [k, envVarsObj[k]]);

  try {
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath,
      memoryLimitMb: 150,
      workerTimeoutMs: 10 * 60 * 1000, // 10 min (graph analysis can be slow)
      noModuleCache: false,
      importMapPath: null,
      envVars,
    });

    return await worker.fetch(req);
  } catch (e) {
    console.error(`[main] Error dispatching to '${serviceName}':`, e);

    const status = e instanceof Deno.errors.WorkerRequestCancelled ? 503 : 500;

    return new Response(
      JSON.stringify({ error: e.toString() }),
      {
        status,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
});
