import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import TurndownService from "turndown";
import { courseOverride, loadConfig, ROOT } from "../config";
import { api, lms } from "../connectors/lms/client";
import { getDb, setMeta } from "./db";
import { ruleByLmsId } from "./rules";

export const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

export const slugify = (s: string) =>
  s.normalize("NFC").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60);

/** File names from LMS come in NFD (macOS uploads); keep them readable on disk. */
const safeName = (s: string) => s.normalize("NFC").replace(/[\/\\:]/g, "_");

export const courseDir = (courseId: number) => join(loadConfig().workspaceRoot, ruleByLmsId(courseId)!.slug, "_course");

interface Attachment { name: string; filename: string; version: string; length: number }

function htmlOf(viewContent: string | null | undefined): string {
  if (!viewContent) return "";
  try {
    const v = JSON.parse(viewContent);
    return v.value ?? v.description ?? "";
  } catch {
    return viewContent;
  }
}

export function gitRepos(md: string): string[] {
  const urls = [...md.matchAll(/https?:\/\/git\.culab\.ru\/[^\s)"'\]]+/g)].map((m) => m[0]);
  return [...new Set(urls.map((u) => u.split("/-/")[0].replace(/\.git$/, "")))];
}

export function tryClone(repo: string, dest: string): string {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10" };
  if (existsSync(dest)) {
    const r = Bun.spawnSync(["git", "-C", dest, "pull", "--ff-only"], { timeout: 60_000, env });
    return r.exitCode === 0 ? "обновлён" : "уже есть, pull не удался";
  }
  const https = Bun.spawnSync(["git", "clone", "--depth", "1", `${repo}.git`, dest], { timeout: 90_000, env });
  if (https.exitCode === 0) return "склонирован";
  const sshUrl = repo.replace(/^https?:\/\/([^/]+)\//, "git@$1:") + ".git";
  const ssh = Bun.spawnSync(["git", "clone", "--depth", "1", sshUrl, dest], { timeout: 90_000, env });
  if (ssh.exitCode === 0) return "склонирован по SSH";
  return `не склонирован (нужен доступ к git.culab.ru по токену или SSH): ${ssh.stderr.toString().trim().split("\n").pop()}`;
}

/** Downloads one LMS file via a presigned link unless the same version is already on disk. */
async function download(a: Attachment, dir: string, manifest: Record<string, string>): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, safeName(a.name));
  if (manifest[path] === a.version && existsSync(path) && statSync(path).size === a.length) return path;
  const { url } = await lms<{ url: string }>(`/content/download-link?filename=${encodeURIComponent(a.filename)}&version=${a.version}`);
  // Buffer then write: streaming a large Response straight into Bun.write stalls on big PDFs.
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`${a.name}: ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  writeFileSync(`${path}.part`, buf);
  renameSync(`${path}.part`, path);
  manifest[path] = a.version;
  return path;
}

const rel = (path: string, base: string) => path.slice(base.length + 1);

/** Markdown for one LMS material item; attachments are referenced by their local path. */
async function itemMd(m: any, ctx: { base: string; attDir: string; manifest: Record<string, string>; errors: string[]; download: boolean }) {
  const fetchAtt = async (a: Attachment) => {
    if (!ctx.download) return `📎 ${a.name.normalize("NFC")}`;
    try {
      const p = await download(a, ctx.attDir, ctx.manifest);
      return `📎 [${a.name.normalize("NFC")}](<${rel(p, ctx.base)}>)`;
    } catch (e) {
      ctx.errors.push((e as Error).message);
      return `📎 ${a.name.normalize("NFC")} (не скачался, см. LMS)`;
    }
  };
  if (m.discriminator === "markdown") return td.turndown(htmlOf(m.viewContent));
  if (m.discriminator === "file" && m.content) return fetchAtt(m.content);
  if (m.estimation) {
    const e = m.estimation;
    const parts = [`### Задание: ${m.name}`, `Макс. ${e.maxScore} · дедлайн ${e.deadline ? new Date(e.deadline).toLocaleString("ru-RU") : "нет"} · активность «${e.activity?.name}»${e.activity?.isLateDaysEnabled ? " · late days можно" : ""}`];
    const desc = td.turndown(htmlOf(m.viewContent));
    if (desc.trim()) parts.push(desc);
    if (m.exerciseUrl || m.coding?.exerciseUrl) parts.push(`Ссылка на задание: ${m.exerciseUrl ?? m.coding.exerciseUrl}`);
    for (const a of m.attachments ?? []) parts.push(await fetchAtt(a));
    return parts.join("\n\n");
  }
  return `(материал типа ${m.discriminator}, см. LMS)`;
}

