import { createSign } from 'node:crypto';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A GitHub App authenticates as itself with a short-lived RS256 JWT signed by its private
 * key — hand-rolled here rather than pulling in a JWT library for three lines of crypto. */
export function signAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  // iat 60s in the past absorbs clock drift between this machine and GitHub's; GitHub caps exp at 10 minutes.
  const payload = { iat: now - 60, exp: now + 540, iss: appId };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

export interface AppInstallation {
  id: number;
  account: { login: string } | null;
}

export async function listInstallations(appJwt: string): Promise<AppInstallation[]> {
  const res = await fetch('https://api.github.com/app/installations', {
    headers: { Authorization: `Bearer ${appJwt}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`list installations -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<AppInstallation[]>;
}

/** An installation access token — scoped to whatever repos the App was installed on, and
 * what it does when it calls the API (comments, clones, etc. all show up as the App). */
export async function createInstallationToken(
  appJwt: string,
  installationId: string,
): Promise<{ token: string; expiresAt: number }> {
  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${appJwt}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`create installation token -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { token: string; expires_at: string };
  return { token: json.token, expiresAt: new Date(json.expires_at).getTime() };
}
