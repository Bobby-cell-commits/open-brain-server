export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-brain-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function errorResponse(
  message: string,
  status = 500,
): Response {
  return new Response(
    JSON.stringify({ error: message }),
    {
      status,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    },
  );
}
