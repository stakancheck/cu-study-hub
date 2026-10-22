import { getDb, getMeta } from "./db";
import { type ActivityRule, type CourseRule, loadRules, norm, ruleByLmsId } from "./rules";

const DONE = new Set(["evaluated", "failed"]);
const WAITING = new Set(["submitted", "review"]);
const OPEN = new Set(["backlog", "inProgress", "notCreated", "rejected"]);
const HOUR = 3_600_000;

interface ExerciseRow {
  id: number; course_id: number; theme_id: number; longread_id: number; activity_id: number;
  name: string; max_score: number; deadline: string | null; theme_name: string;
}
interface TaskRow {
  id: number; exercise_id: number; course_id: number; state: string; score: number | null;
  extra_score: number | null; deadline: string | null; submit_at: string | null; late_days: number | null;
  late_days_enabled: number;
}
interface LmsActivityRow {
  id: number; course_id: number; name: string; weight: number; planned: number; late_days: number;
  best_scores_count: number | null;
}

export interface ActivityGrade {
  key: string;
  name: string;
  kind: ActivityRule["kind"];
  weight: number;
  syllabusWeight: number;
  planned: number;
  graded: number;
  earned: number;
  remaining: number;
  lost: number;
  itemValue: number;
  lateDays: boolean;
  scores: { name: string; score: number }[];
}

export type BlockerStatus = "ok" | "pending" | "risk" | "failed";
export interface BlockerState { label: string; status: BlockerStatus; detail: string }

export type CourseStatus = "ok" | "watch" | "risk" | "blocked" | "impossible";

export interface CourseGrade {
  id: number;
  slug: string;
  title: string;
  short: string;
  color: string;
  threshold: number;
  earned: number;
  lost: number;
  remaining: number;
  maxReachable: number;
  bonusLeft: number;
  neededShare: number;
  status: CourseStatus;
  activities: ActivityGrade[];
  blockers: BlockerState[];
  warnings: string[];
  waiting: { name: string; state: string }[];
  rounding: string | null;
  aiMode: CourseRule["ai_policy"]["mode"];
  aiNote: string;
  syllabusUrl: string | null;
  timeUrl: string | null;
}

export interface WorkItem {
  id: string;                 // task:<id> | ex:<id>
  taskId: number | null;
  exerciseId: number;
  courseId: number;
  course: string;
  color: string;
  title: string;
  theme: string;
  longreadId: number;
  themeId: number;
  activity: string;
  kind: string;
  state: string;
  deadline: string | null;
  score: number | null;
  delta: number;
  lateDaysAllowed: boolean;
  lateDaysUsed: number | null;
  blocker: string | null;
  effortH: number;
  priority: number;
  aiMode: string;
  hoursLeft: number | null;
}

function lmsUrl(courseId: number, themeId: number, longreadId: number) {
  return `https://my.centraluniversity.ru/learn/courses/view/actual/${courseId}/themes/${themeId}/longreads/${longreadId}`;
}
export { lmsUrl };

function loadCourseData(courseId: number) {
  const db = getDb();
  const acts = db.query("SELECT * FROM activities WHERE course_id = ?").all(courseId) as LmsActivityRow[];
  const exercises = db
    .query(`SELECT e.*, t.name AS theme_name FROM exercises e LEFT JOIN themes t ON t.id = e.theme_id WHERE e.course_id = ?`)
    .all(courseId) as ExerciseRow[];
  const tasks = db.query("SELECT * FROM tasks WHERE course_id = ?").all(courseId) as TaskRow[];
  return { acts, exercises, tasks };
}

function excluded(rule: CourseRule | undefined, name: string) {
  return (rule?.exclude_exercises ?? []).some((p) => name.includes(p));
}

function matchActivity(rule: CourseRule, lmsName: string): ActivityRule | undefined {
  return rule.activities.find((a) => norm(a.lms) === norm(lmsName));
}

