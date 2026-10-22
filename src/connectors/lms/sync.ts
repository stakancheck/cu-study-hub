import { getDb, setMeta } from "../../core/db";
import { loadRules } from "../../core/rules";
import { api } from "./client";

export interface LmsSyncResult {
  courses: number;
  exercises: number;
  tasks: number;
  lateDaysBalance: number | null;
}

export async function syncLms(): Promise<LmsSyncResult> {
  const db = getDb();
  const rules = loadRules();
  const trackedIds = new Set(rules.map((r) => r.lms_id));

  const { items: courses } = await api.courses();
  const upCourse = db.query(`
    INSERT INTO courses(id, name, category, syllabus_url, time_url, archived, tracked, slug)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, category=excluded.category, syllabus_url=excluded.syllabus_url,
      time_url=excluded.time_url, archived=excluded.archived, tracked=excluded.tracked, slug=excluded.slug`);
  for (const c of courses) {
    const rule = rules.find((r) => r.lms_id === c.id);
    upCourse.run(c.id, c.name.trim(), c.category, c.settings?.syllabusUrl ?? null, c.settings?.timeChannelUrl ?? null,
      c.isArchived ? 1 : 0, trackedIds.has(c.id) ? 1 : 0, rule?.slug ?? null);
  }

  let exCount = 0;
  const tracked = courses.filter((c) => trackedIds.has(c.id));
  const upTheme = db.query(`INSERT INTO themes(id, course_id, name, ord, publish_date) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, ord=excluded.ord, publish_date=excluded.publish_date`);
  const upLong = db.query(`INSERT INTO longreads(id, theme_id, course_id, name, ord) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, ord=excluded.ord, theme_id=excluded.theme_id`);
  const upEx = db.query(`INSERT INTO exercises(id, course_id, theme_id, longread_id, activity_id, name, max_score, deadline)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET theme_id=excluded.theme_id, longread_id=excluded.longread_id,
    activity_id=excluded.activity_id, name=excluded.name, max_score=excluded.max_score, deadline=excluded.deadline`);
  const upAct = db.query(`INSERT INTO activities(id, course_id, name, weight, planned, exercises_count, avg_threshold,
    best_scores_count, late_days) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,
    weight=excluded.weight, planned=excluded.planned, exercises_count=excluded.exercises_count,
    avg_threshold=excluded.avg_threshold, best_scores_count=excluded.best_scores_count, late_days=excluded.late_days`);

  const fetched = await Promise.all(tracked.map(async (c) => ({ c, ov: await api.overview(c.id), acts: await api.activities(c.id) })));
  db.transaction(() => {
    for (const { c, ov, acts } of fetched) {
      db.query("DELETE FROM exercises WHERE course_id = ?").run(c.id);
      for (const a of acts)
        upAct.run(a.id, c.id, a.name, a.weight, a.maxExercisesCount, a.exercisesCount, a.averageScoreThreshold,
          a.bestScoresCount, a.isLateDaysEnabled ? 1 : 0);
      for (const t of ov.themes) {
        upTheme.run(t.id, c.id, t.name, t.order, t.publishDate);
        t.longreads.forEach((l, i) => {
          upLong.run(l.id, t.id, c.id, l.name, i);
          for (const e of l.exercises) {
            upEx.run(e.id, c.id, t.id, l.id, e.activity.id, e.name, e.maxScore, e.deadline);
            exCount++;
          }
        });
      }
    }
  })();

  const tasks = (await api.tasks()).filter((t) => trackedIds.has(t.course?.id));
  const upTask = db.query(`INSERT INTO tasks(id, exercise_id, course_id, state, score, extra_score, deadline, submit_at,
    evaluate_at, late_days, late_days_enabled, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(id) DO UPDATE SET state=excluded.state, score=excluded.score, extra_score=excluded.extra_score,
    deadline=excluded.deadline, submit_at=excluded.submit_at, evaluate_at=excluded.evaluate_at,
    late_days=excluded.late_days, late_days_enabled=excluded.late_days_enabled, updated_at=excluded.updated_at`);
  db.transaction(() => {
    for (const t of tasks)
      upTask.run(t.id, t.exercise.id, t.course.id, t.state, t.score, t.extraScore, t.deadline, t.submitAt, t.evaluateAt,
        t.lateDays, t.isLateDaysEnabled ? 1 : 0);
  })();

  // Late days balance lives on the student object inside a task detail.
  let lateDaysBalance: number | null = null;
  const probe = tasks.find((t) => t.state === "backlog" || t.state === "inProgress") ?? tasks[0];
  if (probe) {
    const detail = await api.task(probe.id).catch(() => null);
    lateDaysBalance = detail?.student?.lateDaysBalance ?? null;
    if (lateDaysBalance != null) setMeta("lateDaysBalance", String(lateDaysBalance));
  }
  setMeta("lmsSyncedAt", new Date().toISOString());
  return { courses: tracked.length, exercises: exCount, tasks: tasks.length, lateDaysBalance };
}
