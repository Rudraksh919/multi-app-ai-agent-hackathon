import { readFile } from 'node:fs/promises';
import { env } from '../config.js';
import { signAppJwt, createInstallationToken } from './githubApp.js';

let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * The token every GitHub API call and git invocation authenticates with — an App
 * installation token when the App is configured (so calls show up as "bisect[bot]", not a
 * human's PAT), otherwise the plain GITHUB_TOKEN. Installation tokens expire in ~1 hour;
 * cached and refreshed a minute before expiry rather than minted per call.
 */
export async function resolveGithubToken(): Promise<string | null> {
  const appId = env.githubAppId();
  const keyPath = env.githubAppPrivateKeyPath();
  const installationId = env.githubAppInstallationId();

  if (!appId || !keyPath || !installationId) {
    return env.githubToken();
  }

  if (cachedToken && cachedToken.expiresAt - Date.now() > 60_000) {
    return cachedToken.token;
  }

  const pem = await readFile(keyPath, 'utf8');
  const jwt = signAppJwt(appId, pem);
  const { token, expiresAt } = await createInstallationToken(jwt, installationId);
  cachedToken = { token, expiresAt };
  return token;
}

/** True if either auth path (App or PAT) is actually configured. */
export function githubAuthConfigured(): boolean {
  const hasApp = Boolean(env.githubAppId() && env.githubAppPrivateKeyPath() && env.githubAppInstallationId());
  return hasApp || Boolean(env.githubToken());
}
