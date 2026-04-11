import type { AiConfig } from '../config.js'

export interface AiClient {
  complete(prompt: string, systemPrompt?: string): Promise<string>
}

// IMPLEMENTED
export function createAi(config: AiConfig): AiClient {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
  }

  async function complete(prompt: string, systemPrompt?: string): Promise<string> {
    const messages: { role: string; content: string }[] = []

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt })
    }
    messages.push({ role: 'user', content: prompt })

    const response = await fetch(`${config.url}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        messages,
        max_tokens: 4096,
        // thinking_effort: config.thinkingEffort, // enable when model supports it
      }),
    })

    if (!response.ok) {
      throw new Error(`AI request failed: ${response.status} ${await response.text()}`)
    }

    const data = (await response.json()) as {
      choices: { message: { content: string } }[]
    }
    return data.choices[0]!.message.content
  }

  return { complete }
}
