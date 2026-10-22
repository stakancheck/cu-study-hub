import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { loadConfig, onConfigChange, RULES_DIR } from "../config";

export type ActKind = "homework" | "test" | "project" | "exam" | "seminar" | "attendance" | "bonus";

export interface ActivityRule {
  key: string;
  lms: string;
  weight: number;
  planned: number;
  late_days: boolean;
  kind: ActKind;
  effort_h: number;
}

export interface BlockerRule {
  label: string;
  activity: string;
  min?: number;
  match?: string;
  count?: number;
  all_submitted?: boolean;
}

export interface EventKindRule {
  match: string[];
  activities: string[];
  recording?: boolean;
  note?: string;
}

export interface CourseRule {
  slug: string;
  lms_id: number;
  title: string;
  short: string;
  color: string;
  assessment: string;
  pass_threshold: number;
  rounding: string | null;
  graded?: boolean;
  activities: ActivityRule[];
  blockers: BlockerRule[];
  exclude_exercises?: string[];
  calendar?: { match: string[]; kinds: Record<string, EventKindRule> };
  prep?: { before: string; title: string; effort_h: number }[];
  plan?: PlanRule[];
}

export type PlanKind = "test" | "project" | "exam";
/** A checkpoint from the syllabus / handbook schedule: by academic week, week range or a whole period (session). */
export interface PlanRule {
  title: string;
  kind: PlanKind;
  week?: number;
  weeks?: [number, number];
  period?: string;
  approx?: boolean;
}

export interface AcademicPeriod { title: string; kind: string; from: string; to: string }
export interface AcademicCalendar { semester_start: string; semester_weeks: number; periods: AcademicPeriod[] }

export function loadAcademic(): AcademicCalendar {
  const f = join(RULES_DIR, "_academic.yaml");
  return YAML.parse(readFileSync(f, "utf8"));
}

let cache: CourseRule[] | null = null;
onConfigChange(() => (cache = null));

/** Rules from rules/*.yaml with the user's local overrides (names, colours, calendar patterns) applied. */
export function loadRules(): CourseRule[] {
  if (cache) return cache;
  const overrides = loadConfig().courses;
  cache = readdirSync(RULES_DIR)
    .filter((f) => f.endsWith(".yaml") && !f.startsWith("_"))
    .map((f) => {
      const r = { graded: true, ...YAML.parse(readFileSync(join(RULES_DIR, f), "utf8")) } as CourseRule;
      const o = overrides[String(r.lms_id)];
      if (!o) return r;
      const calendar = o.calendarMatch?.length
        ? { kinds: {}, ...r.calendar, match: [...(r.calendar?.match ?? []), ...o.calendarMatch] }
        : r.calendar;
      return { ...r, title: o.title || r.title, short: o.short || r.short, color: o.color || r.color, calendar };
    });
  return cache;
}

/** Same rules without local overrides: the defaults shown in settings. */
export function baseRules(): CourseRule[] {
  return readdirSync(RULES_DIR)
    .filter((f) => f.endsWith(".yaml") && !f.startsWith("_"))
    .map((f) => ({ graded: true, ...YAML.parse(readFileSync(join(RULES_DIR, f), "utf8")) }) as CourseRule);
}

export function ruleByLmsId(id: number): CourseRule | undefined {
  return loadRules().find((r) => r.lms_id === id);
}

export function ruleBySlug(q: string): CourseRule | undefined {
  const s = q.toLowerCase();
  return loadRules().find(
    (r) => r.slug === s || r.short.toLowerCase() === s || r.title.toLowerCase().includes(s) || String(r.lms_id) === s,
  );
}

export const norm = (s: string) => s.replace(/ /g, " ").replace(/\s+/g, " ").trim().toLowerCase();

