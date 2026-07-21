import type { TextProvider, TextRequest } from "./provider.ts";
import { HttpClient } from "./http/http-client.ts";
import type { OpenAITextConfig } from "./http/config.ts";

interface ChatCompletionResponse {
  readonly choices: readonly { readonly message: { readonly content: string | null } }[];
}

/**
 * TextProvider backed by the OpenAI Chat Completions API. Because the contract is widely
 * cloned, the same adapter works against Azure OpenAI, Together, Groq, Fireworks, etc. by
 * overriding `baseUrl`/`model` — one adapter, many vendors.
 */
export class OpenAITextProvider implements TextProvider {
  readonly name = "openai-text";
  readonly #http: HttpClient;
  readonly #cfg: OpenAITextConfig;

  constructor(cfg: OpenAITextConfig, http?: HttpClient) {
    this.#cfg = cfg;
    this.#http = http ?? new HttpClient({ provider: this.name });
  }

  async generateText(req: TextRequest): Promise<string> {
    const messages: { role: string; content: string }[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content: req.prompt });

    const res = await this.#http.requestJson<ChatCompletionResponse>({
      method: "POST",
      url: `${this.#cfg.baseUrl}/v1/chat/completions`,
      headers: { authorization: `Bearer ${this.#cfg.apiKey}` },
      body: {
        model: this.#cfg.model,
        messages,
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      },
    });

    const content = res.choices[0]?.message.content;
    if (!content) throw new Error(`${this.name}: empty completion`);
    return content;
  }
}
