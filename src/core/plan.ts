import { loadConfig } from "../config";
import { getDb } from "./db";
import { loadAcademic, loadRules, norm, type PlanKind } from "./rules";

const DAY = 86_400_000;

/** Local calendar date as YYYY-MM-DD. */
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = (s: string) => {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
};

export function semester() {
  const a = loadAcademic();
  const start = loadConfig().semesterStart ?? a.semester_start;
  return { start, weeks: a.semester_weeks };
}

/** Academic week number for a date (1-based); null outside the teaching period. */
export function weekOf(date = new Date()): number | null {
  const { start, weeks } = semester();
  const diff = Math.floor((parse(ymd(date)).getTime() - parse(start).getTime()) / DAY);
  const n = Math.floor(diff / 7) + 1;
  return n >= 1 && n <= weeks + 1 ? n : null;
}

export function weekRange(n: number): { from: string; to: string } {
  const mon = new Date(parse(semester().start).getTime() + (n - 1) * 7 * DAY);
  return { from: ymd(mon), to: ymd(new Date(mon.getTime() + 6 * DAY)) };
}

export type ItemKind = PlanKind | "credit" | "session" | "holiday" | "retake" | "practice" | "deadline" | "onboarding" | "other";

export interface PlanItem {
  id: string;
  title: string;
  kind: ItemKind;
  courseId: number | null;
  course: string | null;
  color: string | null;
  from: string;
  to: string;
  /** approx = date known only to the week (syllabus / handbook schedule) */
  precision: "exact" | "week" | "period";
  source: "academic" | "syllabus" | "lms" | "manual";
  note?: string;
  state?: string;
  score?: number | null;
}

const overlaps = (a: { from: string; to: string }, from: string, to: string) => a.from <= to && a.to >= from;

export function planItems(from: string, to: string): PlanItem[] {
  const out: PlanItem[] = [];
  const academic = loadAcademic();

  academic.periods.forEach((p, i) => {
    if (p.kind === "classes") return;
    out.push({ id: `academic:${i}`, title: p.title, kind: p.kind as ItemKind, courseId: null, course: null, color: null, from: p.from, to: p.to, precision: "exact", source: "academic" });
  });

  const db = getDb();
  const tracked = new Set((db.query("SELECT id FROM courses WHERE tracked = 1").all() as { id: number }[]).map((r) => r.id));
  const semStart = semester().start;

  for (const r of loadRules()) {
    if (!tracked.has(r.lms_id) || r.graded === false) continue;
    // Exact checkpoints from LMS: projects, tests, exams that already have a deadline.
    const kindByAct = new Map(r.activities.map((a) => [norm(a.lms), a.kind]));
    const rows = db.query(`SELECT e.id, e.name, e.deadline, a.name AS act, t.state, t.score
      FROM exercises e JOIN activities a ON a.id = e.activity_id LEFT JOIN tasks t ON t.exercise_id = e.id
      WHERE e.course_id = ? AND e.deadline IS NOT NULL`).all(r.lms_id) as any[];
    const lmsItems: PlanItem[] = [];
    for (const x of rows) {
      const kind = kindByAct.get(norm(x.act));
      if (kind !== "project" && kind !== "test" && kind !== "exam") continue;
      if ((r.exclude_exercises ?? []).some((p) => x.name.includes(p))) continue;
      const d = ymd(new Date(x.deadline));
      lmsItems.push({ id: `lms:${x.id}`, title: x.name.trim(), kind, courseId: r.lms_id, course: r.short, color: r.color, from: d, to: d, precision: "exact", source: "lms", state: x.state ?? "notCreated", score: x.score });
    }
    out.push(...lmsItems);

    // Approximate checkpoints from the syllabus / handbook, unless LMS already pins one in that window.
    (r.plan ?? []).forEach((p, i) => {
      let range: { from: string; to: string } | null = null;
      let precision: PlanItem["precision"] = "week";
      if (p.week) range = weekRange(p.week);
      else if (p.weeks) range = { from: weekRange(p.weeks[0]).from, to: weekRange(p.weeks[1]).to };
      else if (p.period) {
        const per = academic.periods.find((x) => x.kind === p.period && x.to >= semStart);
        if (per) { range = { from: per.from, to: per.to }; precision = "period"; }
      }
      if (!range) return;
      const pinned = lmsItems.some((l) => l.kind === p.kind && overlaps(l, range!.from, range!.to));
      if (pinned) return;
      out.push({
        id: `syllabus:${r.lms_id}:${i}`, title: p.title, kind: p.kind, courseId: r.lms_id, course: r.short, color: r.color,
        ...range, precision, source: "syllabus", note: p.approx ? "Неделя оценена по структуре силлабуса" : undefined,
      });
    });
  }

  const manual = db.query("SELECT * FROM plan_items").all() as any[];
  const rules = loadRules();
  for (const m of manual) {
    const r = rules.find((x) => x.lms_id === m.course_id);
    out.push({ id: `manual:${m.id}`, title: m.title, kind: m.kind, courseId: m.course_id, course: r?.short ?? null, color: r?.color ?? null, from: m.start, to: m.end, precision: "exact", source: "manual", note: m.note ?? undefined });
  }

  return out.filter((x) => overlaps(x, from, to)).sort((a, b) => a.from.localeCompare(b.from) || b.to.localeCompare(a.to));
}

export function addPlanItem(p: { title: string; kind: string; courseId: number | null; from: string; to: string; note?: string }) {
  const id = crypto.randomUUID().slice(0, 8);
  const [a, b] = p.from <= p.to ? [p.from, p.to] : [p.to, p.from];
  getDb().query("INSERT INTO plan_items(id, title, kind, course_id, start, end, note) VALUES(?,?,?,?,?,?,?)").run(id, p.title, p.kind, p.courseId, a, b, p.note ?? null);
  return `manual:${id}`;
}

export function deletePlanItem(id: string) {
  getDb().query("DELETE FROM plan_items WHERE id = ?").run(id.replace(/^manual:/, ""));
}
