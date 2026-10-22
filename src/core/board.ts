import { classes, type ClassEvent, VERDICT_LABEL } from "./attendance";
import { getDb } from "./db";
import { type CourseGrade, gradeAll, lmsUrl, type WorkItem, workItems } from "./engine";
import { ruleByLmsId } from "./rules";

export const COLUMNS = [
  { id: "inbox", title: "Входящие" },
  { id: "week", title: "Эта неделя" },
  { id: "today", title: "Сегодня" },
  { id: "doing", title: "В работе" },
  { id: "review", title: "На проверке" },
  { id: "done", title: "Готово" },
] as const;
export type ColumnId = (typeof COLUMNS)[number]["id"];

export interface Card {
  id: string;
  kind: "lms" | "event" | "prep" | "manual";
  courseId: number | null;
  course: string | null;
  color: string | null;
  title: string;
  subtitle: string;
  col: ColumnId;
  due: string | null;
  delta: number;
  blocker: string | null;
  lateDays: boolean;
  state: string;
  verdict?: string;
  verdictLabel?: string;
  priority: number;
  notes: string;
  aiMode?: string;
  link?: string;
  score?: number | null;
  effortH?: number;
  ord: number;
}

const HOUR = 3_600_000;
const LMS_AUTO: Record<string, ColumnId> = {
  inProgress: "doing", submitted: "review", review: "review", evaluated: "done", failed: "done",
};

interface LocalCard { id: string; kind: string; course_id: number | null; title: string | null; col: string | null; ord: number;
  due: string | null; notes: string | null; effort_h: number | null; hidden: number; done: number; updated_at: string }

function locals(): Map<string, LocalCard> {
  const rows = getDb().query("SELECT * FROM cards").all() as LocalCard[];
  return new Map(rows.map((r) => [r.id, r]));
}

function byDeadline(due: string | null): ColumnId {
  if (!due) return "inbox";
  const h = (new Date(due).getTime() - Date.now()) / HOUR;
  if (h <= 24) return "today";
  if (h <= 7 * 24) return "week";
  return "inbox";
}

function isToday(iso: string) {
  const d = new Date(iso), n = new Date();
  return d.toDateString() === n.toDateString();
}

