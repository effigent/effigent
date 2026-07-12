/**
 * Minimal OpenRouter client — the live `callModel` for model-routing validation.
 * Server-only: reads OPENROUTER_API_KEY from env, never exposed to the client.
 */

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export function hasOpenRouterKey(): boolean {
  return !!process.env.OPENROUTER_API_KEY;
}

/** One chat completion. `input` is sent as a single user message. Returns the
 *  assistant text (may be '' if the model spends its budget on reasoning). */
export async function callOpenRouter(
  model: string,
  input: string,
  opts: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY not set');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'x-title': 'Effigent route-test',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: input }],
        max_tokens: opts.maxTokens ?? 1024,
      }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`openrouter ${res.status}`);
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };
    if (data.error) throw new Error(data.error.message ?? 'openrouter error');
    return data.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timer);
  }
}
