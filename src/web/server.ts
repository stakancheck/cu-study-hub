import index from "./index.html";
import { loadConfig } from "../config";
import { markAttendance } from "../core/attendance";
import { addManualCard, buildBoard, moveCard, updateCard } from "../core/board";
import { getDb, getMeta } from "../core/db";
import { gradeAll, whatIf } from "../core/engine";
import { today, week } from "../core/planner";
import { ruleBySlug } from "../core/rules";
import { createWorkspace } from "../core/workspace";
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
  const themes = getDb()
    .query("SELECT id, name, ord, publish_date FROM themes WHERE course_id = ? ORDER BY ord")
    .all(rule.lms_id);
  const { cards } = buildBoard();
  return { grade: g, rule: { slug: rule.slug, title: rule.title, assessment: rule.assessment, rounding: rule.rounding, ai: rule.ai_policy }, themes, cards: cards.filter((c) => c.courseId === rule.lms_id) };
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
        meta: { lateDaysBalance: Number(getMeta("lateDaysBalance")) || null, lmsSyncedAt: getMeta("lmsSyncedAt"), calSyncedAt: getMeta("calSyncedAt"), lastSync: JSON.parse(getMeta("lastSyncReport") ?? "null"), syncing: !!syncing, calendarConfigured: !!cfg.caldav },
      });
    },
    "/api/week": () => ok(week()),
    "/api/course/:slug": (req) => {
      const p = coursePage(req.params.slug);
      return p ? ok(p) : fail(new Error("not found"), 404);
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
        moveCard(decodeURIComponent(req.params.id), col, ord);
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
        const { path } = await req.json();
        if (typeof path === "string" && path.startsWith(cfg.workspaceRoot)) Bun.spawn(["open", path]);
        return ok();
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
const tick = () => { try { runReminders(); } catch (e) { console.error("reminders:", e); } };
tick();
setInterval(tick, 2 * 60_000);
