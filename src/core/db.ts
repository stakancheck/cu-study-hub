import { Database } from "bun:sqlite";
import { DB_FILE } from "../config";

let db: Database | null = null;

export function getDb(): Database {
  if (db) return db;
  db = new Database(DB_FILE, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(d: Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT,
      category TEXT,
      syllabus_url TEXT,
      time_url TEXT,
      archived INTEGER DEFAULT 0,
      tracked INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS themes (
      id INTEGER PRIMARY KEY,
      course_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      ord INTEGER,
      publish_date TEXT
    );

    CREATE TABLE IF NOT EXISTS longreads (
      id INTEGER PRIMARY KEY,
      theme_id INTEGER NOT NULL,
      course_id INTEGER NOT NULL,
      name TEXT,
      ord INTEGER
    );

    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY,
      course_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      weight REAL NOT NULL,
      planned INTEGER,
      exercises_count INTEGER,
      avg_threshold REAL,
      best_scores_count INTEGER,
      late_days INTEGER
    );

    CREATE TABLE IF NOT EXISTS exercises (
      id INTEGER PRIMARY KEY,
      course_id INTEGER NOT NULL,
      theme_id INTEGER,
      longread_id INTEGER,
      activity_id INTEGER,
      name TEXT NOT NULL,
      max_score REAL,
      deadline TEXT
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY,
      exercise_id INTEGER,
      course_id INTEGER,
      state TEXT,
      score REAL,
      extra_score REAL,
      deadline TEXT,
      submit_at TEXT,
      evaluate_at TEXT,
      late_days INTEGER,
      late_days_enabled INTEGER,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      uid TEXT PRIMARY KEY,
      start TEXT NOT NULL,
      end TEXT,
      title TEXT NOT NULL,
      location TEXT,
      description TEXT,
      calendar TEXT,
      course_id INTEGER,
      kind TEXT
    );

    -- local-only state layered over synced data
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,           -- "task:123", "ex:456", "event:uid", "prep:...", "manual:..."
      kind TEXT NOT NULL,
      course_id INTEGER,
      title TEXT,
      col TEXT,                      -- manual column override
      ord REAL DEFAULT 0,
      due TEXT,
      notes TEXT,
      effort_h REAL,
      hidden INTEGER DEFAULT 0,
      done INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS attendance (
      event_uid TEXT PRIMARY KEY,
      attended INTEGER,
      note TEXT,
      at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      key TEXT PRIMARY KEY,
      at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS syllabus_snapshots (
      course_id INTEGER PRIMARY KEY,
      url TEXT,
      hash TEXT,
      fetched_at TEXT,
      changed INTEGER DEFAULT 0
    );
  `);
}

export function getMeta(key: string): string | null {
  const row = getDb().query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string) {
  getDb().query("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