export function gradeCourse(rule: CourseRule): CourseGrade | null {
  const db = getDb();
  const course = db.query("SELECT * FROM courses WHERE id = ?").get(rule.lms_id) as any;
  if (!course) return null;
  const { acts, exercises, tasks } = loadCourseData(rule.lms_id);
  const exById = new Map(exercises.map((e) => [e.id, e]));
  const warnings: string[] = [];
  const activities: ActivityGrade[] = [];

  for (const ar of rule.activities) {
    const la = acts.find((a) => norm(a.name) === norm(ar.lms));
    const weight = la?.weight ?? ar.weight;
    const planned = la?.planned || ar.planned;
    if (la && Math.abs(la.weight - ar.weight) > 1e-6)
      warnings.push(`«${ar.lms}»: вес в LMS ${la.weight}, в силлабусе ${ar.weight}. Считаю по LMS.`);
    if (la && la.planned && la.planned !== ar.planned)
      warnings.push(`«${ar.lms}»: в LMS запланировано ${la.planned} работ, в силлабусе ${ar.planned}.`);

    const own = tasks.filter((t) => {
      const ex = exById.get(t.exercise_id);
      return ex && la && ex.activity_id === la.id;
    });
    let graded = own.filter((t) => DONE.has(t.state));
    let scores = graded.map((t) => {
      const ex = exById.get(t.exercise_id)!;
      return { name: ex.name, score: (((t.score ?? 0) + (t.extra_score ?? 0)) / (ex.max_score || 10)) * 10 };
    });
    if (la?.best_scores_count) scores = scores.sort((a, b) => b.score - a.score).slice(0, la.best_scores_count);
    const unit = planned ? weight / planned : 0;
    const sum = scores.reduce((s, x) => s + x.score, 0);
    const earned = sum * unit;
    const remaining = Math.max(planned - graded.length, 0) * 10 * unit;
    const lost = graded.length * 10 * unit - earned;
    activities.push({
      key: ar.key, name: ar.lms, kind: ar.kind, weight, syllabusWeight: ar.weight, planned,
      graded: graded.length, earned, remaining, lost: Math.max(lost, 0), itemValue: 10 * unit,
      lateDays: la ? !!la.late_days : ar.late_days, scores,
    });
  }

  for (const la of acts) {
    if (rule.graded !== false && la.weight > 0 && !matchActivity(rule, la.name)) warnings.push(`Активность LMS «${la.name}» (вес ${la.weight}) не описана в правилах.`);
  }

  const core = activities.filter((a) => a.kind !== "bonus");
  const bonus = activities.filter((a) => a.kind === "bonus");
  const earned = activities.reduce((s, a) => s + a.earned, 0);
  const lost = core.reduce((s, a) => s + a.lost, 0);
  const remaining = core.reduce((s, a) => s + a.remaining, 0);
  const bonusLeft = bonus.reduce((s, a) => s + a.remaining, 0);
  const maxReachable = earned + remaining;
  const threshold = rule.pass_threshold;
  const neededShare = remaining > 0 ? Math.max(threshold - earned, 0) / remaining : earned >= threshold ? 0 : Infinity;

  const blockers = rule.blockers.map((b) => evalBlocker(rule, b, acts, exercises, tasks, activities));

  let status: CourseStatus = "ok";
  if (neededShare > 0.55) status = "watch";
  if (neededShare >= 0.7) status = "risk";
  if (blockers.some((b) => b.status === "risk")) status = status === "ok" ? "watch" : status;
  if (blockers.some((b) => b.status === "failed")) status = "blocked";
  if (rule.graded !== false && maxReachable + bonusLeft < threshold) status = "impossible";
  if (rule.graded === false) status = "ok";

  const waiting = tasks
    .filter((t) => WAITING.has(t.state))
    .map((t) => ({ name: exById.get(t.exercise_id)?.name ?? `#${t.id}`, state: t.state }));

  return {
    id: rule.lms_id, slug: rule.slug, title: rule.title, short: rule.short, color: rule.color,
    threshold, earned, lost, remaining, maxReachable, bonusLeft, neededShare, status,
    activities, blockers, warnings, waiting, rounding: rule.rounding,
    aiMode: rule.ai_policy.mode, aiNote: rule.ai_policy.note,
    syllabusUrl: course.syllabus_url, timeUrl: course.time_url,
  };
}

