import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, ROOT } from "../config";
import { api } from "../connectors/lms/client";
import { getDb } from "./db";
import { adviseLateDays, gradeAll, lmsUrl, workItems } from "./engine";
import { courseDir, slugify, syncCourseMaterials, td } from "./materials";
import { AI_MODE_LABEL, ruleByLmsId } from "./rules";

/** The block «### Задание: <title>» of the theme file, with its attachment links. */
function exerciseSection(themeMd: string, title: string): string | null {
  const i = themeMd.indexOf(`### Задание: ${title}`);
  if (i < 0) return null;
  const rest = themeMd.slice(i);
  const next = rest.slice(3).search(/\n#{2,3} /);
  return next < 0 ? rest : rest.slice(0, next + 3);
}

const AI_INSTRUCTIONS: Record<string, string> = {
  execute: `Агенту можно готовить черновик решения. После черновика обязательно подготовь в DEFENSE.md
конспект для устной защиты: что сделано, почему так, где слабые места, 5-7 вероятных вопросов с ответами.`,
  assist: `Работаем вместе. Пиши код или текст небольшими шагами и после каждого шага коротко объясняй,
что и почему сделано: студент должен уметь объяснить ЛЮБУЮ часть решения. В конце подготовь DEFENSE.md
с вопросами для самопроверки. Не делай всё задание одним куском без объяснений.`,
  tutor_only: `Политика курса ЗАПРЕЩАЕТ генерировать решение с помощью ИИ. Не пиши решение, текст ответа
или код за студента. Разрешено: объяснять теорию, давать структуру и план, задавать наводящие вопросы,
проверять уже написанный студентом текст на соответствие заданию и указывать на пробелы.
Если тебя просят «просто сделай», откажись и предложи план.`,
};

export async function createWorkspace(itemId: string, opts: { clone?: boolean } = {}) {
  const grades = gradeAll();
  const it = workItems(grades).find((i) => i.id === itemId || String(i.taskId) === itemId || String(i.exerciseId) === itemId);
  if (!it) throw new Error(`Задача ${itemId} не найдена (сначала sync)`);
  const rule = ruleByLmsId(it.courseId)!;
  const g = grades.find((x) => x.id === it.courseId)!;
  const cfg = loadConfig();
  const dir = join(cfg.workspaceRoot, rule.slug, slugify(it.title));
  mkdirSync(dir, { recursive: true });

  // Whole course mirror first: every week, attachments, syllabus, repo. Cheap on re-runs.
  const mat = await syncCourseMaterials(it.courseId, { clone: opts.clone });
  const theme = getDb().query("SELECT ord, name FROM themes WHERE id = ?").get(it.themeId) as { ord: number; name: string };
  const themeFile = `${String(theme.ord).padStart(2, "0")}-${slugify(theme.name)}.md`;
  const themeMd = existsSync(join(mat.dir, themeFile)) ? readFileSync(join(mat.dir, themeFile), "utf8") : "";
  // Links inside _course are relative to it; from the task folder they live one level up.
  const relink = (md: string) => md.replace(/\](\(<?)(attachments\/|repo\/)/g, "]$1../_course/$2");
  const section = exerciseSection(themeMd, it.title);
  const detail = it.taskId ? await api.task(it.taskId).catch(() => null) : null;
  const lmsStatement = detail?.exercise?.viewContent ? td.turndown(detail.exercise.viewContent) : null;
  // No text or file on the task itself: the statement is usually inside the week's PDFs (лонгрид, семинар).
  const sectionHasBody = !!section && (section.includes("📎") || section.split("\n").filter((l) => l.trim()).length > 2);
  const weekFiles = themeMd.split("\n").filter((l) => l.startsWith("📎"));
  const hint = !lmsStatement && !sectionHasBody && weekFiles.length
    ? `В LMS у задания нет текста и вложений. Условие, скорее всего, в файлах этой недели (PDF читай инструментом Read):\n\n${relink(weekFiles.join("\n"))}`
    : "";
  const statement = [lmsStatement, section && relink(section), hint].filter(Boolean).join("\n\n");
  const repos = mat.repos;
  const cloneNotes = mat.cloneNotes;

  const ld = adviseLateDays(it);
  const link = lmsUrl(it.courseId, it.themeId, it.longreadId);
  const brief = `# ${it.title}

| | |
|---|---|
| Курс | ${rule.title} |
| Тема | ${it.theme} |
| Активность | ${it.activity} |
| Дедлайн | ${it.deadline ? new Date(it.deadline).toLocaleString("ru-RU") : "нет"} |
| Состояние в LMS | ${it.state} |
| Вклад в итог | +${it.delta.toFixed(2)} из 10 |
| Блокер | ${it.blocker ?? "нет"} |
| Late days | ${ld.allowed ? `можно, на балансе ${ld.balance ?? "?"}` : "нельзя"} |
| Политика ИИ | ${AI_MODE_LABEL[rule.ai_policy.mode]} |
| Ревьюер | ${detail?.reviewer?.name ?? "?"} |
| LMS | ${link} |

## Состояние курса
Сейчас ${g.earned.toFixed(2)} из 10, порог ${g.threshold}, максимум достижимого ${g.maxReachable.toFixed(2)}.
Блокеры: ${g.blockers.map((b) => `${b.label}: ${b.status} (${b.detail})`).join("; ") || "нет"}.

## Условие
${statement || "Отдельного текста условия в LMS нет: смотри MATERIALS.md (раздел «Домашнее задание»), вложения и репозиторий курса."}

## Late days
${ld.reasoning}

## Политика ИИ курса (из силлабуса)
${rule.ai_policy.note}
`;

  const claudeMd = `# Рабочая папка: ${it.title}

Это задание по курсу «${rule.title}» в Центральном университете.

## Где что лежит
- BRIEF.md: условие, дедлайн, вклад в оценку, late days, политика ИИ.
- MATERIALS.md: материалы темы этой задачи (неделя «${it.theme}»).
- ../_course/: ВЕСЬ курс. README.md (оглавление и ссылки), файл на каждую неделю, attachments/ (PDF, слайды,
  условия заданий), SYLLABUS.md (система оценивания), repo/ (репозиторий курса, если есть доступ).
  Читай прошлые недели, когда задание опирается на пройденное. Папку пересобирает синхронизация, не правь её.
- ../COURSE_NOTES.md: правила студента для этого курса (стиль кода, рамки по неделям, git, защита). Если файл есть,
  он ВАЖНЕЕ общих инструкций ниже, кроме запретов политики ИИ.
- ../HISTORY.md: прошлые работы студента по курсу (решения, презентации, отчёты) с оценками. Используй как образец
  стиля и формата, но не копируй старые решения в новое задание.
- ~/study/_templates/: общие шаблоны ЦУ (например, шаблон презентаций для упаковки проектов).
${repos.length ? `- Репозитории курса: ${repos.join(", ")}\n` : ""}

## Режим работы агента: ${rule.ai_policy.mode}
${AI_INSTRUCTIONS[rule.ai_policy.mode]}

Цитата из силлабуса: «${rule.ai_policy.note}»

## Инструменты
MCP-сервер cu-hub: \`task_context\`, \`course_materials\`, \`course_grades\`, \`late_days_advice\`, \`card_move\`.
Сдавать работу и брать late days в LMS студент делает сам; можно подготовить всё для сдачи.
`;

  writeFileSync(join(dir, "BRIEF.md"), brief);
  const courseLinks = [
    ...(g.syllabusUrl ? [{ label: "Силлабус", url: g.syllabusUrl.replace("note.cu.ru", "cuhandlog.ru") }] : []),
    ...(g.timeUrl ? [{ label: "Канал в TiMe", url: g.timeUrl }] : []),
    ...g.links,
  ];
  const linksMd = courseLinks.length ? `Ссылки курса:\n${courseLinks.map((l) => `- [${l.label}](${l.url})`).join("\n")}\n\n` : "";
  writeFileSync(join(dir, "MATERIALS.md"), `# Материалы темы «${it.theme}»\n\nВесь курс: ../_course/README.md\n\n${linksMd}${repos.length ? `Репозитории:\n${cloneNotes.join("\n")}\n\n` : ""}${relink(themeMd.replace(/^# .*\n/, ""))}`);
  writeFileSync(join(dir, "CLAUDE.md"), claudeMd);
  // Make the folder a self-contained Claude Code project: MCP + /defend.
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { "cu-hub": { command: "bun", args: [join(ROOT, "src/mcp/server.ts")] } } }, null, 2));
  mkdirSync(join(dir, ".claude/commands"), { recursive: true });
  for (const f of ["defend.md", "do.md"]) {
    const src = join(ROOT, ".claude/commands", f);
    if (existsSync(src)) copyFileSync(src, join(dir, ".claude/commands", f));
  }
  writeFileSync(join(dir, ".cu-task.json"), JSON.stringify({ id: it.id, courseId: it.courseId, taskId: it.taskId, exerciseId: it.exerciseId }, null, 2));
  return { dir, repos, cloneNotes, aiMode: rule.ai_policy.mode, courseDir: courseDir(it.courseId), attachments: mat.attachments, errors: mat.errors };
}
