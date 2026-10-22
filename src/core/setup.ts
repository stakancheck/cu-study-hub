import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { COOKIES_FILE, loadConfig, saveConfig, USER_RULES_DIR, writeProjectMcp } from "../config";
import { api, type LmsActivity, type LmsCourse } from "../connectors/lms/client";
import { interactiveLogin } from "../connectors/lms/session";
import { getDb } from "./db";
import { type ActKind, type ActivityRule, allRuleFiles, type CourseRule, type RuleSource } from "./rules";

// ---------- first-run state ----------

/** Installs from before the wizard count as set up once they have a session and tracked courses. */
export function setupDone(): boolean {
  const c = loadConfig();
  if (c.setupDone !== undefined) return c.setupDone;
  return existsSync(COOKIES_FILE) && !!getDb().query("SELECT 1 FROM courses WHERE tracked = 1 LIMIT 1").get();
}

type LoginStatus = "idle" | "installing" | "waiting" | "ok" | "error";
const login: { status: LoginStatus; error: string | null } = { status: "idle", error: null };

export async function lmsSession(): Promise<{ ok: boolean; name: string | null }> {
  if (!existsSync(COOKIES_FILE)) return { ok: false, name: null };
  try {
    const me = await api.me();
    return { ok: true, name: [me?.firstName, me?.lastName].filter(Boolean).join(" ") || null };
  } catch {
    return { ok: false, name: null };
  }
}

export function loginState() {
  return { ...login };
}

/** Opens the LMS window in the background; the wizard polls loginState(). */
export function startLogin() {
  if (login.status === "waiting" || login.status === "installing") return loginState();
  login.status = "waiting";
  login.error = null;
  interactiveLogin(10, () => (login.status = "installing"))
    .then(() => (login.status = "ok"))
    .catch((e) => {
      login.status = "error";
      login.error = (e as Error).message;
    });
  return loginState();
}

// ---------- rules from LMS ----------

const TR: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n",
  о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya",
};
const latin = (s: string) =>
  s.normalize("NFC").toLowerCase().split("").map((ch) => TR[ch] ?? ch).join("")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Short latin slug from the first meaningful words: «Системный анализ» → sistemnyy-analiz. */
export const ruleSlug = (name: string) => latin(name).split("-").filter(Boolean).slice(0, 3).join("-").slice(0, 32) || "course";

// Order matters: «Итоговый проект» is a project, «Защита решения семинарской задачи» and «Активность на семинаре» are attendance.
const KINDS: [RegExp, ActKind, number][] = [
  [/бонус|дополнит/i, "bonus", 1],
  [/проект/i, "project", 10],
  [/экзамен|зач[её]т/i, "exam", 10],
  [/контрольн|тест|квиз|опрос/i, "test", 2],
  [/домашн|дз\b/i, "homework", 5],
  [/аудитор|посещ|активност|защит|кейс|работа на заняти/i, "attendance", 0.5],
  [/семинар|практи/i, "seminar", 1.5],
  [/итогов/i, "exam", 10],
];
export const guessKind = (name: string): [ActKind, number] => {
  const k = KINDS.find(([re]) => re.test(name));
  return k ? [k[1], k[2]] : ["homework", 3];
};

const COLORS = ["blue", "orange", "green", "purple", "pink", "yellow", "brown", "red", "gray"];
const SKIP_WORDS = new Set(["основы", "введение", "курс", "практикум", "практика", "разработка", "теория", "семинар", "лекции"]);

