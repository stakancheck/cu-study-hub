import { classes, type ClassEvent, VERDICT_LABEL } from "./attendance";
import { getMeta } from "./db";
import { semester, weekOf } from "./plan";
import { adviseLateDays, type CourseGrade, gradeAll, ldNeededNow, openItems, recoverable, type WorkItem, workItems } from "./engine";

const HOUR = 3_600_000;

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export interface Alert { level: "crit" | "warn" | "info"; course: string; text: string }

export function alerts(grades: CourseGrade[]): Alert[] {
  const out: Alert[] = [];
  for (const g of grades) {
    if (g.status === "impossible") out.push({ level: "crit", course: g.short, text: `Порог ${g.threshold} недостижим: максимум ${g.maxReachable.toFixed(2)}. Нужны дорешки или пересдача.` });
    for (const b of g.blockers) {
      if (b.status === "failed") out.push({ level: "crit", course: g.short, text: `Блокер «${b.label}» не выполнен: ${b.detail}.` });
      if (b.status === "risk") out.push({ level: "warn", course: g.short, text: `Блокер «${b.label}» под угрозой: ${b.detail}.` });
    }
    if (g.status === "risk") out.push({ level: "crit", course: g.short, text: `Нужно ${Math.round(g.neededShare * 100)}% от оставшихся баллов, чтобы набрать ${g.threshold}.` });
    else if (g.status === "watch") out.push({ level: "warn", course: g.short, text: `Нужно ${Math.round(g.neededShare * 100)}% от оставшихся баллов: запаса мало.` });
    for (const w of g.warnings) out.push({ level: "info", course: g.short, text: w });
  }
  const order = { crit: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

export function today() {
  const grades = gradeAll();
  const items = workItems(grades);
  const rescue = items.filter((i) => i.state === "overdue").sort((a, b) => b.priority - a.priority);
  const open = openItems(items);
  const sod = startOfDay();
  const eod = new Date(sod.getTime() + 24 * HOUR);
  const todays = classes(sod.toISOString(), eod.toISOString(), grades);
  const soon = open.filter((i) => i.hoursLeft != null && i.hoursLeft <= 72);
  return {
    date: new Date().toISOString(),
    lateDaysBalance: Number(getMeta("lateDaysBalance") ?? NaN) || null,
    syncedAt: { lms: getMeta("lmsSyncedAt"), calendar: getMeta("calSyncedAt") },
    alerts: [
      ...rescue.map((i) => ({ level: (i.blocker ? "crit" : "warn") as Alert["level"], course: i.course,
        text: `«${i.title}» просрочено, но спасается за ${ldNeededNow(i.deadline!)} LD сегодня (+${i.delta.toFixed(2)}${i.blocker ? `, блокер «${i.blocker}»` : ""}).` })),
      ...alerts(grades),
    ],
    classes: todays,
    deadlines72h: soon,
    top: open.slice(0, 3).map((i) => ({ ...i, lateDayAdvice: i.hoursLeft != null && i.hoursLeft < 36 && i.lateDaysAllowed ? adviseLateDays(i) : null })),
    courses: grades.map((g) => ({ id: g.id, short: g.short, status: g.status, earned: g.earned, maxReachable: g.maxReachable, threshold: g.threshold })),
  };
}

export interface DayPlan { date: string; classes: ClassEvent[]; due: WorkItem[]; loadH: number; overloaded: boolean; suggestions: string[] }

export function week(): { week: number | null; weeks: number; days: DayPlan[]; recoverable: WorkItem[] } {
  const grades = gradeAll();
  const items = workItems(grades);
  const open = openItems(items);
  const sod = startOfDay();
  const days: DayPlan[] = [];
  for (let d = 0; d < 7; d++) {
    const from = new Date(sod.getTime() + d * 24 * HOUR);
    const to = new Date(from.getTime() + 24 * HOUR);
    const cls = classes(from.toISOString(), to.toISOString(), grades);
    const due = open.filter((i) => i.deadline && new Date(i.deadline) >= from && new Date(i.deadline) < to);
    const classH = cls.filter((c) => c.verdict === "must" || c.verdict === "should").length * 1.5;
    const loadH = due.reduce((s, i) => s + i.effortH, 0) + classH;
    const suggestions: string[] = [];
    if (loadH > 8) {
      const movable = due.filter((i) => i.lateDaysAllowed && !i.blocker).sort((a, b) => a.priority - b.priority);
      for (const m of movable.slice(0, 2)) suggestions.push(`Перенести «${m.title}» (${m.course}) на 1-2 LD: день перегружен (${loadH.toFixed(1)} ч).`);
    }
    days.push({ date: from.toISOString(), classes: cls, due, loadH, overloaded: loadH > 8, suggestions });
  }
  return { week: weekOf(), weeks: semester().weeks, days, recoverable: recoverable(items) };
}

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
const fmtDue = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("ru-RU", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "без срока";

export function digestMarkdown(t = today()): string {
  const lines: string[] = [];
  const wk = weekOf();
  lines.push(`# Сегодня, ${new Date().toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" })}${wk ? ` · неделя ${wk} из ${semester().weeks}` : ""}`);
  if (t.lateDaysBalance != null) lines.push(`Late days на балансе: **${t.lateDaysBalance}**`);
  const crit = t.alerts.filter((a) => a.level !== "info");
  if (crit.length) {
    lines.push("", "## Внимание");
    for (const a of crit) lines.push(`- ${a.level === "crit" ? "🔴" : "🟠"} **${a.course}**: ${a.text}`);
  }
  lines.push("", "## Пары");
  if (!t.classes.length) lines.push("- Сегодня пар нет (или календарь не синхронизирован).");
  for (const c of t.classes) lines.push(`- ${fmtTime(c.start)} **${c.course ?? "?"}** ${c.title}: ${VERDICT_LABEL[c.verdict]}. ${c.reason}`);
  lines.push("", "## Главное на сегодня");
  t.top.forEach((i, n) => {
    lines.push(`${n + 1}. **${i.course}** · ${i.title} (до ${fmtDue(i.deadline)}, +${i.delta.toFixed(2)}${i.blocker ? `, блокер «${i.blocker}»` : ""})`);
    if (i.lateDayAdvice?.allowed) lines.push(`   - LD: ${i.lateDayAdvice.reasoning}`);
  });
  lines.push("", "## Дедлайны на 72 часа");
  if (!t.deadlines72h.length) lines.push("- Нет.");
  for (const i of t.deadlines72h)
    lines.push(`- ${fmtDue(i.deadline)} · **${i.course}** · ${i.title}${i.state === "notCreated" ? " (в LMS ещё нет карточки)" : ""}${i.lateDaysAllowed ? " · LD можно" : ""}`);
  return lines.join("\n");
}