function evalBlocker(
  rule: CourseRule, b: CourseRule["blockers"][number], acts: LmsActivityRow[], exercises: ExerciseRow[],
  tasks: TaskRow[], grades: ActivityGrade[],
): BlockerState {
  const ar = rule.activities.find((a) => a.key === b.activity);
  const la = ar && acts.find((a) => norm(a.name) === norm(ar.lms));
  const g = grades.find((x) => x.key === b.activity);
  if (!ar || !g) return { label: b.label, status: "pending", detail: "активность не найдена" };
  const exIds = new Set(
    exercises.filter((e) => la && e.activity_id === la.id && (!b.match || norm(e.name).includes(norm(b.match)))).map((e) => e.id),
  );
  const own = tasks.filter((t) => exIds.has(t.exercise_id));
  const done = own.filter((t) => DONE.has(t.state));
  const val = (t: TaskRow) => (t.score ?? 0) + (t.extra_score ?? 0);

  if (b.all_submitted) {
    const failed = done.filter((t) => t.state === "failed" || val(t) === 0);
    if (failed.length) return { label: b.label, status: "failed", detail: `${failed.length} часть(и) не сданы` };
    const submitted = own.filter((t) => !OPEN.has(t.state)).length;
    return submitted >= g.planned
      ? { label: b.label, status: "ok", detail: `сданы все ${g.planned}` }
      : { label: b.label, status: "pending", detail: `сдано ${submitted} из ${g.planned}` };
  }

  const min = b.min ?? 0;
  if (b.count) {
    const good = done.filter((t) => val(t) >= min).length;
    const possible = Math.max(g.planned - done.length, 0);
    if (good >= b.count) return { label: b.label, status: "ok", detail: `${good} из ${b.count}` };
    if (good + possible < b.count) return { label: b.label, status: "failed", detail: `${good} из ${b.count}, осталось ${possible} попыток` };
    const slack = good + possible - b.count;
    return {
      label: b.label, status: slack <= 1 ? "risk" : "pending",
      detail: `${good} из ${b.count}; можно провалить ещё ${slack} из ${possible}`,
    };
  }

  if (!done.length) {
    const overdue = exercises.some((e) => exIds.has(e.id) && e.deadline && new Date(e.deadline).getTime() < Date.now());
    return { label: b.label, status: overdue ? "risk" : "pending", detail: overdue ? "дедлайн прошёл, оценки нет" : "впереди" };
  }
  const best = Math.max(...done.map(val));
  return best >= min
    ? { label: b.label, status: "ok", detail: `оценка ${best}` }
    : { label: b.label, status: "failed", detail: `оценка ${best} < ${min}: нужна пересдача или дорешка` };
}

export function gradeAll(): CourseGrade[] {
  const tracked = new Set(
    (getDb().query("SELECT id FROM courses WHERE tracked = 1").all() as { id: number }[]).map((r) => r.id),
  );
  return loadRules()
    .filter((r) => tracked.has(r.lms_id))
    .map(gradeCourse)
    .filter((g): g is CourseGrade => !!g);
}

/** Every gradable unit of work, whether or not LMS has created a task card for it yet. */
export function workItems(grades = gradeAll()): WorkItem[] {
  const db = getDb();
  const items: WorkItem[] = [];
  const now = Date.now();
  for (const g of grades) {
    const rule = ruleByLmsId(g.id)!;
    const { acts, exercises, tasks } = loadCourseData(g.id);
    const taskByEx = new Map(tasks.map((t) => [t.exercise_id, t]));
    for (const ex of exercises) {
      if (excluded(rule, ex.name)) continue;
      const la = acts.find((a) => a.id === ex.activity_id);
      const ar = la ? matchActivity(rule, la.name) : undefined;
      const graded = rule.graded !== false;
      if (graded && !ar) continue; // weightless activities (перезачёт и т.п.)
      const t = taskByEx.get(ex.id);
      const state = t?.state ?? "notCreated";
      const ag = ar ? g.activities.find((a) => a.key === ar.key) : undefined;
      const blocker = rule.blockers.find(
        (b) => b.activity === ar?.key && (!b.match || norm(ex.name).includes(norm(b.match))),
      );
      const deadline = t?.deadline ?? ex.deadline;
      const hoursLeft = deadline ? (new Date(deadline).getTime() - now) / HOUR : null;
      const delta = ag?.itemValue ?? 0;
      const lateDaysAllowed = t ? !!t.late_days_enabled : !!ag?.lateDays;
      const effortH = ar?.effort_h ?? 0.5;
      items.push({
        id: t ? `task:${t.id}` : `ex:${ex.id}`, taskId: t?.id ?? null, exerciseId: ex.id, courseId: g.id,
        course: g.short, color: g.color, title: ex.name.trim(), theme: ex.theme_name, longreadId: ex.longread_id,
        themeId: ex.theme_id, activity: la?.name ?? "", kind: ar?.kind ?? "admin", state, deadline,
        score: t?.score ?? null, delta, lateDaysAllowed, lateDaysUsed: t?.late_days ?? null,
        blocker: blocker?.label ?? null, effortH, priority: 0, aiMode: g.aiMode, hoursLeft,
      });
    }
  }
  const pressure = new Map(grades.map((g) => [g.id, Number.isFinite(g.neededShare) ? g.neededShare : 1]));
  for (const it of items) it.priority = priority(it, pressure.get(it.courseId) ?? 0);
  return items;
}

