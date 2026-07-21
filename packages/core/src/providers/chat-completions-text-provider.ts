import type { TextProvider, TextRequest } from "./provider.ts";
import { HttpClient } from "./http/http-client.ts";
import type { ChatTextConfig } from "./http/config.ts";

interface ChatCompletionResponse {
  readonly choices: readonly { readonly message: { readonly content: string | null } }[];
}

/**
 * TextProvider speaking the Chat Completions protocol — an open standard implemented by the
 * self-hosted inference stack: vLLM and Ollama (serving Llama 3.x, Qwen 2.5, Mistral, and
 * any open-weights model) expose exactly this endpoint. Point `baseUrl` at your own GPU
 * server; no API key required. Commercial endpoints that speak the same protocol also work
 * through this adapter, but nothing in the platform depends on them.
 */
export class ChatCompletionsTextProvider implements TextProvider {
  readonly name = "chat-completions";
  readonly #http: HttpClient;
  readonly #cfg: ChatTextConfig;

  constructor(cfg: ChatTextConfig, http?: HttpClient) {
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
      // Local inference servers are keyless; send auth only when configured.
      ...(this.#cfg.apiKey ? { headers: { authorization: `Bearer ${this.#cfg.apiKey}` } } : {}),
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
