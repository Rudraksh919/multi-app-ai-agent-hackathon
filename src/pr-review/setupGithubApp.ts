/**
 * One-time interactive setup for a real GitHub App identity, using GitHub's "manifest flow"
 * so nothing has to be typed into GitHub's UI by hand — this script builds the manifest,
 * you click one "Create GitHub App" confirmation button on github.com (that's the one step
 * that has to be you: creating an App is a real account-authorization grant, not something
 * this script does on your behalf), and everything after that — the private key, the
 * webhook secret, finding the installation — is captured and written to .env automatically.
 *
 * Run with: npx tsx src/pr-review/setupGithubApp.ts
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFile, appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { signAppJwt, listInstallations } from '../clients/githubApp.js';

const PORT = 4323;
const CALLBACK_URL = `http://localhost:${PORT}/callback`;
const KEY_PATH = resolve('.github-app-key.pem');
const ENV_PATH = resolve('.env');

function manifestHtml(state: string): string {
  const manifest = {
    name: `bisect-review-${randomBytes(3).toString('hex')}`, // app names are global across all of GitHub — must be unique
    url: 'https://github.com/Rudraksh919/multi-app-ai-agent-hackathon',
    redirect_url: CALLBACK_URL,
    // The manifest requires *some* hook url (can't be blank) but it also can't be localhost
    // (not publicly reachable). Since active:false, GitHub never actually delivers anything
    // here — this is just a placeholder to satisfy validation. Swap it for a real endpoint
    // later from the App's own settings once there's a public URL for it.
    hook_attributes: { url: 'https://example.com/webhook', active: false },
    public: false,
    default_permissions: {
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      metadata: 'read',
    },
    default_events: ['pull_request', 'issue_comment'],
  };

  return `<!doctype html><html><body>
<p>Redirecting to GitHub to create the app…</p>
<form id="f" method="post" action="https://github.com/settings/apps/new?state=${encodeURIComponent(state)}">
  <input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, '&#39;')}'>
</form>
<script>document.getElementById('f').submit();</script>
</body></html>`;
}

async function saveEnvVar(key: string, value: string): Promise<void> {
  const existing = await readFile(ENV_PATH, 'utf8').catch(() => '');
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=`, 'm').test(existing)) {
    await writeFile(ENV_PATH, existing.replace(new RegExp(`^${key}=.*$`, 'm'), line), 'utf8');
  } else {
    await appendFile(ENV_PATH, `${existing.endsWith('\n') || !existing ? '' : '\n'}${line}\n`, 'utf8');
  }
}

async function waitForInstallation(appJwt: string, appId: string): Promise<void> {
  console.log('\nWaiting for you to install the app (up to 3 minutes)…');
  const deadline = Date.now() + 3 * 60_000;
  while (Date.now() < deadline) {
    const installs = await listInstallations(appJwt).catch(() => []);
    if (installs.length > 0) {
      const install = installs[0];
      if (!install) break;
      await saveEnvVar('GITHUB_APP_INSTALLATION_ID', String(install.id));
      console.log(`\nInstalled on: ${install.account?.login ?? '(unknown account)'}`);
      console.log('GITHUB_APP_INSTALLATION_ID written to .env — setup complete.');
      console.log(`App id ${appId} + private key at ${KEY_PATH} are also in .env now.`);
      return;
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  console.log(
    '\nTimed out waiting for an installation. Install the app manually from its GitHub page, then re-run ' +
      'this script — it will pick up the existing app and just complete the installation-id step ' +
      '(delete GITHUB_APP_ID from .env first if you want to create a brand new app instead).',
  );
}

async function main(): Promise<void> {
  const state = randomBytes(16).toString('hex');

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(manifestHtml(state));
        return;
      }

      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');
        if (!code || returnedState !== state) {
          res.writeHead(400).end('missing/invalid code or state');
          return;
        }

        try {
          const convRes = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
            method: 'POST',
            headers: { Accept: 'application/vnd.github+json' },
          });
          if (!convRes.ok) throw new Error(`conversion failed: ${convRes.status} ${await convRes.text()}`);
          const app = (await convRes.json()) as { id: number; pem: string; webhook_secret: string; slug: string };

          await writeFile(KEY_PATH, app.pem, 'utf8');
          await saveEnvVar('GITHUB_APP_ID', String(app.id));
          await saveEnvVar('GITHUB_APP_PRIVATE_KEY_PATH', KEY_PATH);
          if (app.webhook_secret) await saveEnvVar('GITHUB_WEBHOOK_SECRET', app.webhook_secret);

          res.writeHead(200, { 'Content-Type': 'text/html' }).end(
            `<html><body style="font-family:sans-serif;padding:2rem">
              <h2>App "${app.slug}" created.</h2>
              <p>One more step — install it on the repo(s) it should review:</p>
              <p><a href="https://github.com/apps/${app.slug}/installations/new" target="_blank">
                Install ${app.slug}</a></p>
              <p>You can close this tab after clicking Install — the terminal will pick it up automatically.</p>
            </body></html>`,
          );

          console.log(`\nApp created: ${app.slug} (id ${app.id}). Private key + webhook secret saved to .env.`);
          const jwt = signAppJwt(String(app.id), app.pem);
          await waitForInstallation(jwt, String(app.id));
          server.close();
          process.exit(0);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          res.writeHead(500).end(`conversion failed: ${msg}`);
          console.error('conversion failed:', msg);
        }
        return;
      }

      res.writeHead(404).end();
    })();
  });

  server.listen(PORT, () => {
    console.log(`Open this in a browser you're logged into GitHub with:\n\n  http://localhost:${PORT}\n`);
  });
}

main();