/** «Основы компьютерных сетей» → «компьютерные…» stem for calendar event titles. */
function calendarStem(name: string): string {
  const words = name.toLowerCase().replace(/ё/g, "е").match(/[a-zа-я]{4,}/gi) ?? [];
  const w = words.find((x) => !SKIP_WORDS.has(x)) ?? words[0] ?? name.toLowerCase();
  return w.slice(0, Math.min(w.length, 6)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function shortName(name: string): string {
  const t = name.replace(/[«»"]/g, "").trim();
  if (t.length <= 14) return t;
  const words = t.split(/[\s:,.-]+/).filter((w) => w.length > 2 && !SKIP_WORDS.has(w.toLowerCase()));
  return (words[0] ?? t).slice(0, 14);
}

/** A course rule built only from LMS data: weights, planned counts, late days. Blockers need the syllabus. */
export function ruleFromLms(c: Pick<LmsCourse, "id" | "name">, acts: LmsActivity[], opts: { short: string; color: string; slug: string }): CourseRule {
  const graded = acts.filter((a) => a.weight > 0);
  const used = new Set<string>();
  const activities: ActivityRule[] = graded.map((a) => {
    const [kind, effort] = guessKind(a.name);
    let key = latin(a.name).split("-").slice(0, 2).join("_") || `act_${a.id}`;
    while (used.has(key)) key += "_";
    used.add(key);
    return { key, lms: a.name.trim(), weight: a.weight, planned: Math.max(1, a.maxExercisesCount), late_days: a.isLateDaysEnabled, kind, effort_h: effort };
  });
  const hasExam = graded.some((a) => /экзамен/i.test(a.name));
  return {
    slug: opts.slug,
    lms_id: c.id,
    title: c.name.trim(),
    short: opts.short,
    color: opts.color,
    assessment: hasExam ? "экзамен" : "зачёт",
    pass_threshold: 3.5,
    rounding: null,
    graded: graded.length > 0,
    activities,
    blockers: [],
    // No calendar match for courses without grades (practice, onboarding): a generic stem would steal other courses' classes.
    calendar: graded.length === 0 ? undefined : {
      match: [calendarStem(c.name)],
      kinds: {
        seminar: { match: ["семинар", "практик"], activities: activities.filter((a) => a.kind === "attendance" || a.kind === "seminar").map((a) => a.key) },
        lecture: { match: ["лекци"], activities: [], recording: true },
      },
    },
    prep: [],
    plan: [],
  };
}

function writeUserRule(r: CourseRule) {
  const head = [
    `# ${r.title} · создано мастером настройки из данных LMS`,
    "# Веса и число работ взяты из LMS. Проверь по силлабусу: блокеры (blockers), порог (pass_threshold),",
    "# виды активностей (kind) и контрольные точки по неделям (plan). Описание полей: rules/README.md",
  ].join("\n");
  writeFileSync(join(USER_RULES_DIR, `${r.slug}.yaml`), `${head}\n${YAML.stringify(r, { lineWidth: 0 })}`);
}

// ---------- wizard: courses ----------

export interface SetupCourse {
  id: number;
  name: string;
  category: string;
  archived: boolean;
  /** where rules come from: a syllabus-based file, one made by the wizard, or none yet */
  rule: RuleSource | null;
  ruleFile: string | null;
  tracked: boolean;
  short: string;
  color: string;
  activities: { name: string; weight: number; planned: number; lateDays: boolean; kind: ActKind }[];
  totalWeight: number;
}

export async function setupCourses(): Promise<SetupCourse[]> {
  const { items } = await api.courses();
  const files = new Map(allRuleFiles().map((x) => [x.rule.lms_id, x]));
  const cfg = loadConfig();
  const out = await Promise.all(items.map(async (c, i): Promise<SetupCourse> => {
    const acts = await api.activities(c.id).catch(() => [] as LmsActivity[]);
    const f = files.get(c.id);
    const graded = acts.filter((a) => a.weight > 0);
    const totalWeight = Math.round(graded.reduce((s, a) => s + a.weight, 0) * 100) / 100;
    const ov = cfg.courses[String(c.id)] ?? {};
    return {
      id: c.id, name: c.name.trim(), category: c.category, archived: c.isArchived,
      rule: f?.source ?? null, ruleFile: f?.file ?? null,
      tracked: cfg.trackedCourses ? cfg.trackedCourses.includes(c.id) : f ? true : !c.isArchived && totalWeight > 0,
      short: ov.short || f?.rule.short || shortName(c.name),
      color: ov.color || f?.rule.color || COLORS[i % COLORS.length],
      activities: graded.map((a) => ({ name: a.name.trim(), weight: a.weight, planned: a.maxExercisesCount, lateDays: a.isLateDaysEnabled, kind: guessKind(a.name)[0] })),
      totalWeight,
    };
  }));
  return out.sort((a, b) => Number(b.tracked) - Number(a.tracked) || b.totalWeight - a.totalWeight || a.name.localeCompare(b.name));
}

/** Saves the course choice: writes rules for courses that have none, names and colours go to config overrides. */
export async function applyCourses(sel: { id: number; short: string; color: string }[]) {
  const { items } = await api.courses();
  const files = new Map(allRuleFiles().map((x) => [x.rule.lms_id, x]));
  const slugs = new Set(allRuleFiles().map((x) => x.rule.slug));
  const courses = { ...loadConfig().courses };
  for (const s of sel) {
    const c = items.find((x) => x.id === s.id);
    if (!c) continue;
    const f = files.get(c.id);
    if (!f) {
      let slug = ruleSlug(c.name);
      while (slugs.has(slug)) slug += `-${c.id}`;
      slugs.add(slug);
      writeUserRule(ruleFromLms(c, await api.activities(c.id), { short: s.short.trim() || shortName(c.name), color: s.color, slug }));
      continue;
    }
    const o = { ...(courses[String(c.id)] ?? {}) };
    if (s.short.trim() && s.short.trim() !== f.rule.short) o.short = s.short.trim(); else delete o.short;
    if (s.color && s.color !== f.rule.color) o.color = s.color; else delete o.color;
    if (Object.keys(o).length) courses[String(c.id)] = o; else delete courses[String(c.id)];
  }
  saveConfig({ trackedCourses: sel.map((s) => s.id), courses });
}

export function finishSetup() {
  saveConfig({ setupDone: true });
  writeProjectMcp();
}
