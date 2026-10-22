import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { COOKIES_FILE, LMS_ORIGIN, PROFILE_DIR, ROOT } from "../../config";

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

/** Downloads Playwright's Chromium (~150 MB) on first use: `bun install` does not fetch browsers. */
export function installBrowser() {
  const r = Bun.spawnSync([process.execPath, "x", "playwright", "install", "chromium"], { cwd: ROOT, stdout: "inherit", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`Не удалось скачать Chromium: ${r.stderr.toString().trim().split("\n").pop()}`);
}

async function launch(headless: boolean, onInstall?: () => void) {
  const { chromium } = await import("playwright");
  const open = () => chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: { width: 1200, height: 860 },
    locale: "ru-RU",
  });
  try {
    return await open();
  } catch (e) {
    if (!/Executable doesn't exist|playwright install/i.test((e as Error).message)) throw e;
    onInstall?.();
    installBrowser();
    return open();
  }
}

async function isAuthed(page: import("playwright").Page): Promise<boolean> {
  return page.evaluate(async () => (await fetch("/api/account/me")).ok).catch(() => false);
}

async function saveCookies(ctx: import("playwright").BrowserContext) {
  const cookies = await ctx.cookies(LMS_ORIGIN);
  writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2), { mode: 0o600 });
}

/** Opens a visible browser; the user signs in by hand. Credentials never pass through this code. */
export async function interactiveLogin(timeoutMin = 10, onInstall?: () => void): Promise<void> {
  const ctx = await launch(false, onInstall);
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
