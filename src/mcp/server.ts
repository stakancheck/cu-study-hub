#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { api } from "../connectors/lms/client";
import { classes, markAttendance } from "../core/attendance";
import { addManualCard, buildBoard, COLUMNS, moveCard, updateCard } from "../core/board";
import { adviseLateDays, findItem, gradeAll, recoverable, whatIf, workItems } from "../core/engine";
import { digestMarkdown, today, week } from "../core/planner";
import { loadRules, ruleBySlug } from "../core/rules";
import { createWorkspace } from "../core/workspace";
import { syncAll } from "../sync";

const server = new McpServer({ name: "cu-hub", version: "0.1.0" });

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const r2 = (n: number) => Math.round(n * 100) / 100;
const courseHint = `Курс: slug, короткое имя или часть названия. Доступно: ${loadRules().map((r) => `${r.slug} (${r.short})`).join(", ")}`;
const colIds = COLUMNS.map((c) => c.id) as [string, ...string[]];

server.registerTool("sync", {
  description: "Синхронизировать LMS, календарь и проверить силлабусы на изменения. Вызывай перед ответами про актуальное состояние, если данные старше 30 минут.",
  inputSchema: {},
}, async () => json(await syncAll({ quiet: true })));

server.registerTool("today", {
  description: "Сводка на сегодня: тревоги по курсам, пары с вердиктом «идти или нет», 3 главные задачи, дедлайны на 72 часа. Возвращает markdown.",
  inputSchema: {},
}, async () => text(digestMarkdown(today())));

server.registerTool("week_plan", {
  description: "План на 7 дней: пары, дедлайны, нагрузка в часах по дням, советы по late days для перегруженных дней, список работ для дорешек.",
  inputSchema: {},
}, async () => {
  const w = week();
  return json({
    days: w.days.map((d) => ({
      date: d.date.slice(0, 10), loadH: r2(d.loadH), overloaded: d.overloaded, suggestions: d.suggestions,
      classes: d.classes.map((c) => ({ time: c.start, course: c.course, title: c.title, verdict: c.verdict, reason: c.reason })),
      due: d.due.map((i) => ({ id: i.id, course: i.course, title: i.title, deadline: i.deadline, delta: r2(i.delta), blocker: i.blocker, effortH: i.effortH, lateDays: i.lateDaysAllowed })),
    })),
    recoverable: w.recoverable.slice(0, 15).map((i) => ({ id: i.id, course: i.course, title: i.title, delta: r2(i.delta), blocker: i.blocker })),
  });
});

server.registerTool("course_grades", {
  description: "Состояние курса: баллы по формуле силлабуса, потерянное, максимум достижимого, сколько процентов от остатка нужно для порога, блокеры, расхождения LMS и силлабуса. Без аргумента - все курсы кратко.",
  inputSchema: { course: z.string().optional().describe(courseHint) },
}, async ({ course }) => {
  const grades = gradeAll();
  if (!course)
    return json(grades.map((g) => ({ course: g.short, slug: g.slug, status: g.status, earned: r2(g.earned), lost: r2(g.lost), maxReachable: r2(g.maxReachable), threshold: g.threshold, neededShare: r2(g.neededShare), blockers: g.blockers })));
  const rule = ruleBySlug(course);
  const g = rule && grades.find((x) => x.id === rule.lms_id);
  if (!g) return text(`Курс «${course}» не найден. ${courseHint}`);
  return json({ ...g, activities: g.activities.map((a) => ({ ...a, earned: r2(a.earned), remaining: r2(a.remaining), lost: r2(a.lost), itemValue: r2(a.itemValue) })) });
});

server.registerTool("grades_whatif", {
  description: "Что будет с итоговой оценкой, если оставшиеся работы получат заданные баллы (0-10). assume: {ключ_активности: балл}; rest_avg: балл для всех остальных.",
  inputSchema: {
    course: z.string().describe(courseHint),
    assume: z.record(z.string(), z.number()).optional().describe("Например {\"exam\": 6, \"project\": 8}"),
    rest_avg: z.number().optional(),
  },
}, async ({ course, assume, rest_avg }) => {
  const rule = ruleBySlug(course);
  const g = rule && gradeAll().find((x) => x.id === rule.lms_id);
  if (!g) return text(`Курс «${course}» не найден. ${courseHint}`);
  return json(whatIf(g, assume ?? {}, rest_avg));
});

server.registerTool("board_get", {
  description: "Канбан-доска: колонки inbox/week/today/doing/review/done с карточками (задачи LMS, пары, подготовка, ручные).",
  inputSchema: { course: z.string().optional().describe(courseHint), column: z.enum(colIds).optional() },
}, async ({ course, column }) => {
  const rule = course ? ruleBySlug(course) : undefined;
  const { cards } = buildBoard();
  const sel = cards.filter((c) => (!rule || c.courseId === rule.lms_id) && (!column || c.col === column));
  const grouped: Record<string, unknown[]> = {};
  for (const c of sel)
    (grouped[c.col] ??= []).push({ id: c.id, course: c.course, title: c.title, due: c.due, delta: r2(c.delta), blocker: c.blocker, lateDays: c.lateDays, state: c.state, verdict: c.verdictLabel, notes: c.notes || undefined });
  return json(grouped);
});

