import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, loadConfig } from "./config";
import { syncCalendar } from "./connectors/caldav";
import { syncLms } from "./connectors/lms/sync";
import { AuthError } from "./connectors/lms/session";
import { classes } from "./core/attendance";
import { getDb, setMeta } from "./core/db";
import { gradeAll, openItems, workItems } from "./core/engine";
import { notify, notifyOnce } from "./core/notify";
import { digestMarkdown, today } from "./core/planner";

export interface SyncReport { lms?: unknown; calendar?: unknown; syllabus?: unknown; errors: string[] }

export async function syncAll(opts: { quiet?: boolean } = {}): Promise<SyncReport> {
  const report: SyncReport = { errors: [] };
  try {
    report.lms = await syncLms();
  } catch (e) {
    report.errors.push(`LMS: ${(e as Error).message}`);
    if (e instanceof AuthError && !opts.quiet) notifyOnce(`auth:${new Date().toDateString()}`, "Нужно войти в LMS", "Запусти `bun cu login`");
  }
  if (loadConfig().caldav) {
    try {
      report.calendar = await syncCalendar();
    } catch (e) {
      report.errors.push(`Календарь: ${(e as Error).message}`);
    }
  }
  try {
    report.syllabus = await checkSyllabi();
  } catch (e) {
    report.errors.push(`Силлабусы: ${(e as Error).message}`);
  }
  setMeta("lastSyncReport", JSON.stringify(report));
  return report;
}

const mirror = (url: string) => url.replace("https://note.cu.ru/", "https://cuhandlog.ru/");

/** Detects syllabus edits by hashing the mirrored page text. */
export async function checkSyllabi() {
  const db = getDb();
  const rows = db.query("SELECT id, name, syllabus_url FROM courses WHERE tracked = 1 AND syllabus_url IS NOT NULL").all() as any[];
  const changed: string[] = [];
  for (const r of rows) {
    const url = mirror(r.syllabus_url);
    const html = await fetch(url).then((x) => (x.ok ? x.text() : null)).catch(() => null);
    if (!html) continue;
    const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html;
    const text = main.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const hash = new Bun.CryptoHasher("sha256").update(text).digest("hex");
    const prev = db.query("SELECT hash FROM syllabus_snapshots WHERE course_id = ?").get(r.id) as { hash: string } | null;
    if (prev && prev.hash !== hash) changed.push(r.name);
    db.query(`INSERT INTO syllabus_snapshots(course_id, url, hash, fetched_at, changed) VALUES(?,?,?,datetime('now'),?)
      ON CONFLICT(course_id) DO UPDATE SET hash=excluded.hash, fetched_at=excluded.fetched_at, changed=excluded.changed OR syllabus_snapshots.changed`)
      .run(r.id, url, hash, prev && prev.hash !== hash ? 1 : 0);
  }
  for (const c of changed) notifyOnce(`syllabus:${c}:${new Date().toDateString()}`, "Силлабус изменился", `${c}: проверь rules/*.yaml`);
  return { checked: rows.length, changed };
}

const HOUR = 3_600_000;

/** Called every few minutes by the daemon. */
export function runReminders() {
  const cfg = loadConfig();
  const now = new Date();
  const grades = gradeAll();

  const soon = classes(now.toISOString(), new Date(now.getTime() + cfg.reminders.beforeClassMin * 60_000).toISOString(), grades);
  for (const c of soon) {
    if (c.verdict !== "must" && c.verdict !== "should") continue;
    const t = new Date(c.start).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    notifyOnce(`class:${c.uid}`, `${c.course}: пара в ${t}`, `${c.verdict === "must" ? "Обязательно" : "Желательно"}. ${c.reason}${c.location ? ` · ${c.location}` : ""}`, { sound: c.verdict === "must" });
  }

  for (const it of openItems(workItems(grades))) {
    if (it.hoursLeft == null || it.hoursLeft < 0) continue;
    if (it.hoursLeft <= 3) notifyOnce(`due3:${it.id}`, `${it.course}: дедлайн через ${Math.max(1, Math.round(it.hoursLeft))} ч`, `${it.title}${it.lateDaysAllowed ? " · можно взять LD" : ""}`, { sound: true });
    else if (it.hoursLeft <= 24) notifyOnce(`due24:${it.id}`, `${it.course}: дедлайн завтра`, it.title);
  }

  const [hh, mm] = cfg.reminders.digestAt.split(":").map(Number);
  if (now.getHours() > hh || (now.getHours() === hh && now.getMinutes() >= mm)) {
    const key = `digest:${now.toDateString()}`;
    if (!getDb().query("SELECT 1 FROM notifications WHERE key = ?").get(key)) {
      const t = today();
      writeFileSync(join(DATA_DIR, "digest.md"), digestMarkdown(t));
      const must = t.classes.filter((c) => c.verdict === "must").length;
      notifyOnce(key, "Утренний дайджест", `Пар: ${t.classes.length} (обязательных ${must}). Главное: ${t.top[0] ? `${t.top[0].course} · ${t.top[0].title}` : "нет срочного"}`, { url: `http://localhost:${cfg.webPort}/` });
    }
  }

  const [wd, wt] = cfg.reminders.weeklyReviewAt.split(" ");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const [wh, wm] = wt.split(":").map(Number);
  if (days[now.getDay()] === wd && (now.getHours() > wh || (now.getHours() === wh && now.getMinutes() >= wm)))
    notifyOnce(`weekly:${now.toDateString()}`, "Ревью недели", "Открой доску: что сдано, что потеряно, план на неделю (`/week` в Claude)", { url: `http://localhost:${cfg.webPort}/#week` });

  // «Был на паре?»: через 15 минут после конца пары, где ставят баллы
  const ended = classes(new Date(now.getTime() - 3 * HOUR).toISOString(), now.toISOString(), grades)
    .filter((c) => c.courseId && c.attended == null && new Date(c.end).getTime() + 15 * 60_000 < now.getTime());
  for (const c of ended)
    notifyOnce(`after:${c.uid}`, `${c.course}: как прошла пара?`, "Отметь посещение и что задали: на доске или `/after` в Claude", { url: `http://localhost:${cfg.webPort}/` });
}

export { notify };