export function priority(it: WorkItem, pressure: number): number {
  if (!OPEN.has(it.state)) return 0;
  // Count-type blockers ("6 ДЗ на ≥3.5") tolerate a miss; single-item blockers do not.
  const blockerMult = !it.blocker ? 1 : /^\d+ /.test(it.blocker) ? 2 : 3;
  // Urgency by slack: calendar time left minus ~2x the work itself, in days.
  let urgency: number;
  if (it.hoursLeft == null) urgency = 0.02;
  else if (it.hoursLeft < 0) urgency = it.lateDaysAllowed && it.hoursLeft > -168 ? 1 : 0.01;
  else urgency = 1 / Math.max((it.hoursLeft - it.effortH * 2) / 24 + 1, 0.25);
  const value = Math.max(it.delta, 0.05);
  const effort = Math.max(it.effortH, 0.25);
  return ((value * blockerMult * (1 + pressure) * urgency) / Math.sqrt(effort)) * 100;
}

export function openItems(items = workItems()) {
  const now = Date.now();
  return items
    .filter((i) => OPEN.has(i.state))
    .filter((i) => !i.deadline || new Date(i.deadline).getTime() > now - (i.lateDaysAllowed ? 7 * 24 * HOUR : 0))
    .sort((a, b) => b.priority - a.priority);
}

/** Missed / failed work that дорешки could recover, biggest first. */
export function recoverable(items = workItems()) {
  return items
    .filter((i) => i.state === "failed" && (i.score ?? 0) < 3.5 && i.delta > 0)
    .sort((a, b) => b.delta - a.delta || (b.blocker ? 1 : 0) - (a.blocker ? 1 : 0));
}

/** Find a work item by id ("task:1", "ex:2", bare number) or by a fuzzy title query. */
export function findItem(q: string, items = workItems()): WorkItem | undefined {
  const s = norm(q);
  return (
    items.find((i) => i.id === q || String(i.taskId) === q || String(i.exerciseId) === q) ??
    items.filter((i) => norm(`${i.course} ${i.title}`).includes(s)).sort((a, b) => b.priority - a.priority)[0] ??
    items.find((i) => s.split(" ").every((w) => norm(`${i.course} ${i.title} ${i.theme}`).includes(w)))
  );
}

/** What-if: fill remaining slots of activities with assumed scores. */
export function whatIf(g: CourseGrade, assume: Record<string, number>, restAvg?: number) {
  let total = 0;
  const rows = g.activities.map((a) => {
    const left = Math.max(a.planned - a.graded, 0);
    const s = assume[a.key] ?? restAvg ?? 0;
    const add = (left * Math.min(Math.max(s, 0), 10) * a.itemValue) / 10;
    total += a.earned + add;
    return { key: a.key, name: a.name, now: a.earned, assumed: s, left, final: a.earned + add };
  });
  return { final: total, passes: total >= g.threshold, threshold: g.threshold, rows };
}

export interface LateDayAdvice {
  allowed: boolean;
  balance: number | null;
  suggestDays: number;
  latestDate: string | null;
  reasoning: string;
}

export const LD_HARD_LIMIT = "2026-12-19T20:59:00Z";

export function adviseLateDays(it: WorkItem): LateDayAdvice {
  const balance = Number(getMeta("lateDaysBalance") ?? "NaN");
  const bal = Number.isFinite(balance) ? balance : null;
  if (!it.lateDaysAllowed)
    return { allowed: false, balance: bal, suggestDays: 0, latestDate: null, reasoning: "Late days для этой работы запрещены силлабусом." };
  if (!it.deadline) return { allowed: true, balance: bal, suggestDays: 0, latestDate: null, reasoning: "У задачи нет дедлайна." };
  const dl = new Date(it.deadline).getTime();
  const latest = Math.min(dl + 7 * 24 * HOUR, new Date(LD_HARD_LIMIT).getTime());
  const effortDays = Math.ceil(it.effortH / 3);
  const hoursLeft = (dl - Date.now()) / HOUR;
  const need = Math.max(0, Math.ceil((it.effortH * 2 - Math.max(hoursLeft, 0)) / 24));
  const suggest = Math.min(Math.max(need, hoursLeft < 0 ? Math.ceil(-hoursLeft / 24) + effortDays : 0), 7);
  const reasoning = [
    `Работа стоит ${it.delta.toFixed(2)} балла итоговой оценки.`,
    suggest > 0 ? `Предлагаю перенести на ${suggest} дн. (1 LD за день, максимум 7).` : "По оценке времени перенос пока не нужен.",
    "Если сдашь раньше, отмени LD вручную: сами они не вернутся.",
  ].join(" ");
  return { allowed: true, balance: bal, suggestDays: suggest, latestDate: new Date(latest).toISOString(), reasoning };
}
