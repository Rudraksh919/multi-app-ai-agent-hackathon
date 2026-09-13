import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { CONFIG } from '../../config.js';
import type { SkillBootstrap, SkillReference } from '../types.js';
import type { RepoClient } from '../../types.js';
import { createChatCompletion, toOpenAITools, type ToolDef } from '../../clients/llm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Lives in bisect's own repo (this file's directory), not the target codebase's — it is
 * never written into the target repo's bisect-skills/. Only its output is.
 */
async function firstTimeMd(): Promise<string> {
  return readFile(join(__dirname, 'first-time.md'), 'utf8');
}

const TOOLS: ToolDef[] = [
  {
    name: 'repo_list',
    description: "List a directory in the codebase, repo-relative, '' for root.",
    input_schema: { type: 'object', properties: { dir: { type: 'string' } }, required: ['dir'] },
  },
  {
    name: 'repo_read',
    description: 'Read a source file with line numbers.',
    input_schema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] },
  },
  {
    name: 'repo_grep',
    description: 'Case-insensitive regex search across the codebase.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, glob: { type: 'string' } },
      required: ['pattern'],
    },
  },
  {
    name: 'submit_skills',
    description:
      'Submit the finished routing skill and reference docs. Call this exactly once, when done.',
    input_schema: {
      type: 'object',
      properties: {
        skill_md: { type: 'string', description: 'Contents of bisect-skills/skill.md — keep it short.' },
        references: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, content: { type: 'string' } },
            required: ['name', 'content'],
          },
          description: 'One entry per detected service; name becomes references/<name>.md',
        },
      },
      required: ['skill_md', 'references'],
    },
  },
];

const OPENAI_TOOLS = toOpenAITools(TOOLS);

export interface BootstrapStep {
  idx: number;
  tool: string;
  summary: string;
}

/**
 * Runs once per codebase (see src/skills/detect.ts): explores the repo, figures out which
 * observability services it actually uses, and produces the bisect-skills/ content. The
 * caller is responsible for writing the files and opening a PR — this function only
 * discovers and returns the content, it does not touch disk.
 */
export async function runBootstrap(
  repo: RepoClient,
  onStep?: (s: BootstrapStep) => void,
): Promise<SkillBootstrap> {
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: await firstTimeMd() },
    { role: 'user', content: 'Map this codebase and produce the bisect-skills/ content.' },
  ];

  let result: SkillBootstrap | null = null;
  let stepIdx = 0;

  for (let i = 0; i < CONFIG.skills.maxSteps; i++) {
    const { res } = await createChatCompletion({
      model: CONFIG.models.bootstrap,
      max_tokens: CONFIG.agent.maxTokens,
      messages,
      tools: OPENAI_TOOLS,
    });

    const message = res?.choices?.[0]?.message;
    if (!message) break;

    messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls });

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) break;

    for (const call of calls) {
      if (call.type !== 'function') continue;

      let input: Record<string, unknown>;
      try {
        input = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        messages.push({ role: 'tool', tool_call_id: call.id, content: 'Error: invalid JSON arguments.' });
        continue;
      }

      const text = await runBootstrapTool(call.function.name, input, repo);
      onStep?.({ idx: stepIdx++, tool: call.function.name, summary: text.slice(0, 160) });
      messages.push({ role: 'tool', tool_call_id: call.id, content: text });

      if (call.function.name === 'submit_skills') {
        const refs = Array.isArray(input.references) ? (input.references as SkillReference[]) : [];
        result = { skill_md: String(input.skill_md ?? ''), references: refs };
      }
    }

    if (result) break;
  }

  if (!result) {
    throw new Error('Bootstrap did not produce bisect-skills content within the step budget.');
  }
  return result;
}

async function runBootstrapTool(name: string, input: Record<string, unknown>, repo: RepoClient): Promise<string> {
  try {
    switch (name) {
      case 'repo_list':
        return (await repo.list(String(input.dir ?? ''))).join('\n') || '(empty)';
      case 'repo_read':
        return await repo.read(String(input.file));
      case 'repo_grep': {
        const hits = await repo.grep(String(input.pattern), input.glob ? String(input.glob) : undefined);
        return hits.length ? hits.join('\n') : 'No matches.';
      }
      case 'submit_skills':
        return 'Recorded.';
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
