import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from 'openai/resources/chat/completions';
import { CONFIG, env } from '../config.js';

function makeClient(apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: CONFIG.llm.baseURL,
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/Rudraksh919/multi-app-ai-agent-hackathon',
      'X-Title': 'bisect',
    },
  });
}

let clients: OpenAI[] | null = null;
let ollamaClient: OpenAI | null = null;
let announcedOllamaFallback = false;
const exhaustedOpenRouterKeys = new Set<number>();

function allClients(): OpenAI[] {
  if (!clients) clients = env.openrouterKeys().map(makeClient);
  return clients;
}

function localClient(): { client: OpenAI; model: string } | null {
  const model = env.ollamaModel();
  if (!model) return null;

  if (!ollamaClient) {
    ollamaClient = new OpenAI({
      apiKey: 'ollama', // Required by the SDK; ignored by the local Ollama server.
      baseURL: env.ollamaBaseUrl(),
    });
  }

  return { client: ollamaClient, model };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isDailyFreeLimit(message: string): boolean {
  return message.toLowerCase().includes('free-models-per-day');
}

export interface CompletionOutcome {
  res: ChatCompletion | null;
  /** Set when every remote key and the optional local fallback failed. */
  error?: string;
  /** Which configured key (0-based) actually answered, for logging. */
  keyIndex?: number;
  /** The backend that answered the request. */
  provider?: 'openrouter' | 'ollama';
}

/**
 * Runs one chat completion, rotating through every configured OpenRouter key on failure, then
 * falling back to local Ollama when OLLAMA_MODEL is configured —
 * a network error, or a malformed 200-with-error-body response, which is how free-tier
 * OpenRouter models signal "temporarily overloaded" instead of a normal HTTP error. Returns
 * a result rather than throwing so call sites can treat "every key failed" the same way
 * they already treat any other provider failure (an honest abstention, not a crash).
 */
export async function createChatCompletion(
  params: ChatCompletionCreateParamsNonStreaming,
): Promise<CompletionOutcome> {
  const list = allClients();
  let lastError = 'no OpenRouter keys configured';

  for (let i = 0; i < list.length; i++) {
    if (exhaustedOpenRouterKeys.has(i)) continue;
    const client = list[i];
    if (!client) continue;
    try {
      const res = await client.chat.completions.create(params);
      if (!res.choices || res.choices.length === 0) {
        const raw = res as unknown as { error?: { message?: string } };
        lastError = raw.error?.message ?? 'LLM provider returned no choices (likely a transient free-tier error).';
        if (isDailyFreeLimit(lastError)) exhaustedOpenRouterKeys.add(i);
        continue;
      }
      return { res, keyIndex: i, provider: 'openrouter' };
    } catch (err) {
      lastError = errorMessage(err);
      if (isDailyFreeLimit(lastError)) exhaustedOpenRouterKeys.add(i);
      continue;
    }
  }


  const local = localClient();
  if (local) {
    try {
      const res = await local.client.chat.completions.create({ ...params, model: local.model });
      if (!res.choices || res.choices.length === 0) {
        const raw = res as unknown as { error?: { message?: string } };
        throw new Error(raw.error?.message ?? 'Ollama returned no choices.');
      }
      if (!announcedOllamaFallback) {
        console.warn(`OpenRouter unavailable — using local Ollama model ${local.model}.`);
        announcedOllamaFallback = true;
      }
      return { res, provider: 'ollama' };
    } catch (err) {
      return {
        res: null,
        error: `OpenRouter failed: ${lastError}; Ollama fallback failed: ${errorMessage(err)}`,
      };
    }
  }

  return { res: null, error: lastError };
}