export function buildBoard(grades: CourseGrade[] = gradeAll()) {
  const loc = locals();
  const cards: Card[] = [];
  const now = Date.now();

  const all = workItems(grades);
  // Ungraded courses (ЛНА) collapse into one card per course: dozens of «ознакомиться» are one chore.
  const ungraded = new Set(grades.filter((g) => ruleByLmsId(g.id)?.graded === false).map((g) => g.id));
  for (const cid of ungraded) {
    const open = all.filter((i) => i.courseId === cid && (i.state === "backlog" || i.state === "inProgress" || i.state === "notCreated"));
    if (!open.length) continue;
    const id = `group:${cid}`;
    const l = loc.get(id);
    if (l?.hidden) continue;
    const due = open.map((i) => i.deadline).filter(Boolean).sort()[0] ?? null;
    const g = grades.find((x) => x.id === cid)!;
    cards.push({
      id, kind: "manual", courseId: cid, course: g.short, color: g.color, title: `${g.short}: ознакомиться с документами (${open.length})`,
      subtitle: "Одна сессия: открыть курс в LMS и пройти все подряд", col: (l?.col as ColumnId) ?? byDeadline(due), due,
      delta: 0, blocker: null, lateDays: false, state: "open", priority: 3, notes: l?.notes ?? "",
      link: `https://my.centraluniversity.ru/learn/courses/view/actual/${cid}`, effortH: Math.ceil(open.length * 3 / 60 * 2) / 2, ord: l?.ord ?? 0,
    });
  }

  for (const it of all) {
    if (ungraded.has(it.courseId)) continue;
    const auto = LMS_AUTO[it.state];
    if (auto === "done") {
      const ts = it.deadline ? new Date(it.deadline).getTime() : 0;
      if (now - ts > 10 * 24 * HOUR) continue;
    }
    if (it.state === "notCreated" && it.deadline && new Date(it.deadline).getTime() < now) continue;
    if (it.state === "backlog" && it.deadline && new Date(it.deadline).getTime() < now - (it.lateDaysAllowed ? 7 * 24 * HOUR : 0)) continue;
    const l = loc.get(it.id);
    if (l?.hidden) continue;
    const col = (auto && auto !== "doing") ? auto : ((l?.col as ColumnId) ?? auto ?? byDeadline(it.deadline));
    cards.push(itemCard(it, col, l));
  }

  const horizon = new Date(now + 7 * 24 * HOUR).toISOString();
  const evs = classes(new Date(now - 2 * HOUR).toISOString(), horizon, grades);
  for (const e of evs) {
    if (!e.courseId) continue;
    const id = `event:${e.uid}`;
    const l = loc.get(id);
    if (l?.hidden) continue;
    const col: ColumnId = l?.done || e.attended != null ? "done" : ((l?.col as ColumnId) ?? (isToday(e.start) ? "today" : "week"));
    cards.push(eventCard(e, col, l));
    const rule = ruleByLmsId(e.courseId)!;
    for (const p of rule.prep ?? []) {
      if (p.before !== e.kind) continue;
      if (new Date(e.start).getTime() - now > 3 * 24 * HOUR) continue;
      const pid = `prep:${e.uid}`;
      const pl = loc.get(pid);
      if (pl?.hidden) continue;
      const due = new Date(new Date(e.start).getTime() - HOUR).toISOString();
      cards.push({
        id: pid, kind: "prep", courseId: e.courseId, course: e.course, color: e.color,
        title: `Подготовка: ${p.title}`, subtitle: `к занятию ${fmt(e.start)}`,
        col: pl?.done ? "done" : ((pl?.col as ColumnId) ?? byDeadline(due)), due, delta: 0, blocker: null, lateDays: false,
        state: pl?.done ? "done" : "open", priority: 8, notes: pl?.notes ?? "", effortH: p.effort_h, ord: pl?.ord ?? 0,
      });
    }
  }

  for (const l of loc.values()) {
    if (l.kind !== "manual" || l.hidden) continue;
    const rule = l.course_id ? ruleByLmsId(l.course_id) : undefined;
    cards.push({
      id: l.id, kind: "manual", courseId: l.course_id, course: rule?.short ?? null, color: rule?.color ?? null,
      title: l.title ?? "Без названия", subtitle: "", col: l.done ? "done" : ((l.col as ColumnId) ?? byDeadline(l.due)),
      due: l.due, delta: 0, blocker: null, lateDays: false, state: l.done ? "done" : "open", priority: 5,
      notes: l.notes ?? "", effortH: l.effort_h ?? undefined, ord: l.ord,
    });
  }

  cards.sort((a, b) => a.ord - b.ord || b.priority - a.priority || (a.due ?? "9").localeCompare(b.due ?? "9"));
  return { columns: COLUMNS, cards };
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString("ru-RU", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function itemCard(it: WorkItem, col: ColumnId, l?: LocalCard): Card {
  return {
    id: it.id, kind: "lms", courseId: it.courseId, course: it.course, color: it.color, title: it.title,
    subtitle: it.theme ?? "", col, due: it.deadline, delta: it.delta, blocker: it.blocker, lateDays: it.lateDaysAllowed,
    state: it.state, priority: it.priority, notes: l?.notes ?? "", aiMode: it.aiMode,
    link: lmsUrl(it.courseId, it.themeId, it.longreadId), score: it.score, effortH: l?.effort_h ?? it.effortH, ord: l?.ord ?? 0,
  };
}

function eventCard(e: ClassEvent, col: ColumnId, l?: LocalCard): Card {
  return {
    id: `event:${e.uid}`, kind: "event", courseId: e.courseId, course: e.course, color: e.color, title: e.title,
    subtitle: `${fmt(e.start)}${e.location ? ` · ${e.location}` : ""}`, col, due: e.start, delta: e.points, blocker: null,
    lateDays: false, state: e.attended == null ? "planned" : e.attended ? "attended" : "skipped", verdict: e.verdict,
    verdictLabel: `${VERDICT_LABEL[e.verdict]}. ${e.reason}`, priority: e.verdict === "must" ? 50 : 10,
    notes: l?.notes ?? "", ord: l?.ord ?? 0,
  };
}

export function moveCard(id: string, col: ColumnId, ord?: number) {
  const kind = id.split(":")[0];
  const db = getDb();
  if (kind === "manual") {
    db.query("UPDATE cards SET col=?, done=?, ord=COALESCE(?, ord), updated_at=datetime('now') WHERE id=?").run(col, col === "done" ? 1 : 0, ord ?? null, id);
    return;
  }
  const done = (kind === "prep" || kind === "event") && col === "done" ? 1 : 0;
  db.query(`INSERT INTO cards(id, kind, col, ord, done) VALUES(?,?,?,COALESCE(?,0),?)
    ON CONFLICT(id) DO UPDATE SET col=excluded.col, ord=COALESCE(?, cards.ord), done=excluded.done, updated_at=datetime('now')`)
    .run(id, kind === "task" || kind === "ex" ? "lms" : kind, col, ord ?? null, done, ord ?? null);
}

export function updateCard(id: string, patch: { notes?: string; hidden?: boolean; effortH?: number; title?: string; due?: string | null }) {
  const kind = id.split(":")[0];
  const db = getDb();
  db.query(`INSERT INTO cards(id, kind) VALUES(?, ?) ON CONFLICT(id) DO NOTHING`).run(id, kind === "task" || kind === "ex" ? "lms" : kind);
  if (patch.notes !== undefined) db.query("UPDATE cards SET notes=? WHERE id=?").run(patch.notes, id);
  if (patch.hidden !== undefined) db.query("UPDATE cards SET hidden=? WHERE id=?").run(patch.hidden ? 1 : 0, id);
  if (patch.effortH !== undefined) db.query("UPDATE cards SET effort_h=? WHERE id=?").run(patch.effortH, id);
  if (patch.title !== undefined) db.query("UPDATE cards SET title=? WHERE id=?").run(patch.title, id);
  if (patch.due !== undefined) db.query("UPDATE cards SET due=? WHERE id=?").run(patch.due, id);
  db.query("UPDATE cards SET updated_at=datetime('now') WHERE id=?").run(id);
}

export function addManualCard(title: string, courseId: number | null, due: string | null, col: ColumnId = "inbox") {
  const id = `manual:${crypto.randomUUID().slice(0, 8)}`;
  getDb().query("INSERT INTO cards(id, kind, course_id, title, col, due) VALUES(?,?,?,?,?,?)").run(id, "manual", courseId, title, col, due);
  return id;
}
