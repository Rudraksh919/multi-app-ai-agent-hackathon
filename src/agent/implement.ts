import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { CONFIG } from '../config.js';
import type { Diagnosis, GitHubClient, RepoClient } from '../types.js';
import { createChatCompletion } from './client.js';
import { toOpenAITools, type ToolDef } from './tools.js';

const TOOLS: ToolDef[] = [
  {
    name: 'repo_read',
    description: 'Read a source file with line numbers.',
    input_schema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] },
  },
  {
    name: 'repo_write',
    description:
      'Overwrite a file with new full contents. Read it first. Keep the change minimal and ' +
      'scoped to the diagnosed bug — this is not a refactor.',
    input_schema: {
      type: 'object',
      properties: { file: { type: 'string' }, content: { type: 'string' } },
      required: ['file', 'content'],
    },
  },
  {
    name: 'conclude',
    description: 'Report the fix is complete.',
    input_schema: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'One paragraph: what changed and why.' } },
      required: ['summary'],
    },
  },
];

const OPENAI_TOOLS = toOpenAITools(TOOLS);

const SYSTEM = `You are patching a diagnosed bug in a real codebase. You were given the exact
cause, file, and suggested change by a prior investigation — do not re-diagnose, implement it.

Rules:
  - Read the file before writing it. Never write a file you have not read in this session.
  - Keep the change minimal and scoped to the diagnosed bug. No refactors, no unrelated cleanup.
  - Preserve existing code style.
  - Call conclude with a one-paragraph summary when done.`;

export interface ImplementResult {
  summary: string;
  filesChanged: string[];
  prUrl: string | null;
}

export async function implementFix(
  diagnosis: Diagnosis,
  repo: RepoClient,
  github: GitHubClient,
): Promise<ImplementResult> {
  const written = new Map<string, string>();

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `Diagnosis:
cause: ${diagnosis.cause}
file: ${diagnosis.file ?? 'unknown'}
lines: ${diagnosis.lines ? diagnosis.lines.join('-') : 'unknown'}
suggested change: ${diagnosis.suggested_change}

Implement this fix.`,
    },
  ];

  let summary = '';

  for (let i = 0; i < CONFIG.implement.maxSteps; i++) {
    const { res } = await createChatCompletion({
      model: CONFIG.models.implement,
      max_tokens: CONFIG.agent.maxTokens,
      messages,
      tools: OPENAI_TOOLS,
    });

    const message = res?.choices?.[0]?.message;
    if (!message) break;
    messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls });

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) break;

    let done = false;
    for (const call of calls) {
      if (call.type !== 'function') continue;
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        messages.push({ role: 'tool', tool_call_id: call.id, content: 'Error: invalid JSON arguments.' });
        continue;
      }

      let text: string;
      try {
        if (call.function.name === 'repo_read') {
          text = await repo.read(String(input.file));
        } else if (call.function.name === 'repo_write') {
          const file = String(input.file);
          const content = String(input.content);
          written.set(file, content);
          text = `Wrote ${file} (${content.length} chars). Not yet committed.`;
        } else if (call.function.name === 'conclude') {
          summary = String(input.summary ?? '');
          text = 'Recorded.';
          done = true;
        } else {
          text = `Unknown tool: ${call.function.name}`;
        }
      } catch (err) {
        text = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      messages.push({ role: 'tool', tool_call_id: call.id, content: text });
    }

    if (done) break;
  }

  const files = [...written.entries()].map(([path, content]) => ({ path, content }));
  let prUrl: string | null = null;

  if (files.length > 0 && github.available()) {
    prUrl = await github.commitAndOpenPr({
      branch: `bisect/fix-${Date.now()}`,
      title: `Fix: ${diagnosis.cause}`.slice(0, 72),
      body: `${summary}\n\n---\nOpened automatically by bisect after Slack approval.\n\n` +
        `**Diagnosis:** ${diagnosis.cause}\n**Confidence:** ${diagnosis.confidence.toFixed(2)}`,
      files,
    });
  } else if (files.length > 0) {
    // Local REPO_PATH dev mode — apply directly, no PR machinery available.
    for (const f of files) await repo.write(f.path, f.content);
  }

  return { summary, filesChanged: [...written.keys()], prUrl };
}
