import ICAL from "ical.js";
import { createDAVClient } from "tsdav";
import { loadConfig } from "../config";
import { getDb, setMeta } from "../core/db";
import { loadRules } from "../core/rules";

const DAY = 86_400_000;

export interface CalEvent {
  uid: string;
  start: Date;
  end: Date;
  title: string;
  location: string;
  description: string;
  calendar: string;
}

function keychainPassword(service: string, account: string): string {
  const r = Bun.spawnSync(["security", "find-generic-password", "-s", service, "-a", account, "-w"]);
  if (r.exitCode !== 0)
    throw new Error(`Нет пароля в Keychain (service=${service}, account=${account}). См. README, раздел «Календарь».`);
  return r.stdout.toString().trim();
}

export function expandIcs(ics: string, calendar: string, from: Date, to: Date): CalEvent[] {
  const comp = new ICAL.Component(ICAL.parse(ics));
  const vevents = comp.getAllSubcomponents("vevent");
  const masters = vevents.filter((v) => !v.hasProperty("recurrence-id"));
  const exceptions = vevents.filter((v) => v.hasProperty("recurrence-id"));
  const out: CalEvent[] = [];
  for (const v of masters) {
    const ev = new ICAL.Event(v);
    for (const ex of exceptions) if (ex.getFirstPropertyValue("uid") === ev.uid) ev.relateException(ex);
    const base = { title: ev.summary ?? "", location: ev.location ?? "", description: ev.description ?? "", calendar };
    if (!ev.isRecurring()) {
      const s = ev.startDate.toJSDate();
      if (s >= from && s <= to) out.push({ uid: ev.uid, start: s, end: ev.endDate.toJSDate(), ...base });
      continue;
    }
    const it = ev.iterator();
    let next: ICAL.Time | null;
    let guard = 0;
    while ((next = it.next()) && guard++ < 2000) {
      const s = next.toJSDate();
      if (s > to) break;
      if (s < from) continue;
      const occ = ev.getOccurrenceDetails(next);
      out.push({
        uid: `${ev.uid}@${next.toString()}`,
        start: occ.startDate.toJSDate(),
        end: occ.endDate.toJSDate(),
        title: occ.item.summary ?? base.title,
        location: occ.item.location ?? base.location,
        description: occ.item.description ?? base.description,
        calendar,
      });
    }
  }
  return out;
}

export function classify(title: string, description = ""): { courseId: number | null; kind: string | null } {
  const text = `${title} ${description}`;
  for (const r of loadRules()) {
    if (!r.calendar) continue;
    if (!r.calendar.match.some((m) => new RegExp(m, "i").test(title))) continue;
    for (const [kind, k] of Object.entries(r.calendar.kinds))
      if (k.match.some((m) => new RegExp(m, "i").test(text))) return { courseId: r.lms_id, kind };
    return { courseId: r.lms_id, kind: "other" };
  }
  return { courseId: null, kind: null };
}

export async function syncCalendar(): Promise<{ events: number; matched: number; calendars: string[] }> {
  const cfg = loadConfig().caldav;
  if (!cfg) throw new Error("CalDAV не настроен: добавь секцию caldav в ~/.cu-hub/config.yaml");
  const client = await createDAVClient({
    serverUrl: cfg.url,
    credentials: { username: cfg.username, password: keychainPassword(cfg.keychainService, cfg.username) },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
  const from = new Date(Date.now() - 14 * DAY);
  const to = new Date(Date.now() + 35 * DAY);
  const all = await client.fetchCalendars();
  const wanted = all.filter((c) => !cfg.calendars?.length || cfg.calendars.includes(String(c.displayName)));
  const events: CalEvent[] = [];
  for (const cal of wanted) {
    const objs = await client.fetchCalendarObjects({
      calendar: cal,
      timeRange: { start: from.toISOString(), end: to.toISOString() },
    });
    for (const o of objs) if (o.data) events.push(...expandIcs(o.data, String(cal.displayName), from, to));
  }

  const db = getDb();
  const up = db.query(`INSERT INTO events(uid, start, end, title, location, description, calendar, course_id, kind)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(uid) DO UPDATE SET start=excluded.start, end=excluded.end, title=excluded.title,
    location=excluded.location, description=excluded.description, calendar=excluded.calendar,
    course_id=excluded.course_id, kind=excluded.kind`);
  let matched = 0;
  db.transaction(() => {
    db.query("DELETE FROM events WHERE start >= ? AND start <= ?").run(from.toISOString(), to.toISOString());
    for (const e of events) {
      const c = classify(e.title, e.description);
      if (c.courseId) matched++;
      up.run(e.uid, e.start.toISOString(), e.end.toISOString(), e.title, e.location, e.description, e.calendar, c.courseId, c.kind);
    }
  })();
  setMeta("calSyncedAt", new Date().toISOString());
  return { events: events.length, matched, calendars: wanted.map((c) => String(c.displayName)) };
}
