const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const EMBEDDING_MODEL = "openai/text-embedding-3-small";

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

function getApiKey(): string {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) throw new Error("OPENROUTER_API_KEY not set");
  return key;
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const response = await fetch(url, init);

    if (response.ok) return response;

    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      const waitMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      console.warn(`OpenRouter 429, retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    // Non-retryable error — throw immediately
    const body = await response.text();
    throw new Error(`OpenRouter request failed (${response.status}): ${body}`);
  }
  throw new Error("OpenRouter: max retries exceeded after 429s");
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await fetchWithRetry(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
    }),
  });

  const result = await response.json();
  return result.data[0].embedding;
}

export async function chatCompletion(
  systemPrompt: string,
  userMessage: string,
  model = "openai/gpt-4o-mini",
  imageUrl?: string,
): Promise<string> {
  const userContent = imageUrl
    ? [
        { type: "text" as const, text: userMessage },
        { type: "image_url" as const, image_url: { url: imageUrl } },
      ]
    : userMessage;

  const response = await fetchWithRetry(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
    }),
  });

  const result = await response.json();
  return result.choices[0].message.content;
}
