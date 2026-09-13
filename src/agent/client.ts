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

function allClients(): OpenAI[] {
  if (!clients) clients = env.openrouterKeys().map(makeClient);
  return clients;
}

export interface CompletionOutcome {
  res: ChatCompletion | null;
  /** Set when every key failed — the message from whichever failed last. */
  error?: string;
  /** Which configured key (0-based) actually answered, for logging. */
  keyIndex?: number;
}

/**
 * Runs one chat completion, rotating through every configured OpenRouter key on failure —
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
    const client = list[i];
    if (!client) continue;
    try {
      const res = await client.chat.completions.create(params);
      if (!res.choices || res.choices.length === 0) {
        const raw = res as unknown as { error?: { message?: string } };
        lastError = raw.error?.message ?? 'LLM provider returned no choices (likely a transient free-tier error).';
        continue;
      }
      return { res, keyIndex: i };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }
  }

  return { res: null, error: lastError };
}
