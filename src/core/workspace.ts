import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import TurndownService from "turndown";
import { loadConfig, ROOT } from "../config";
import { api } from "../connectors/lms/client";
import { getDb } from "./db";
import { adviseLateDays, gradeAll, lmsUrl, workItems } from "./engine";
import { AI_MODE_LABEL, ruleByLmsId } from "./rules";

const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

const slugify = (s: string) =>
  s.toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60);

function materialToMd(m: any): string {
  const name = m.name ? `### ${m.name}\n\n` : "";
  if (m.discriminator === "markdown" || m.viewType === "markdown") {
    let html = m.viewContent;
    try { html = JSON.parse(m.viewContent).value; } catch {}
    return name + td.turndown(html ?? "");
  }
  if (m.discriminator === "file" || m.content?.filename) return `${name}📎 Файл: ${m.content?.name ?? m.content?.filename ?? "вложение"} (скачай в LMS)`;
  const est = m.estimation;
  if (est) return `${name}Задание · макс. ${est.maxScore} · дедлайн ${est.deadline ?? "нет"} · активность «${est.activity?.name}»`;
  return `${name}(материал типа ${m.discriminator ?? m.type}, см. LMS)`;
}

function gitRepos(md: string): string[] {
  const urls = [...md.matchAll(/https?:\/\/git\.culab\.ru\/[^\s)"'\]]+/g)].map((m) => m[0]);
  return [...new Set(urls.map((u) => u.split("/-/")[0].replace(/\.git$/, "")))];
}

async function tryClone(repo: string, dest: string): Promise<string> {
  if (existsSync(dest)) {
    const r = Bun.spawnSync(["git", "-C", dest, "pull", "--ff-only"], { timeout: 60_000 });
    return r.exitCode === 0 ? "обновлён" : "уже есть, pull не удался";
  }
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10" };
  const https = Bun.spawnSync(["git", "clone", "--depth", "1", `${repo}.git`, dest], { timeout: 90_000, env });
  if (https.exitCode === 0) return "склонирован";
  const sshUrl = repo.replace(/^https?:\/\/([^/]+)\//, "git@$1:") + ".git";
  const ssh = Bun.spawnSync(["git", "clone", "--depth", "1", sshUrl, dest], { timeout: 90_000, env });
  if (ssh.exitCode === 0) return "склонирован по SSH";
  return `не склонирован (нужен доступ к git.culab.ru по токену или SSH): ${ssh.stderr.toString().trim().split("\n").pop()}`;
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

  const db = getDb();
  const longreads = db.query("SELECT id, name FROM longreads WHERE theme_id = ? ORDER BY ord").all(it.themeId) as { id: number; name: string }[];
  const mdParts: string[] = [];
  for (const l of longreads) {
    const mats = await api.materials(l.id).catch(() => ({ items: [] as any[] }));
    mdParts.push(`## ${l.name}\n\n${(mats?.items ?? []).sort((a, b) => a.order - b.order).map(materialToMd).join("\n\n")}`);
  }
  const materials = mdParts.join("\n\n---\n\n");
  const detail = it.taskId ? await api.task(it.taskId).catch(() => null) : null;
  const statement = detail?.exercise?.viewContent ? td.turndown(detail.exercise.viewContent) : null;

  const repos = gitRepos(materials);
  const cloneNotes: string[] = [];
  if (opts.clone !== false) {
    for (const r of repos) cloneNotes.push(`- ${r}: ${await tryClone(r, join(cfg.workspaceRoot, rule.slug, "_repo", r.split("/").pop()!))}`);
  }

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
${statement ?? "Текст условия LMS не отдаёт отдельно: смотри MATERIALS.md (раздел «Домашнее задание») и репозиторий курса."}

## Late days
${ld.reasoning}

## Политика ИИ курса (из силлабуса)
${rule.ai_policy.note}
`;

  const claudeMd = `# Рабочая папка: ${it.title}

Это задание по курсу «${rule.title}» в Центральном университете. Контекст: BRIEF.md (условие, дедлайн,
вклад в оценку), MATERIALS.md (материалы темы из LMS)${repos.length ? `, ../_repo (репозиторий курса)` : ""}.

## Режим работы агента: ${rule.ai_policy.mode}
${AI_INSTRUCTIONS[rule.ai_policy.mode]}

Цитата из силлабуса: «${rule.ai_policy.note}»

## Инструменты
MCP-сервер cu-hub: \`task_context\`, \`course_grades\`, \`late_days_advice\`, \`card_move\`.
Сдавать работу и брать late days в LMS студент делает сам; можно подготовить всё для сдачи.
`;

  writeFileSync(join(dir, "BRIEF.md"), brief);
  const courseLinks = [
    ...(g.syllabusUrl ? [{ label: "Силлабус", url: g.syllabusUrl.replace("note.cu.ru", "cuhandlog.ru") }] : []),
    ...(g.timeUrl ? [{ label: "Канал в TiMe", url: g.timeUrl }] : []),
    ...g.links,
  ];
  const linksMd = courseLinks.length ? `Ссылки курса:\n${courseLinks.map((l) => `- [${l.label}](${l.url})`).join("\n")}\n\n` : "";
  writeFileSync(join(dir, "MATERIALS.md"), `# Материалы темы «${it.theme}»\n\n${linksMd}${repos.length ? `Репозитории:\n${cloneNotes.join("\n") || repos.map((r) => `- ${r}`).join("\n")}\n\n` : ""}${materials}`);
  writeFileSync(join(dir, "CLAUDE.md"), claudeMd);
  // Make the folder a self-contained Claude Code project: MCP + /defend.
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { "cu-hub": { command: "bun", args: [join(ROOT, "src/mcp/server.ts")] } } }, null, 2));
  mkdirSync(join(dir, ".claude/commands"), { recursive: true });
  for (const f of ["defend.md", "do.md"]) {
    const src = join(ROOT, ".claude/commands", f);
    if (existsSync(src)) copyFileSync(src, join(dir, ".claude/commands", f));
  }
  writeFileSync(join(dir, ".cu-task.json"), JSON.stringify({ id: it.id, courseId: it.courseId, taskId: it.taskId, exerciseId: it.exerciseId }, null, 2));
  return { dir, repos, cloneNotes, aiMode: rule.ai_policy.mode };
}