server.registerTool("card_move", {
  description: "Переместить карточку в колонку. LMS-статус «на проверке»/«оценено» всё равно имеет приоритет.",
  inputSchema: { id: z.string(), column: z.enum(colIds) },
}, async ({ id, column }) => {
  moveCard(id, column as any);
  return text(`ok: ${id} → ${column}`);
});

server.registerTool("card_add", {
  description: "Добавить ручную карточку (например, что задали на паре, или задачу подготовки).",
  inputSchema: { title: z.string(), course: z.string().optional().describe(courseHint), due: z.string().optional().describe("ISO дата/время"), column: z.enum(colIds).optional() },
}, async ({ title, course, due, column }) => {
  const rule = course ? ruleBySlug(course) : undefined;
  return text(addManualCard(title, rule?.lms_id ?? null, due ?? null, (column as any) ?? "inbox"));
});

server.registerTool("card_note", {
  description: "Записать заметку в карточку (локально).",
  inputSchema: { id: z.string(), notes: z.string() },
}, async ({ id, notes }) => {
  updateCard(id, { notes });
  return text("ok");
});

server.registerTool("classes", {
  description: "Пары из календаря на N дней вперёд с вердиктом: must / should / recording / optional и ценой в баллах.",
  inputSchema: { days: z.number().int().min(1).max(14).default(1), offset_days: z.number().int().default(0) },
}, async ({ days, offset_days }) => {
  const s = new Date();
  s.setHours(0, 0, 0, 0);
  s.setDate(s.getDate() + offset_days);
  const e = new Date(s.getTime() + days * 86_400_000);
  return json(classes(s.toISOString(), e.toISOString(), gradeAll()));
});

server.registerTool("attendance_mark", {
  description: "Отметить, был ли на паре (uid из classes). Что задали на паре добавляй через card_add.",
  inputSchema: { uid: z.string(), attended: z.boolean(), note: z.string().optional() },
}, async ({ uid, attended, note }) => {
  markAttendance(uid, attended, note);
  return text("ok");
});

server.registerTool("late_days_advice", {
  description: "Совет по late days для задачи: можно ли, сколько дней взять, до какой даты. Сам перенос делает студент в LMS.",
  inputSchema: { task: z.string().describe("id карточки (task:123 / ex:456) или часть названия") },
}, async ({ task }) => {
  const it = findItem(task);
  if (!it) return text(`Задача «${task}» не найдена`);
  return json({ task: { id: it.id, course: it.course, title: it.title, deadline: it.deadline, delta: r2(it.delta) }, ...adviseLateDays(it) });
});

server.registerTool("task_context", {
  description: "Полный контекст задачи для работы: метаданные, вклад в оценку, политика ИИ курса, материалы темы из LMS (markdown).",
  inputSchema: { task: z.string().describe("id карточки или часть названия") },
}, async ({ task }) => {
  const it = findItem(task);
  if (!it) return text(`Задача «${task}» не найдена`);
  const rule = loadRules().find((r) => r.lms_id === it.courseId)!;
  const detail = it.taskId ? await api.task(it.taskId).catch(() => null) : null;
  const mats = await api.materials(it.longreadId).catch(() => null);
  return json({
    item: it, aiPolicy: rule.ai_policy, reviewer: detail?.reviewer?.name,
    materials: (mats?.items ?? []).map((m: any) => ({ type: m.discriminator, name: m.name, content: m.viewContent?.slice?.(0, 6000) })),
    hint: "Для полноценной работы вызови workspace_create: он соберёт BRIEF.md, MATERIALS.md и CLAUDE.md с правилами.",
  });
});

server.registerTool("workspace_create", {
  description: "Создать рабочую папку под задачу: BRIEF.md (условие, дедлайн, вклад, LD), MATERIALS.md (все материалы темы), CLAUDE.md (режим агента по политике ИИ курса), клон репозитория курса.",
  inputSchema: { task: z.string().describe("id карточки или часть названия"), clone: z.boolean().default(true) },
}, async ({ task, clone }) => {
  const it = findItem(task);
  if (!it) return text(`Задача «${task}» не найдена`);
  const res = await createWorkspace(it.id, { clone });
  moveCard(it.id, "doing");
  return json(res);
});

server.registerTool("recoverable", {
  description: "Проваленные работы, которые можно вернуть на дорешках, по убыванию баллов.",
  inputSchema: {},
}, async () => json(recoverable(workItems()).map((i) => ({ id: i.id, course: i.course, title: i.title, delta: r2(i.delta), blocker: i.blocker, deadline: i.deadline }))));

await server.connect(new StdioServerTransport());
