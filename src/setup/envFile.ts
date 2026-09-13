import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const ENV_PATH = resolve('.env');

/** Sets KEY=value in .env, replacing an existing line for that key in place or appending a
 * new one — never clobbers the rest of the file, so this is safe to call repeatedly (re-running
 * setup, or setupGithubApp.ts filling in the App-specific keys afterward). */
export async function upsertEnvVar(key: string, value: string): Promise<void> {
  const existing = await readFile(ENV_PATH, 'utf8').catch(() => '');
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=`, 'm').test(existing)) {
    await writeFile(ENV_PATH, existing.replace(new RegExp(`^${key}=.*$`, 'm'), line), 'utf8');
  } else {
    await appendFile(ENV_PATH, `${existing.endsWith('\n') || !existing ? '' : '\n'}${line}\n`, 'utf8');
  }
}

export async function readEnvVar(key: string): Promise<string | null> {
  const existing = await readFile(ENV_PATH, 'utf8').catch(() => '');
  const m = existing.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m?.[1] || null;
}
