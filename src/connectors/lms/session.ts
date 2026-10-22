import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { COOKIES_FILE, LMS_ORIGIN, PROFILE_DIR } from "../../config";

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
}

export class AuthError extends Error {
  constructor(msg = "Сессия LMS истекла: запусти `bun cu login`") {
    super(msg);
  }
}

export function loadCookies(): StoredCookie[] {
  if (!existsSync(COOKIES_FILE)) return [];
  return JSON.parse(readFileSync(COOKIES_FILE, "utf8"));
}

export function cookieHeader(): string {
  const now = Date.now() / 1000;
  return loadCookies()
    .filter((c) => "my.centraluniversity.ru".endsWith(c.domain.replace(/^\./, "")))
    .filter((c) => c.expires <= 0 || c.expires > now)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

async function launch(headless: boolean) {
  const { chromium } = await import("playwright");
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: { width: 1200, height: 860 },
    locale: "ru-RU",
  });
}

async function isAuthed(page: import("playwright").Page): Promise<boolean> {
  return page.evaluate(async () => (await fetch("/api/account/me")).ok).catch(() => false);
}

async function saveCookies(ctx: import("playwright").BrowserContext) {
  const cookies = await ctx.cookies(LMS_ORIGIN);
  writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2), { mode: 0o600 });
}

/** Opens a visible browser; the user signs in by hand. Credentials never pass through this code. */
export async function interactiveLogin(timeoutMin = 10): Promise<void> {
  const ctx = await launch(false);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(`${LMS_ORIGIN}/learn/courses/view/actual/all`);
  const deadline = Date.now() + timeoutMin * 60_000;
  try {
    while (Date.now() < deadline) {
      if (page.url().startsWith(LMS_ORIGIN) && (await isAuthed(page))) {
        await saveCookies(ctx);
        return;
      }
      await page.waitForTimeout(1500);
    }
    throw new Error("Не дождался входа в LMS");
  } finally {
    await ctx.close();
  }
}

/** Silent refresh: reopen the persistent profile headless and let SSO re-issue the session cookie. */
export async function silentRefresh(): Promise<boolean> {
  const ctx = await launch(true);
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`${LMS_ORIGIN}/learn/courses/view/actual/all`, { waitUntil: "networkidle", timeout: 45_000 });
    if (page.url().startsWith(LMS_ORIGIN) && (await isAuthed(page))) {
      await saveCookies(ctx);
      return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    await ctx.close();
  }
}
