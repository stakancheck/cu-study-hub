import { getDb } from "./db";

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export function notify(title: string, body: string, opts: { sound?: boolean; url?: string } = {}) {
  if (process.platform !== "darwin") return console.log(`[notify] ${title}: ${body}`);
  // terminal-notifier supports click-to-open; fall back to plain AppleScript notification.
  const tn = Bun.which("terminal-notifier");
  if (tn) {
    const args = [tn, "-title", "Учебный штаб", "-subtitle", title, "-message", body, "-group", title];
    if (opts.url) args.push("-open", opts.url);
    if (opts.sound) args.push("-sound", "default");
    Bun.spawnSync(args);
    return;
  }
  const script = `display notification "${esc(body)}" with title "Учебный штаб" subtitle "${esc(title)}"${opts.sound ? ' sound name "Glass"' : ""}`;
  Bun.spawnSync(["osascript", "-e", script]);
}

/** Fire once per key. */
export function notifyOnce(key: string, title: string, body: string, opts?: Parameters<typeof notify>[2]) {
  const db = getDb();
  const seen = db.query("SELECT 1 FROM notifications WHERE key = ?").get(key);
  if (seen) return false;
  db.query("INSERT INTO notifications(key) VALUES(?)").run(key);
  notify(title, body, opts);
  return true;
}
