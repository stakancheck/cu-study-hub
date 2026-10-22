import index from "./index.html";
import { type CaldavConfig, KEYCHAIN_DEFAULT, loadConfig, saveConfig } from "../config";
import { hasKeychainPassword, listCalendars, setKeychainPassword } from "../connectors/caldav";
import { markAttendance } from "../core/attendance";
import { addManualCard, buildBoard, moveCard, updateCard } from "../core/board";
import { getDb, getMeta } from "../core/db";
import { gradeAll, whatIf } from "../core/engine";
import { today, week } from "../core/planner";
import { addPlanItem, deletePlanItem, planItems, semester, weekOf } from "../core/plan";
import { baseRules, loadRules, ruleByLmsId, ruleBySlug } from "../core/rules";
import { createWorkspace } from "../core/workspace";
import { latestRun, openChat, refreshRuns, startDraft } from "../core/agent";
import { courseDir, slugify, syncCourseMaterials, writeCourseRoot } from "../core/materials";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { workItems } from "../core/engine";
import { runReminders, syncAll } from "../sync";

const cfg = loadConfig();
const ok = (data: unknown = { ok: true }) => Response.json(data);
const fail = (e: unknown, status = 500) => Response.json({ error: (e as Error).message ?? String(e) }, { status });

let syncing: Promise<unknown> | null = null;
function doSync() {
  syncing ??= syncAll().finally(() => (syncing = null));
  return syncing;
}

function coursePage(slug: string) {
  const rule = ruleBySlug(slug);
  if (!rule) return null;
  const g = gradeAll().find((x) => x.id === rule.lms_id);
  const base = courseDir(rule.lms_id);
  const themes = (getDb()
    .query("SELECT id, name, ord, publish_date FROM themes WHERE course_id = ? ORDER BY ord")
    .all(rule.lms_id) as any[]).map((t) => {
      const stem = `${String(t.ord).padStart(2, "0")}-${slugify(t.name)}`;
      const file = join(base, `${stem}.md`), attDir = join(base, "attachments", stem);
      return { ...t, file, attDir, hasFile: existsSync(file), attCount: existsSync(attDir) ? readdirSync(attDir).filter((f) => !f.startsWith(".")).length : 0 };
    });
  const { cards } = buildBoard();
  return {
    grade: g,
    rule: { slug: rule.slug, title: rule.title, assessment: rule.assessment, rounding: rule.rounding },
    themes,
    cards: cards.filter((c) => c.courseId === rule.lms_id),
    settings: courseSettings(rule.lms_id),
    materials: { dir: courseDir(rule.lms_id), syncedAt: getMeta(`materialsSyncedAt:${rule.lms_id}`) },
  };
}

/** Defaults (rules + LMS) and the user's override for one course. */
function courseSettings(id: number) {
  const b = baseRules().find((r) => r.lms_id === id)!;
  const row = getDb().query("SELECT name, syllabus_url, time_url FROM courses WHERE id = ?").get(id) as any;
  return {
    id, lmsName: row?.name ?? null,
    defaults: { title: b.title, short: b.short, color: b.color, syllabusUrl: row?.syllabus_url ?? null, timeUrl: row?.time_url ?? null, calendarMatch: b.calendar?.match ?? [] },
    override: loadConfig().courses[String(id)] ?? {},
  };
}

/** Opens a path in Finder (or the default app for files); only inside the study folder. */
function openInFinder(path: string, reveal = false) {
  const root = resolve(loadConfig().workspaceRoot);
  const p = resolve(path);
  if (p !== root && !p.startsWith(root + sep)) throw new Error("Можно открывать только то, что лежит в папке учёбы");
  if (!existsSync(p)) throw new Error("Такой папки ещё нет: обнови материалы курса");
  Bun.spawn(reveal ? ["open", "-R", p] : ["open", p]);
}

function normCaldav(c: Partial<CaldavConfig>): CaldavConfig {
  return {
    url: (c.url || "https://caldav.yandex.ru").trim(),
    username: String(c.username ?? "").trim(),
    keychainService: c.keychainService || KEYCHAIN_DEFAULT,
    calendars: Array.isArray(c.calendars) ? c.calendars.map(String) : [],
  };
}

