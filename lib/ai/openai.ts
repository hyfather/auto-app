import OpenAI from "openai";

export function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_API_BASE_URL?.trim() || undefined,
  });
}

export async function summarizeWithOpenAI(prompt: string, fallback: string) {
  const client = getOpenAIClient();
  if (!client) return fallback;
  try {
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Return concise operational summaries only. Do not reveal hidden chain-of-thought." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 400,
    });
    return response.choices[0]?.message?.content?.trim() || fallback;
  } catch {
    return fallback;
  }
}
