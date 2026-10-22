import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { RULES_DIR } from "../config";

export type AiMode = "execute" | "assist" | "tutor_only";
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
  ai_policy: { mode: AiMode; note: string };
  activities: ActivityRule[];
  blockers: BlockerRule[];
  exclude_exercises?: string[];
  calendar?: { match: string[]; kinds: Record<string, EventKindRule> };
  prep?: { before: string; title: string; effort_h: number }[];
}

let cache: CourseRule[] | null = null;

export function loadRules(): CourseRule[] {
  if (cache) return cache;
  cache = readdirSync(RULES_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => ({ graded: true, ...YAML.parse(readFileSync(join(RULES_DIR, f), "utf8")) }) as CourseRule);
  return cache;
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

export const AI_MODE_LABEL: Record<AiMode, string> = {
  execute: "агент может делать черновик",
  assist: "вместе, с объяснением каждого шага",
  tutor_only: "только наводящие вопросы, решение пишешь сам",
};
