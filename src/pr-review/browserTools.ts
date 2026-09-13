import { chromium, type Browser, type Page } from 'playwright';

export interface BrowserSession {
  page: Page;
  close(): Promise<void>;
}

export async function openBrowserSession(baseUrl: string): Promise<BrowserSession> {
  const browser: Browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  return {
    page,
    async close() {
      await browser.close();
    },
  };
}

/**
 * Click something by whatever a human would identify it by — visible text, then role+name,
 * then a raw CSS selector as a last resort. The agent doesn't know the DOM, only what it
 * can read off the page, so text-first matching is what makes this usable.
 */
export async function clickTarget(page: Page, target: string): Promise<string> {
  const strategies: (() => Promise<boolean>)[] = [
    async () => {
      const loc = page.getByRole('button', { name: target, exact: false });
      if ((await loc.count()) === 0) return false;
      await loc.first().click();
      return true;
    },
    async () => {
      const loc = page.getByRole('link', { name: target, exact: false });
      if ((await loc.count()) === 0) return false;
      await loc.first().click();
      return true;
    },
    async () => {
      const loc = page.getByText(target, { exact: false });
      if ((await loc.count()) === 0) return false;
      await loc.first().click();
      return true;
    },
    async () => {
      const loc = page.locator(target);
      if ((await loc.count()) === 0) return false;
      await loc.first().click();
      return true;
    },
  ];

  for (const attempt of strategies) {
    try {
      if (await attempt()) return `Clicked "${target}".`;
    } catch {
      // fall through to the next strategy
    }
  }
  throw new Error(`Could not find a clickable element matching "${target}".`);
}

/** Fill an input, identified by placeholder, label, name, or a raw CSS selector. */
export async function typeInto(page: Page, target: string, text: string): Promise<string> {
  const strategies: (() => Promise<boolean>)[] = [
    async () => {
      const loc = page.getByPlaceholder(target, { exact: false });
      if ((await loc.count()) === 0) return false;
      await loc.first().fill(text);
      return true;
    },
    async () => {
      const loc = page.getByLabel(target, { exact: false });
      if ((await loc.count()) === 0) return false;
      await loc.first().fill(text);
      return true;
    },
    async () => {
      const loc = page.locator(`[name="${target}"]`);
      if ((await loc.count()) === 0) return false;
      await loc.first().fill(text);
      return true;
    },
    async () => {
      const loc = page.locator(target);
      if ((await loc.count()) === 0) return false;
      await loc.first().fill(text);
      return true;
    },
  ];

  for (const attempt of strategies) {
    try {
      if (await attempt()) return `Typed into "${target}".`;
    } catch {
      // fall through to the next strategy
    }
  }
  throw new Error(`Could not find an input matching "${target}".`);
}

/** What a human would see: the visible text, plus what's clickable and fillable right now. */
export async function readPage(page: Page): Promise<string> {
  const url = page.url();
  const bodyText = await page.locator('body').innerText().catch(() => '(could not read body text)');

  const buttons = await page
    .locator('button, [role="button"], a[href]')
    .allInnerTexts()
    .catch(() => [] as string[]);
  const uniqueButtons = [...new Set(buttons.map((b) => b.trim()).filter(Boolean))].slice(0, 40);

  const inputs = await page
    .locator('input, textarea, select')
    .evaluateAll((els) =>
      els.map((e) => ({
        tag: e.tagName.toLowerCase(),
        type: e.getAttribute('type'),
        name: e.getAttribute('name'),
        placeholder: e.getAttribute('placeholder'),
      })),
    )
    .catch(() => [] as unknown[]);

  const clamp = (s: string, max = 3000) => (s.length <= max ? s : `${s.slice(0, max)}\n… truncated`);

  return [
    `url: ${url}`,
    '',
    'visible text:',
    clamp(bodyText),
    '',
    `clickable (${uniqueButtons.length}): ${uniqueButtons.join(' | ') || '(none found)'}`,
    '',
    `inputs: ${JSON.stringify(inputs)}`,
  ].join('\n');
}
