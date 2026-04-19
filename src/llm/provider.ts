import { LLMProvider, LLMResponse } from "../types";

const LLM_TIMEOUT_MS = 30_000;

// ============================================================
// Provider configs: URL pattern + payload builders per provider
// ============================================================

interface ProviderConfig {
  name: string;
  buildUrl: (model: string, apiKey: string) => string;
  buildHeaders: (apiKey: string) => Record<string, string>;
  buildVisionBody: (model: string, base64: string, mimeType: string, prompt: string) => unknown;
  buildTextBody: (model: string, prompt: string) => unknown;
  parseResponse: (data: unknown) => LLMResponse;
}

const GEMINI: ProviderConfig = {
  name: "gemini",
  buildUrl: (model, apiKey) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
  buildHeaders: () => ({ "Content-Type": "application/json" }),
  buildVisionBody: (_model, base64, mimeType, prompt) => ({
    contents: [
      {
        parts: [
          { inline_data: { mime_type: mimeType, data: base64 } },
          { text: prompt },
        ],
      },
    ],
  }),
  buildTextBody: (_model, prompt) => ({
    contents: [{ parts: [{ text: prompt }] }],
  }),
  parseResponse: (data: unknown) => {
    const d = data as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
    };
    const text = d.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const u = d.usageMetadata;
    return {
      text,
      usage: u ? { promptTokens: u.promptTokenCount, completionTokens: u.candidatesTokenCount, totalTokens: u.totalTokenCount } : undefined,
    };
  },
};

const ANTHROPIC: ProviderConfig = {
  name: "anthropic",
  buildUrl: () => "https://api.anthropic.com/v1/messages",
  buildHeaders: (apiKey) => ({
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  }),
  buildVisionBody: (model, base64, mimeType, prompt) => ({
    model,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
          { type: "text", text: prompt },
        ],
      },
    ],
  }),
  buildTextBody: (model, prompt) => ({
    model,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  }),
  parseResponse: (data: unknown) => {
    const d = data as {
      content?: Array<{ text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = d.content?.[0]?.text ?? "";
    const u = d.usage;
    return {
      text,
      usage: u ? { promptTokens: u.input_tokens, completionTokens: u.output_tokens, totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) } : undefined,
    };
  },
};

const OPENAI: ProviderConfig = {
  name: "openai",
  buildUrl: () => "https://api.openai.com/v1/chat/completions",
  buildHeaders: (apiKey) => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  }),
  buildVisionBody: (model, base64, mimeType, prompt) => ({
    model,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
          { type: "text", text: prompt },
        ],
      },
    ],
  }),
  buildTextBody: (model, prompt) => ({
    model,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  }),
  parseResponse: (data: unknown) => {
    const d = data as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const text = d.choices?.[0]?.message?.content ?? "";
    const u = d.usage;
    return {
      text,
      usage: u ? { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens, totalTokens: u.total_tokens } : undefined,
    };
  },
};

const GROQ: ProviderConfig = {
  ...OPENAI,
  name: "groq",
  buildUrl: () => "https://api.groq.com/openai/v1/chat/completions",
};

const PROVIDERS: Record<string, ProviderConfig> = {
  gemini: GEMINI,
  anthropic: ANTHROPIC,
  openai: OPENAI,
  groq: GROQ,
};

// ============================================================
// The single LLMProvider implementation — driven by config
// ============================================================

class FetchLLMProvider implements LLMProvider {
  readonly name: string;
  private config: ProviderConfig;
  private model: string;
  private apiKey: string;

  constructor(config: ProviderConfig, model: string, apiKey: string) {
    this.name = config.name;
    this.config = config;
    this.model = model;
    this.apiKey = apiKey;
  }

  async extractDocument(base64: string, mimeType: string, prompt: string): Promise<LLMResponse> {
    const url = this.config.buildUrl(this.model, this.apiKey);
    const headers = this.config.buildHeaders(this.apiKey);
    const body = this.config.buildVisionBody(this.model, base64, mimeType, prompt);
    return this.request(url, headers, body);
  }

  async sendPrompt(prompt: string): Promise<LLMResponse> {
    const url = this.config.buildUrl(this.model, this.apiKey);
    const headers = this.config.buildHeaders(this.apiKey);
    const body = this.config.buildTextBody(this.model, prompt);
    return this.request(url, headers, body);
  }

  async checkHealth(): Promise<boolean> {
    try {
      await this.sendPrompt("Reply with OK");
      return true;
    } catch {
      return false;
    }
  }

  private async request(url: string, headers: Record<string, string>, body: unknown): Promise<LLMResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`LLM API error ${res.status}: ${errBody}`);
      }

      const data: unknown = await res.json();
      return this.config.parseResponse(data);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(`LLM request timed out after ${LLM_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ============================================================
// Factory + singleton
// ============================================================

let instance: LLMProvider | null = null;

export function createLLMProvider(provider: string, model: string, apiKey: string): LLMProvider {
  const config = PROVIDERS[provider.toLowerCase()];
  if (!config) {
    const supported = Object.keys(PROVIDERS).join(", ");
    throw new Error(`Unsupported LLM provider: "${provider}". Supported: ${supported}`);
  }
  return new FetchLLMProvider(config, model, apiKey);
}

export function getLLMProvider(): LLMProvider {
  if (!instance) {
    const provider = process.env.LLM_PROVIDER;
    const model = process.env.LLM_MODEL;
    const apiKey = process.env.LLM_API_KEY;

    if (!provider || !model || !apiKey) {
      throw new Error("Missing LLM config. Set LLM_PROVIDER, LLM_MODEL, and LLM_API_KEY environment variables.");
    }

    instance = createLLMProvider(provider, model, apiKey);
  }
  return instance;
}

export function resetLLMProvider(): void {
  instance = null;
}
