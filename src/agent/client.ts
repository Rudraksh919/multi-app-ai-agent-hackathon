import OpenAI from 'openai';
import { CONFIG, env } from '../config.js';

export function llmClient(): OpenAI {
  return new OpenAI({
    apiKey: env.openrouterKey(),
    baseURL: CONFIG.llm.baseURL,
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/Rudraksh919/multi-app-ai-agent-hackathon',
      'X-Title': 'bisect',
    },
  });
}