export interface MaterialsResult { dir: string; weeks: number; attachments: number; repos: string[]; cloneNotes: string[]; errors: string[] }

/**
 * Mirrors the whole course into ~/study/<course>/_course: one markdown file per week,
 * attachments, the syllabus and the course repo. Re-runs are cheap: files are re-downloaded only on a new version.
 */
export async function syncCourseMaterials(courseId: number, opts: { download?: boolean; clone?: boolean } = {}): Promise<MaterialsResult> {
  const rule = ruleByLmsId(courseId)!;
  const base = courseDir(courseId);
  mkdirSync(base, { recursive: true });
  const db = getDb();
  const course = db.query("SELECT * FROM courses WHERE id = ?").get(courseId) as any;
  const themes = db.query("SELECT id, name, ord, publish_date FROM themes WHERE course_id = ? ORDER BY ord").all(courseId) as any[];
  const manifestPath = join(base, ".manifest.json");
  const manifest: Record<string, string> = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
  const errors: string[] = [];
  const index: { file: string; name: string; date: string | null }[] = [];
  let allMd = "";

  for (const t of themes) {
    const nn = String(t.ord).padStart(2, "0");
    const file = `${nn}-${slugify(t.name)}.md`;
    const longreads = db.query("SELECT id, name FROM longreads WHERE theme_id = ? ORDER BY ord").all(t.id) as any[];
    const ctx = { base, attDir: join(base, "attachments", `${nn}-${slugify(t.name)}`), manifest, errors, download: opts.download !== false };
    const parts: string[] = [`# ${t.name}`, t.publish_date ? `_Опубликовано ${new Date(t.publish_date).toLocaleDateString("ru-RU")}_` : ""];
    for (const l of longreads) {
      const mats = await api.materials(l.id).catch(() => ({ items: [] as any[] }));
      const items = (mats?.items ?? []).sort((a: any, b: any) => a.order - b.order);
      const body: string[] = [];
      for (const m of items) body.push(await itemMd(m, ctx));
      parts.push(`## ${l.name}\n\nLMS: https://my.centraluniversity.ru/learn/courses/view/actual/${courseId}/themes/${t.id}/longreads/${l.id}\n\n${body.join("\n\n")}`);
    }
    const md = parts.filter(Boolean).join("\n\n");
    allMd += md;
    writeFileSync(join(base, file), md);
    index.push({ file, name: t.name, date: t.publish_date });
  }

  const repos = gitRepos(allMd);
  const cloneNotes: string[] = [];
  if (opts.clone !== false) for (const r of repos) cloneNotes.push(`- ${r}: ${tryClone(r, join(base, "repo", r.split("/").pop()!))}`);

  // Syllabus snapshot from the public mirror
  const ov = courseOverride(courseId);
  const syllabusUrl = (ov.syllabusUrl || course?.syllabus_url || "").replace("https://note.cu.ru/", "https://cuhandlog.ru/");
  if (syllabusUrl) {
    const html = await fetch(syllabusUrl).then((r) => (r.ok ? r.text() : "")).catch(() => "");
    const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0];
    if (main) writeFileSync(join(base, "SYLLABUS.md"), `# Силлабус: ${rule.title}\n\nИсточник: ${syllabusUrl}\n\n${td.turndown(main.replace(/<script[\s\S]*?<\/script>/gi, ""))}`);
  }

  const links = [
    `- LMS: https://my.centraluniversity.ru/learn/courses/view/actual/${courseId}`,
    syllabusUrl && `- Силлабус: ${syllabusUrl} (копия: SYLLABUS.md)`,
    (ov.timeUrl || course?.time_url) && `- Канал в TiMe: ${ov.timeUrl || course.time_url}`,
    ...(ov.links ?? []).map((l) => `- ${l.label}: ${l.url}`),
    ...repos.map((r) => `- Репозиторий: ${r} (клон: repo/)`),
  ].filter(Boolean);
  const attCount = Object.keys(manifest).length;
  writeFileSync(join(base, "README.md"), `# ${rule.title}: все материалы курса

Обновлено ${new Date().toLocaleString("ru-RU")}. Папку собирает «Учебный штаб» из LMS, руками не правь: перезапишется.

## Ссылки
${links.join("\n")}

## Политика ИИ курса
${rule.ai_policy.note}

## По неделям
${index.map((i) => `- [${i.name}](<${i.file}>)${i.date ? ` · ${new Date(i.date).toLocaleDateString("ru-RU")}` : ""}`).join("\n")}

## Вложения
${attCount ? `Файлов: ${attCount}, лежат в attachments/<неделя>/.` : "Нет."}
${cloneNotes.length ? `\n## Репозиторий\n${cloneNotes.join("\n")}` : ""}
`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  writeCourseRoot(courseId);
  setMeta(`materialsSyncedAt:${courseId}`, new Date().toISOString());
  return { dir: base, weeks: index.length, attachments: attCount, repos, cloneNotes, errors };
}

/** Course-folder sync for every tracked graded course, at most every `everyH` hours. */
export async function syncAllMaterials(everyH = 6) {
  const db = getDb();
  const ids = (db.query("SELECT id FROM courses WHERE tracked = 1").all() as { id: number }[]).map((r) => r.id);
  const out: Record<string, unknown> = {};
  for (const id of ids) {
    const rule = ruleByLmsId(id);
    if (!rule || rule.graded === false) continue;
    const last = db.query("SELECT value FROM meta WHERE key = ?").get(`materialsSyncedAt:${id}`) as { value: string } | null;
    if (last && Date.now() - Date.parse(last.value) < everyH * 3_600_000) continue;
    const r = await syncCourseMaterials(id);
    out[rule.short] = { weeks: r.weeks, attachments: r.attachments, errors: r.errors.length };
  }
  return out;
}

/** Reads the course index or one week file for the MCP tool. */
export function readCourseMaterials(courseId: number, week?: string): string {
  const base = courseDir(courseId);
  if (!existsSync(join(base, "README.md"))) return "Материалы курса ещё не синхронизированы: вызови sync или workspace_create.";
  if (!week) return readFileSync(join(base, "README.md"), "utf8");
  const files = new Bun.Glob("*.md").scanSync(base);
  const q = week.toLowerCase();
  for (const f of files) {
    if (f === "README.md" || f === "SYLLABUS.md") continue;
    const md = readFileSync(join(base, f), "utf8");
    const title = md.split("\n")[0].toLowerCase();
    if (f.startsWith(q.padStart(2, "0") + "-") || title.includes(`неделя ${q}:`) || title.includes(q)) return md;
  }
  if (/силлабус|syllabus/.test(q) && existsSync(join(base, "SYLLABUS.md"))) return readFileSync(join(base, "SYLLABUS.md"), "utf8");
  return `Неделя «${week}» не найдена. Оглавление:\n\n${readFileSync(join(base, "README.md"), "utf8")}`;
}

/** ~/study/<course>/ is itself a Claude Code project: chat about the whole course opens here. */
export function writeCourseRoot(courseId: number) {
  const rule = ruleByLmsId(courseId)!;
  const root = join(loadConfig().workspaceRoot, rule.slug);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "CLAUDE.md"), `# Курс «${rule.title}»

Папка курса в «Учебном штабе» студента Центрального университета.

- _course/: зеркало LMS. README.md (оглавление, ссылки, политика ИИ), файл на каждую неделю, attachments/
  (лекции, презентации, условия заданий), SYLLABUS.md (система оценивания), repo/ (репозиторий курса).
- Остальные подпапки: рабочие папки отдельных задач (BRIEF.md, MATERIALS.md, свой CLAUDE.md с режимом агента).
- COURSE_NOTES.md (если есть): правила самого студента для курса, важнее общих инструкций.
- HISTORY.md (если есть): прошлые работы студента по курсу и где они лежат.
- ~/study/_templates/: общие шаблоны ЦУ.

MCP cu-hub: course_grades, course_materials, board_get, study_plan, workspace_create.

Политика ИИ курса: ${rule.ai_policy.note}
`);
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { "cu-hub": { command: "bun", args: [join(ROOT, "src/mcp/server.ts")] } } }, null, 2));
  return root;
}
