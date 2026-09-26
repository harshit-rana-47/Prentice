export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export interface GroqConfig {
  apiKey: string;
  model: string;
}

export function readGroqConfig(): { ok: true; config: GroqConfig } | { ok: false; message: string } {
  const apiKey = process.env.GROQ_API_KEY?.trim() ?? "";
  const model = process.env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL;
  if (!apiKey) {
    return {
      ok: false,
      message: "The Learning AI is unavailable. Set GROQ_API_KEY for the connector. Prentice will not ask a coding agent to teach instead.",
    };
  }
  return { ok: true, config: { apiKey, model } };
}

export async function groqJson(config: GroqConfig, system: string, user: string): Promise<{ ok: true; json: unknown } | { ok: false; message: string }> {
  let response: Response;
  try {
    response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
  } catch {
    return { ok: false, message: "The Learning AI could not be reached. The coding agent was not asked to teach instead." };
  }
  if (!response.ok) {
    return { ok: false, message: `The Learning AI returned ${response.status}. The coding agent was not asked to teach instead.` };
  }
  const body = (await response.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }> } | null;
  const content = body?.choices?.[0]?.message?.content;
  if (!content) return { ok: false, message: "The Learning AI returned an empty response." };
  try {
    return { ok: true, json: JSON.parse(content) as unknown };
  } catch {
    return { ok: false, message: "The Learning AI response was not usable." };
  }
}