const s2 = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Keep only fields that differ from rules defaults, so config.yaml stays small and readable. */
function cleanCourses(input: Record<string, any>) {
  const out: Record<string, unknown> = {};
  for (const [id, o] of Object.entries(input)) {
    const base = baseRules().find((r) => String(r.lms_id) === id);
    const c: Record<string, unknown> = {};
    const title = s2(o.title), short = s2(o.short), color = s2(o.color);
    if (title && title !== base?.title) c.title = title;
    if (short && short !== base?.short) c.short = short;
    if (color && color !== base?.color) c.color = color;
    if (s2(o.syllabusUrl)) c.syllabusUrl = s2(o.syllabusUrl);
    if (s2(o.timeUrl)) c.timeUrl = s2(o.timeUrl);
    const links = (o.links ?? []).filter((l: any) => s2(l?.url)).map((l: any) => ({ label: s2(l.label) ?? s2(l.url), url: s2(l.url) }));
    if (links.length) c.links = links;
    const cm = (o.calendarMatch ?? []).map(s2).filter(Boolean);
    if (cm.length) c.calendarMatch = cm;
    if (Object.keys(c).length) out[id] = c;
  }
  return out;
}

function settingsPayload() {
  const c = loadConfig();
  const data = {
    general: { semesterStart: semester().start, workspaceRoot: c.workspaceRoot, syncIntervalMin: c.syncIntervalMin, reminders: c.reminders, webPort: c.webPort },
    caldav: c.caldav ? { ...c.caldav, hasPassword: hasKeychainPassword(c.caldav.keychainService, c.caldav.username) } : null,
  };
  return data;
}

