import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import YAML from "yaml";

export const ROOT = join(import.meta.dir, "..");
export const DATA_DIR = process.env.CU_HUB_DATA ?? join(homedir(), ".cu-hub");
export const PROFILE_DIR = join(DATA_DIR, "browser-profile");
export const COOKIES_FILE = join(DATA_DIR, "cookies.json");
export const DB_FILE = join(DATA_DIR, "hub.sqlite");
export const RULES_DIR = join(ROOT, "rules");

mkdirSync(DATA_DIR, { recursive: true });

export const LMS_ORIGIN = "https://my.centraluniversity.ru";

export interface HubConfig {
  workspaceRoot: string;
  webPort: number;
  syncIntervalMin: number;
  caldav?: {
    url: string;
    username: string;
    /** macOS Keychain service name holding the app password */
    keychainService: string;
    /** calendar display names to read; empty = all */
    calendars?: string[];
  };
  reminders: { beforeClassMin: number; digestAt: string; weeklyReviewAt: string };
}

const DEFAULTS: HubConfig = {
  workspaceRoot: join(homedir(), "study"),
  webPort: 4321,
  syncIntervalMin: 30,
  reminders: { beforeClassMin: 40, digestAt: "08:00", weeklyReviewAt: "Sun 20:00" },
};

export const CONFIG_FILE = join(DATA_DIR, "config.yaml");

export function loadConfig(): HubConfig {
  if (!existsSync(CONFIG_FILE)) return DEFAULTS;
  const user = YAML.parse(readFileSync(CONFIG_FILE, "utf8")) ?? {};
  return {
    ...DEFAULTS,
    ...user,
    workspaceRoot: (user.workspaceRoot ?? DEFAULTS.workspaceRoot).replace(/^~/, homedir()),
    reminders: { ...DEFAULTS.reminders, ...(user.reminders ?? {}) },
  };
}
