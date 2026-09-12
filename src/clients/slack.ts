import type { SlackClient, SlackMessage } from '../types.js';
import { env } from '../config.js';

const API = 'https://slack.com/api';

async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.slackToken()}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!json.ok) {
    // `not_in_channel` is the classic first-run failure: /invite the bot.
    throw new Error(`Slack ${method} failed: ${json.error ?? res.status}`);
  }
  return json;
}

interface RawMessage {
  type: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  text?: string;
  ts: string;
}

export function makeSlackClient(): SlackClient {
  return {
    async fetchNew(oldest) {
      const channel = env.slackChannel();
      const res = await call<{ messages: RawMessage[] }>('conversations.history', {
        channel,
        limit: 20,
        ...(oldest ? { oldest, inclusive: false } : {}),
      });

      return (res.messages ?? [])
        // Without this filter the agent replies to its own replies, forever.
        .filter((m) => m.type === 'message' && !m.subtype && !m.bot_id && m.text)
        .map<SlackMessage>((m) => ({
          channel,
          ts: m.ts,
          user: m.user ?? 'unknown',
          text: m.text ?? '',
        }))
        // Slack returns newest-first; we want to process in order.
        .sort((a, b) => Number(a.ts) - Number(b.ts));
    },

    async reply(channel, threadTs, text) {
      await call('chat.postMessage', { channel, thread_ts: threadTs, text });
    },

    async postBlocks(channel, threadTs, blocks, fallback) {
      await call('chat.postMessage', { channel, thread_ts: threadTs, blocks, text: fallback });
    },
  };
}
