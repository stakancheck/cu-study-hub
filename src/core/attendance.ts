import { getDb } from "./db";
import type { CourseGrade } from "./engine";
import { ruleByLmsId } from "./rules";

export type Verdict = "must" | "should" | "recording" | "optional" | "unknown";

export interface ClassEvent {
  uid: string;
  start: string;
  end: string;
  title: string;
  location: string;
  courseId: number | null;
  course: string | null;
  color: string | null;
  kind: string | null;
  verdict: Verdict;
  points: number;
  reason: string;
  attended: number | null;
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  must: "Обязательно",
  should: "Желательно",
  recording: "Можно запись",
  optional: "По желанию",
  unknown: "Не распознано",
};

const HIGH_STAKES = /контрольн|защит|экзамен|тест|коллоквиум|приёмк|приемк/i;

export function verdictFor(ev: { title: string; description?: string; course_id: number | null; kind: string | null }, grades: CourseGrade[]) {
  if (!ev.course_id) return { verdict: "unknown" as Verdict, points: 0, reason: "Не сопоставлено с курсом: добавь шаблон в rules/*.yaml → calendar.match" };
  const rule = ruleByLmsId(ev.course_id)!;
  const g = grades.find((x) => x.id === ev.course_id);
  const k = ev.kind ? rule.calendar?.kinds[ev.kind] : undefined;
  const acts = (k?.activities ?? []).map((key) => g?.activities.find((a) => a.key === key)).filter(Boolean);
  const points = acts.reduce((s, a) => s + a!.itemValue, 0);
  const text = `${ev.title} ${ev.description ?? ""}`;
  const pressure = g && (g.status === "risk" || g.status === "blocked" || g.status === "watch");

  if (HIGH_STAKES.test(text)) return { verdict: "must" as Verdict, points, reason: "Контрольная, защита или тест: пропуск = ноль без пересдачи." };
  if (points >= 0.25) return { verdict: "must" as Verdict, points, reason: `За занятие ставят баллы: до +${points.toFixed(2)} к итогу.` };
  if (points > 0 && pressure) return { verdict: "must" as Verdict, points, reason: `+${points.toFixed(2)} к итогу, а у курса мало запаса.` };
  if (points > 0) return { verdict: "should" as Verdict, points, reason: `+${points.toFixed(2)} к итогу.` };
  if (k?.note) return { verdict: "should" as Verdict, points, reason: k.note[0].toUpperCase() + k.note.slice(1) + "." };
  if (k?.recording) return { verdict: "recording" as Verdict, points, reason: "Без оценки, есть видеозапись во вкладке курса «Видеозаписи»." };
  return { verdict: "optional" as Verdict, points, reason: "Без оценки." };
}

export function classes(fromIso: string, toIso: string, grades: CourseGrade[]): ClassEvent[] {
  const rows = getDb()
    .query(`SELECT e.*, a.attended FROM events e LEFT JOIN attendance a ON a.event_uid = e.uid
            WHERE e.start >= ? AND e.start < ? ORDER BY e.start`)
    .all(fromIso, toIso) as any[];
  return rows.map((r) => {
    const rule = r.course_id ? ruleByLmsId(r.course_id) : undefined;
    const v = verdictFor(r, grades);
    return {
      uid: r.uid, start: r.start, end: r.end, title: r.title, location: r.location ?? "",
      courseId: r.course_id, course: rule?.short ?? null, color: rule?.color ?? null, kind: r.kind,
      attended: r.attended, ...v,
    };
  });
}

export function markAttendance(uid: string, attended: boolean, note = "") {
  getDb().query(`INSERT INTO attendance(event_uid, attended, note) VALUES(?,?,?)
    ON CONFLICT(event_uid) DO UPDATE SET attended=excluded.attended, note=excluded.note, at=datetime('now')`)
    .run(uid, attended ? 1 : 0, note);
}