const server = Bun.serve({
  port: cfg.webPort,
  hostname: "127.0.0.1",
  development: process.env.NODE_ENV !== "production" && !process.env.CU_DAEMON,
  routes: {
    "/": index,
    "/api/state": () => {
      const grades = gradeAll();
      return ok({
        today: today(),
        grades,
        board: buildBoard(grades),
        meta: { week: weekOf(), weeks: semester().weeks, lateDaysBalance: Number(getMeta("lateDaysBalance")) || null, lmsSyncedAt: getMeta("lmsSyncedAt"), calSyncedAt: getMeta("calSyncedAt"), lastSync: JSON.parse(getMeta("lastSyncReport") ?? "null"), syncing: !!syncing, calendarConfigured: !!loadConfig().caldav },
      });
    },
    "/api/week": () => ok(week()),
    "/api/course/:slug": (req) => {
      const p = coursePage(req.params.slug);
      return p ? ok(p) : fail(new Error("not found"), 404);
    },
    "/api/course/:slug/settings": {
      PUT: async (req) => {
        const rule = ruleBySlug(req.params.slug);
        if (!rule) return fail(new Error("not found"), 404);
        const id = String(rule.lms_id);
        const courses = { ...loadConfig().courses };
        delete courses[id];
        Object.assign(courses, cleanCourses({ [id]: await req.json() }));
        saveConfig({ courses });
        return ok(courseSettings(rule.lms_id));
      },
    },
    "/api/agent/draft": {
      POST: async (req) => {
        try {
          const { id } = await req.json();
          const run = await startDraft(id);
          moveCard(id, "doing");
          return ok(run);
        } catch (e) {
          return fail(e, 400);
        }
      },
    },
    "/api/agent/run/:id": (req) => ok(latestRun(decodeURIComponent(req.params.id))),
    "/api/chat": {
      POST: async (req) => {
        try {
          const { id, course, target, resume } = await req.json();
          if (course) {
            const rule = ruleBySlug(course);
            if (!rule) throw new Error("Курс не найден");
            const root = writeCourseRoot(rule.lms_id);
            openChat(root, target, { prompt: `Курс «${rule.title}». Прочитай CLAUDE.md и _course/README.md и коротко скажи, что сейчас важно по курсу.` });
            return ok({ dir: root });
          }
          const run = latestRun(id);
          const it = workItems().find((i) => i.id === id);
          const dir = run?.dir ?? (await createWorkspace(id)).dir;
          openChat(dir, target, {
            resume: resume ? run?.session_id : null,
            prompt: it ? `Задача «${it.title}». Прочитай CLAUDE.md, BRIEF.md и MATERIALS.md, кратко скажи, что сдать и к какому сроку, и предложи план.` : undefined,
          });
          return ok({ dir });
        } catch (e) {
          return fail(e, 400);
        }
      },
    },
    "/api/course/:slug/materials": {
      POST: async (req) => {
        const rule = ruleBySlug(req.params.slug);
        if (!rule) return fail(new Error("not found"), 404);
        try {
          return ok(await syncCourseMaterials(rule.lms_id));
        } catch (e) {
          return fail(e);
        }
      },
    },
    "/api/settings": {
      GET: () => ok(settingsPayload()),
      PUT: async (req) => {
        const body = await req.json();
        const patch: Record<string, unknown> = {};
        if (body.general) {
          const g = body.general;
          if (g.workspaceRoot) patch.workspaceRoot = String(g.workspaceRoot);
          if (g.syncIntervalMin) patch.syncIntervalMin = Math.max(5, Number(g.syncIntervalMin));
          if (g.reminders) patch.reminders = g.reminders;
          if (g.semesterStart !== undefined) patch.semesterStart = /^\d{4}-\d{2}-\d{2}$/.test(g.semesterStart) ? g.semesterStart : null;
        }
        if (body.caldav !== undefined) patch.caldav = body.caldav === null ? null : normCaldav(body.caldav);
        saveConfig(patch);
        return ok(settingsPayload());
      },
    },
    "/api/settings/caldav-password": {
      POST: async (req) => {
        try {
          const { username, password, keychainService } = await req.json();
          if (!username || !password) throw new Error("Нужны логин и пароль приложения");
          setKeychainPassword(keychainService || KEYCHAIN_DEFAULT, username, password);
          return ok();
        } catch (e) {
          return fail(e, 400);
        }
      },
    },
    "/api/settings/caldav-test": {
      POST: async (req) => {
        try {
          return ok({ calendars: await listCalendars(normCaldav(await req.json())) });
        } catch (e) {
          return fail(e, 400);
        }
      },
    },
    "/api/plan": {
      GET: (req) => {
        const u = new URL(req.url);
        const from = u.searchParams.get("from") ?? "2026-08-01";
        const to = u.searchParams.get("to") ?? "2027-08-31";
        return ok({ semester: semester(), items: planItems(from, to) });
      },
      POST: async (req) => {
        const b = await req.json();
        if (!b.title || !b.from) return fail(new Error("Нужны название и дата"), 400);
        return ok({ id: addPlanItem({ title: String(b.title), kind: b.kind ?? "other", courseId: b.courseId ?? null, from: b.from, to: b.to || b.from, note: b.note }) });
      },
    },
    "/api/plan/:id": {
      DELETE: (req) => {
        const id = decodeURIComponent(req.params.id);
        if (!id.startsWith("manual:")) return fail(new Error("Удалять можно только свои отметки"), 400);
        deletePlanItem(id);
        return ok();
      },
    },
    "/api/sync": { POST: async () => ok(await doSync()) },
    "/api/whatif": {
      POST: async (req) => {
        const { course, assume, restAvg } = await req.json();
        const rule = ruleBySlug(course);
        const g = rule && gradeAll().find((x) => x.id === rule.lms_id);
        return g ? ok(whatIf(g, assume ?? {}, restAvg)) : fail(new Error("course not found"), 404);
      },
    },
    "/api/cards": {
      POST: async (req) => {
        const { title, courseId, due, col } = await req.json();
        return ok({ id: addManualCard(title, courseId ?? null, due ?? null, col ?? "inbox") });
      },
    },
    "/api/cards/:id/move": {
      POST: async (req) => {
        const { col, ord } = await req.json();
        try {
          moveCard(decodeURIComponent(req.params.id), col, ord);
        } catch (e) {
          return fail(e, 409);
        }
        return ok();
      },
    },
    "/api/cards/:id": {
      PATCH: async (req) => {
        updateCard(decodeURIComponent(req.params.id), await req.json());
        return ok();
      },
    },
    "/api/attendance": {
      POST: async (req) => {
        const { uid, attended, note } = await req.json();
        markAttendance(uid, attended, note);
        return ok();
      },
    },
    "/api/workspace": {
      POST: async (req) => {
        try {
          const { id } = await req.json();
          const res = await createWorkspace(id);
          moveCard(id, "doing");
          return ok(res);
        } catch (e) {
          return fail(e);
        }
      },
    },
    "/api/open": {
      POST: async (req) => {
        const { path, reveal } = await req.json();
        try {
          openInFinder(String(path ?? ""), !!reveal);
          return ok();
        } catch (e) {
          return fail(e, 400);
        }
      },
    },
    "/api/open-task": {
      POST: async (req) => {
        try {
          const { id } = await req.json();
          const it = workItems().find((i) => i.id === id);
          if (!it) throw new Error("Задача не найдена");
          const dir = join(loadConfig().workspaceRoot, ruleByLmsId(it.courseId)!.slug, slugify(it.title));
          if (!existsSync(dir)) await createWorkspace(id);
          openInFinder(dir);
          return ok({ dir });
        } catch (e) {
          return fail(e, 400);
        }
      },
    },
  },
  error: (e) => fail(e),
});

console.log(`Учебный штаб: http://localhost:${server.port}`);

// Background loop: sync every N minutes, reminders every 2 minutes.
const syncEveryMs = cfg.syncIntervalMin * 60_000;
const last = Date.parse(getMeta("lmsSyncedAt") ?? "0");
setTimeout(() => { doSync(); setInterval(doSync, syncEveryMs); }, Math.max(0, last + syncEveryMs - Date.now()));
const tick = () => {
  try { runReminders(); } catch (e) { console.error("reminders:", e); }
  try { refreshRuns(); } catch (e) { console.error("agent runs:", e); }
};
tick();
setInterval(tick, 2 * 60_000);
