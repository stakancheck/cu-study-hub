import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

// ---------- types (mirrors server payloads) ----------
type Col = "overdue" | "inbox" | "week" | "today" | "doing" | "review" | "done";
interface Card {
  id: string; kind: "lms" | "event" | "prep" | "manual"; courseId: number | null; course: string | null; color: string | null;
  title: string; subtitle: string; col: Col; due: string | null; delta: number; blocker: string | null; lateDays: boolean;
  state: string; verdict?: string; verdictLabel?: string; priority: number; notes: string; link?: string;
  score?: number | null; effortH?: number; ord: number;
}
interface Activity { key: string; name: string; kind: string; weight: number; syllabusWeight: number; planned: number; graded: number; earned: number; remaining: number; lost: number; itemValue: number; lateDays: boolean; scores: { name: string; score: number }[] }
interface Grade {
  id: number; slug: string; title: string; short: string; color: string; threshold: number; earned: number; lost: number; remaining: number;
  maxReachable: number; bonusLeft: number; neededShare: number; status: "ok" | "watch" | "risk" | "blocked" | "impossible";
  activities: Activity[]; blockers: { label: string; status: string; detail: string }[]; warnings: string[];
  waiting: { name: string; state: string }[]; rounding: string | null; syllabusUrl: string | null; timeUrl: string | null; links: { label: string; url: string }[];
}
interface ClassEv { uid: string; start: string; end: string; title: string; location: string; courseId: number | null; course: string | null; color: string | null; verdict: string; points: number; reason: string; attended: number | null }
interface Item { id: string; course: string; color: string; title: string; deadline: string | null; delta: number; blocker: string | null; lateDaysAllowed: boolean; state: string; hoursLeft: number | null; effortH: number; lateDayAdvice?: { allowed: boolean; reasoning: string; suggestDays: number } | null }
interface State {
  today: { alerts: { level: string; course: string; text: string }[]; classes: ClassEv[]; deadlines72h: Item[]; top: Item[] };
  grades: Grade[];
  board: { columns: { id: Col; title: string }[]; cards: Card[] };
  meta: { week: number | null; weeks: number; lateDaysBalance: number | null; lmsSyncedAt: string | null; calSyncedAt: string | null; lastSync: { errors: string[] } | null; syncing: boolean; calendarConfigured: boolean; setupDone: boolean };
}

interface AgentRun { id: string; card_id: string; dir: string; status: "running" | "done" | "failed"; started_at: string; finished_at: string | null; session_id: string | null; summary: string | null; cost_usd: number | null; mode: string }

// ---------- helpers ----------
const api = async <T,>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> => {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json" }, body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
};
const minsSince = (iso: string) => { const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000)); return m < 1 ? "только что" : `${m} мин`; };
const f2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const time = (iso: string) => new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
const ago = (iso: string | null) => {
  if (!iso) return "никогда";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? "только что" : m < 60 ? `${m} мин назад` : m < 1440 ? `${Math.round(m / 60)} ч назад` : `${Math.round(m / 1440)} дн назад`;
};
function dueLabel(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso), now = new Date();
  const h = (d.getTime() - now.getTime()) / 3.6e6;
  const day = d.toDateString() === now.toDateString() ? "Сегодня" : h > 0 && h < 48 && new Date(now.getTime() + 864e5).toDateString() === d.toDateString() ? "Завтра"
    : d.toLocaleDateString("ru-RU", { day: "numeric", month: "short", weekday: "short" });
  return `${day}, ${time(iso)}`;
}
function rangeLabel(a?: string, b?: string) {
  if (!a || !b) return "";
  const fa = new Date(a), fb = new Date(b);
  const same = fa.getMonth() === fb.getMonth();
  return `${fa.getDate()}${same ? "" : " " + fa.toLocaleDateString("ru-RU", { month: "long" })}–${fb.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}`;
}
const STATUS: Record<Grade["status"], [string, string]> = {
  ok: ["green", "В норме"], watch: ["yellow", "Мало запаса"], risk: ["orange", "Риск"], blocked: ["red", "Блокер"], impossible: ["red", "Не сдать по формуле"],
};
const VERDICT: Record<string, [string, string]> = {
  must: ["red", "Обязательно"], should: ["yellow", "Желательно"], recording: ["blue", "Можно запись"], optional: ["gray", "По желанию"], unknown: ["gray", "?"],
};
const LMS_STATE: Record<string, [string, string]> = {
  notCreated: ["gray", "Нет в LMS"], overdue: ["red", "Просрочено, можно спасти"], backlog: ["gray", "Не начато"], inProgress: ["blue", "В работе"], submitted: ["purple", "Отправлено"],
  review: ["purple", "На проверке"], evaluated: ["green", "Оценено"], failed: ["red", "Не сдано"], planned: ["gray", "Запланировано"],
  attended: ["green", "Был"], skipped: ["red", "Пропустил"], open: ["gray", "Открыто"], done: ["green", "Готово"],
};
const LMS_LOCKED = new Set(["submitted", "review", "evaluated", "failed"]);
const OPEN_STATES = new Set(["backlog", "inProgress", "notCreated", "overdue"]);
const COL_ICON: Record<Col, string> = { overdue: "⏰", inbox: "📥", week: "🗓️", today: "🔥", doing: "🛠️", review: "👀", done: "✅" };

const Tag = ({ c, children, title }: { c?: string | null; children: React.ReactNode; title?: string }) => <span className={`tag ${c ?? "gray"}`} title={title}>{children}</span>;

function Progress({ g }: { g: Grade }) {
  const scale = Math.max(10, g.maxReachable + g.lost);
  return (
    <div className="progress" title={`набрано ${f2(g.earned)}, потеряно ${f2(g.lost)}, порог ${g.threshold}`}>
      <div className="earned" style={{ width: `${(g.earned / scale) * 100}%` }} />
      <div className="lost" style={{ left: `${(g.earned / scale) * 100}%`, width: `${(g.lost / scale) * 100}%` }} />
      <div className="thr" style={{ left: `${(g.threshold / scale) * 100}%` }} />
    </div>
  );
}

// ---------- app ----------
type Route = { page: "today" } | { page: "board" } | { page: "week" } | { page: "settings" } | { page: "plan" } | { page: "setup" } | { page: "course"; slug: string };
const parseHash = (): Route => {
  const h = location.hash.slice(1);
  if (h.startsWith("course-")) return { page: "course", slug: h.slice(7) };
  if (h === "board" || h === "week" || h === "settings" || h === "plan" || h === "setup") return { page: h };
  return { page: "today" };
};

function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [state, setState] = useState<State | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [peek, setPeek] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(() => api<State>("/api/state").then(setState).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);
  useEffect(() => { const f = () => setRoute(parseHash()); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 3500); };

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await api<{ errors: string[] }>("/api/sync", { method: "POST" });
      flash(r.errors.length ? `Синхронизация с ошибками: ${r.errors.join("; ")}` : "Синхронизировано");
      await load();
    } finally { setSyncing(false); }
  };

  if (err && !state) return <div className="page"><div className="callout red"><span className="ci">⚠️</span><div>Сервер не отвечает: {err}</div></div></div>;
  if (!state) return <div className="page muted">Загружаю…</div>;
  const card = peek ? state.board.cards.find((c) => c.id === peek) : null;
  const go = (h: string) => (location.hash = h);
  if (!state.meta.setupDone || route.page === "setup")
    return <>
      <Setup flash={flash} onDone={() => { go("today"); load(); }} />
      {toast && <div className="toast">{toast}</div>}
    </>;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="ws"><span className="avatar">🎓</span>Учебный штаб{state.meta.week && state.meta.week <= state.meta.weeks ? <span className="badge" style={{ marginLeft: "auto", fontWeight: 400, fontSize: 12, color: "var(--fg3)" }}>неделя {state.meta.week}</span> : null}</div>
        <button className={`nav ${route.page === "today" ? "active" : ""}`} onClick={() => go("today")}><span className="ic">🏠</span>Сегодня</button>
        <button className={`nav ${route.page === "board" ? "active" : ""}`} onClick={() => go("board")}><span className="ic">📋</span>Доска<span className="badge">{state.board.cards.filter((c) => c.col === "today").length || ""}</span></button>
        <button className={`nav ${route.page === "week" ? "active" : ""}`} onClick={() => go("week")}><span className="ic">🗓️</span>Неделя</button>
        <button className={`nav ${route.page === "plan" ? "active" : ""}`} onClick={() => go("plan")}><span className="ic">🗺️</span>Учебный план</button>
        <button className={`nav ${route.page === "settings" ? "active" : ""}`} onClick={() => go("settings")}><span className="ic">⚙️</span>Настройки</button>
        <div className="side-h">Курсы</div>
        {state.grades.filter((g) => g.activities.length).map((g) => (
          <button key={g.id} className={`nav ${route.page === "course" && route.slug === g.slug ? "active" : ""}`} onClick={() => go(`course-${g.slug}`)}>
            <span className="ic"><span className={`dot c-${g.color}`} style={{ display: "inline-block" }} /></span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.short}</span>
            <span className="badge num">{f2(g.earned)}{g.status !== "ok" ? (g.status === "watch" ? " 🟡" : " 🔴") : ""}</span>
          </button>
        ))}
        <div className="side-foot">
          <div>Late days: <b style={{ color: "var(--fg)" }}>{state.meta.lateDaysBalance ?? "?"}</b></div>
          <div>LMS: {ago(state.meta.lmsSyncedAt)}</div>
          <div>Календарь: {state.meta.calendarConfigured ? ago(state.meta.calSyncedAt) : "не настроен"}</div>
          <button className="btn outline" onClick={sync} disabled={syncing}>{syncing ? <span className="spin">⟳</span> : "⟳"} Синхронизировать</button>
        </div>
      </aside>
      <main className="main">
        {route.page === "today" && <Today s={state} open={setPeek} reload={load} />}
        {route.page === "board" && <Board s={state} open={setPeek} reload={load} flash={flash} />}
        {route.page === "week" && <Week open={setPeek} />}
        {route.page === "plan" && <Plan courses={state.grades} flash={flash} />}
        {route.page === "settings" && <Settings reload={load} flash={flash} />}
        {route.page === "course" && <Course slug={route.slug} s={state} open={setPeek} reload={load} flash={flash} />}
      </main>
      {card && <Peek card={card} grade={state.grades.find((g) => g.id === card.courseId)} close={() => setPeek(null)} reload={load} flash={flash} balance={state.meta.lateDaysBalance} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

// ---------- Today ----------
function Today({ s, open, reload }: { s: State; open: (id: string) => void; reload: () => void }) {
  const t = s.today;
  const crit = t.alerts.filter((a) => a.level !== "info");
  const info = t.alerts.filter((a) => a.level === "info");
  const mark = async (uid: string, attended: boolean) => { await api("/api/attendance", { method: "POST", json: { uid, attended } }); reload(); };
  const cardId = (i: Item) => i.id;
  return (
    <>
      <div className="topbar"><span className="crumb">🏠 Сегодня</span></div>
      <div className="page">
        <div className="page-icon">☀️</div>
        <div className="page-title">{new Date().toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" })}</div>
        <div className="page-sub">{s.meta.week && s.meta.week <= s.meta.weeks ? `Неделя ${s.meta.week} из ${s.meta.weeks} · ` : ""}Late days: {s.meta.lateDaysBalance ?? "?"} · синхронизация LMS {ago(s.meta.lmsSyncedAt)}</div>
        {s.meta.lastSync?.errors?.length ? <div className="callout yellow"><span className="ci">⚠️</span><div>{s.meta.lastSync.errors.join(" · ")}</div></div> : null}
        {crit.map((a, i) => (
          <div key={i} className={`callout ${a.level === "crit" ? "red" : "yellow"}`}><span className="ci">{a.level === "crit" ? "🚨" : "⚠️"}</span><div><b>{a.course}</b> · {a.text}</div></div>
        ))}

        <h2 className="h">Пары</h2>
        {!s.meta.calendarConfigured && <div className="callout blue"><span className="ci">🗓️</span><div>Календарь не подключён: расписание пар и вердикты «идти на пару» появятся после подключения Яндекс Календаря в <a href="#settings">настройках</a>.</div></div>}
        <div className="list">
          {t.classes.length === 0 && s.meta.calendarConfigured && <div className="row muted">Сегодня пар нет</div>}
          {t.classes.map((c) => (
            <div className="row" key={c.uid}>
              <span className="time">{time(c.start)}</span>
              {c.course && <Tag c={c.color}>{c.course}</Tag>}
              <span className="title">{c.title}<small>{c.reason}{c.location ? ` · ${c.location}` : ""}</small></span>
              <Tag c={VERDICT[c.verdict]?.[0]}>{VERDICT[c.verdict]?.[1]}</Tag>
              {new Date(c.start).getTime() < Date.now() && (c.attended == null
                ? <><button className="btn outline" onClick={() => mark(c.uid, true)}>Был</button><button className="btn" onClick={() => mark(c.uid, false)}>Не был</button></>
                : <Tag c={c.attended ? "green" : "red"}>{c.attended ? "Был" : "Пропустил"}</Tag>)}
            </div>
          ))}
        </div>

        <h2 className="h">Главное</h2>
        <div className="list">
          {t.top.map((i, n) => (
            <button className="row" key={i.id} onClick={() => open(cardId(i))} style={{ textAlign: "left" }}>
              <span className="time">{n + 1}.</span>
              <Tag c={i.color}>{i.course}</Tag>
              <span className="title">{i.title}<small>{dueLabel(i.deadline)} · +{f2(i.delta)}{i.lateDayAdvice?.allowed ? ` · ${i.lateDayAdvice.reasoning}` : ""}</small></span>
              {i.blocker && <Tag c="red">блокер</Tag>}
            </button>
          ))}
        </div>

        <h2 className="h">Дедлайны на 72 часа</h2>
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th>Срок</th><th>Курс</th><th>Задача</th><th>Вклад</th><th>LD</th><th>Статус</th></tr></thead>
          <tbody>
            {t.deadlines72h.map((i) => (
              <tr key={i.id} onClick={() => open(i.id)} style={{ cursor: "pointer" }}>
                <td className="num" style={{ whiteSpace: "nowrap" }}>{dueLabel(i.deadline)}</td>
                <td><Tag c={i.color}>{i.course}</Tag></td>
                <td>{i.title} {i.blocker && <Tag c="red">блокер</Tag>}</td>
                <td className="num">+{f2(i.delta)}</td>
                <td>{i.lateDaysAllowed ? <Tag c="green">можно</Tag> : <Tag>нельзя</Tag>}</td>
                <td><Tag c={LMS_STATE[i.state]?.[0]}>{LMS_STATE[i.state]?.[1] ?? i.state}</Tag></td>
              </tr>
            ))}
            {!t.deadlines72h.length && <tr><td colSpan={6} className="muted">Ничего не горит</td></tr>}
          </tbody>
        </table></div>

        <h2 className="h">Курсы</h2>
        <div className="gallery">
          {s.grades.filter((g) => g.activities.length).map((g) => (
            <button className="gcard" key={g.id} onClick={() => (location.hash = `course-${g.slug}`)}>
              <div className={`gcover c-${g.color}`} />
              <div className="gbody">
                <div className="gtitle">{g.title}</div>
                <Progress g={g} />
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <Tag c={STATUS[g.status][0]}>{STATUS[g.status][1]}</Tag>
                  <span className="muted num">{f2(g.earned)} / порог {g.threshold} · max {f2(g.maxReachable)}</span>
                </div>
              </div>
            </button>
          ))}
        </div>

        {info.length > 0 && <>
          <h3 className="h">Расхождения LMS и силлабусов</h3>
          {info.map((a, i) => <div key={i} className="callout"><span className="ci">ℹ️</span><div><b>{a.course}</b> · {a.text}</div></div>)}
        </>}
      </div>
    </>
  );
}

// ---------- Board ----------
function Board({ s, open, reload, flash }: { s: State; open: (id: string) => void; reload: () => void; flash: (m: string) => void }) {
  const [filter, setFilter] = useState<number | null>(() => Number(localStorage.getItem("board.filter")) || null);
  const [kinds, setKinds] = useState<"all" | "tasks" | "classes">("all");
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<Col | null>(null);
  const [adding, setAdding] = useState<Col | null>(null);
  const [cards, setCards] = useState(s.board.cards);
  useEffect(() => setCards(s.board.cards), [s.board.cards]);
  useEffect(() => { localStorage.setItem("board.filter", String(filter ?? "")); }, [filter]);

  const visible = cards.filter((c) => (!filter || c.courseId === filter) && (kinds === "all" || (kinds === "tasks" ? c.kind !== "event" : c.kind === "event" || c.kind === "prep")));
  const drop = async (col: Col) => {
    setOver(null);
    if (!drag) return;
    const c = cards.find((x) => x.id === drag);
    setDrag(null);
    if (!c || c.col === col) return;
    if (c.kind === "lms" && LMS_LOCKED.has(c.state)) {
      flash(`Статус «${LMS_STATE[c.state]?.[1]}» приходит из LMS. Карточка переедет сама, когда он изменится там.`);
      return;
    }
    if (c.kind === "lms" && (col === "review" || col === "done") && OPEN_STATES.has(c.state))
      flash(`Отмечено только на доске: в LMS работа по-прежнему «${LMS_STATE[c.state]?.[1]}». Не забудь отправить её в LMS.`);
    setCards((cs) => cs.map((x) => (x.id === c.id ? { ...x, col } : x)));
    await api(`/api/cards/${encodeURIComponent(c.id)}/move`, { method: "POST", json: { col } }).catch((e) => flash(e.message));
    reload();
  };
  const add = async (col: Col, title: string) => {
    setAdding(null);
    if (!title.trim()) return;
    await api("/api/cards", { method: "POST", json: { title, col, courseId: filter } });
    reload();
  };
  const courses = s.grades.filter((g) => g.activities.length);

  return (
    <>
      <div className="topbar"><span className="crumb">📋 Доска</span></div>
      <div className="page wide">
        <div className="page-title" style={{ fontSize: 32 }}>Доска</div>
        <div className="board-bar">
          <button className={`chip ${!filter ? "on" : ""}`} onClick={() => setFilter(null)}>Все курсы</button>
          {courses.map((g) => (
            <button key={g.id} className={`chip ${filter === g.id ? "on" : ""}`} onClick={() => setFilter(filter === g.id ? null : g.id)}>
              <span className={`dot c-${g.color}`} />{g.short}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          {(["all", "tasks", "classes"] as const).map((k) => (
            <button key={k} className={`chip ${kinds === k ? "on" : ""}`} onClick={() => setKinds(k)}>{k === "all" ? "Всё" : k === "tasks" ? "Задачи" : "Пары и подготовка"}</button>
          ))}
        </div>
        <div className="board">
          {s.board.columns.map((col) => {
            const list = visible.filter((c) => c.col === col.id);
            if (col.id === "overdue" && !list.length) return null;
            return (
              <div key={col.id} className={`col ${col.id === "overdue" ? "col-overdue" : ""} ${over === col.id ? "drop" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setOver(col.id); }} onDragLeave={() => setOver(null)} onDrop={() => drop(col.id)}>
                <div className="col-h"><span>{COL_ICON[col.id]}</span><b>{col.title}</b><span className="count">{list.length}</span></div>
                {col.id === "overdue" && <div className="col-hint">Дедлайн прошёл, но late days ещё спасают работу. Чем раньше, тем меньше LD.</div>}
                <div className="cards">
                  {list.map((c) => <KCard key={c.id} c={c} onOpen={() => open(c.id)} onDrag={setDrag} dragging={drag === c.id} />)}
                  {adding === col.id
                    ? <input autoFocus className="add-input" placeholder="Название…" onBlur={(e) => add(col.id, e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") add(col.id, e.currentTarget.value); if (e.key === "Escape") setAdding(null); }} />
                    : <button className="add" onClick={() => setAdding(col.id)}>+ Новая</button>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function KCard({ c, onOpen, onDrag, dragging }: { c: Card; onOpen: () => void; onDrag: (id: string | null) => void; dragging: boolean }) {
  const late = c.due && new Date(c.due).getTime() < Date.now() && c.col !== "done" && c.col !== "review";
  const icon = c.kind === "event" ? "🎓 " : c.kind === "prep" ? "📖 " : c.kind === "manual" ? "✏️ " : "";
  return (
    <div className={`kcard ${dragging ? "dragging" : ""}`} draggable onDragStart={() => onDrag(c.id)} onDragEnd={() => onDrag(null)} onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}>
      <div className="kt">{icon}{c.title}</div>
      {c.subtitle && <div className="ks">{c.subtitle}</div>}
      <div className="kp">
        {c.course && <Tag c={c.color}>{c.course}</Tag>}
        {c.kind === "event" && c.verdict && <Tag c={VERDICT[c.verdict]?.[0]}>{VERDICT[c.verdict]?.[1]}</Tag>}
        {c.blocker && <Tag c="red" title={c.blocker}>блокер</Tag>}
        {c.delta > 0 && <Tag c="blue">+{f2(c.delta)}</Tag>}
        {c.kind === "lms" && c.lateDays && c.col !== "done" && c.col !== "review" && <Tag c="green">LD</Tag>}
        {c.kind === "lms" && c.score != null && c.state !== "overdue" && <Tag c={c.score >= 3.5 ? "green" : "red"}>{c.score}</Tag>}
        {c.kind === "lms" && c.state === "notCreated" && <Tag>нет в LMS</Tag>}
        {c.kind === "lms" && c.state === "overdue" && c.due && <Tag c="red">{Math.max(1, Math.ceil((Date.now() - Date.parse(c.due)) / 864e5))} LD сегодня</Tag>}
        {c.kind === "lms" && (c.col === "review" || c.col === "done") && OPEN_STATES.has(c.state) && <Tag c="orange" title="Колонка выставлена вручную, в LMS статус другой">≠ LMS: {LMS_STATE[c.state]?.[1]}</Tag>}
      </div>
      {c.due && c.kind !== "event" && <div className={`kd ${late ? "late" : ""}`}>⏰ {dueLabel(c.due)}</div>}
    </div>
  );
}

// ---------- Peek ----------
function Peek({ card, grade, close, reload, flash, balance }: { card: Card; grade?: Grade; close: () => void; reload: () => void; flash: (m: string) => void; balance: number | null }) {
  const [notes, setNotes] = useState(card.notes);
  const [ws, setWs] = useState<{ dir: string; cloneNotes: string[]; attachments?: number } | null>(null);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const loadRun = useCallback(() => card.kind === "lms" ? api<AgentRun | null>(`/api/agent/run/${encodeURIComponent(card.id)}`).then(setRun).catch(() => {}) : Promise.resolve(), [card.id, card.kind]);
  useEffect(() => { setRun(null); loadRun(); }, [loadRun]);
  useEffect(() => {
    if (run?.status !== "running") return;
    const t = setInterval(loadRun, 5000);
    return () => clearInterval(t);
  }, [run?.status, loadRun]);
  const draft = async () => {
    setBusy(true);
    try { setRun(await api<AgentRun>("/api/agent/draft", { method: "POST", json: { id: card.id } })); flash("Агент запущен в фоне, по готовности придёт уведомление"); reload(); }
    catch (e) { flash((e as Error).message); } finally { setBusy(false); }
  };
  const chat = async (target: "app" | "terminal", resume = false) => {
    setOpening(target);
    try { await api("/api/chat", { method: "POST", json: { id: card.id, target, resume } }); flash(target === "app" ? "Открываю в Claude…" : "Открываю Терминал…"); }
    catch (e) { flash((e as Error).message); } finally { setOpening(null); }
  };
  const [busy, setBusy] = useState(false);
  useEffect(() => { setNotes(card.notes); setWs(null); }, [card.id]);
  useEffect(() => { const f = (e: KeyboardEvent) => e.key === "Escape" && close(); addEventListener("keydown", f); return () => removeEventListener("keydown", f); }, [close]);
  const save = () => notes !== card.notes && api(`/api/cards/${encodeURIComponent(card.id)}`, { method: "PATCH", json: { notes } }).then(reload);
  const hide = async () => { await api(`/api/cards/${encodeURIComponent(card.id)}`, { method: "PATCH", json: { hidden: true } }); close(); reload(); };
  const move = async (col: Col) => {
    if (card.kind === "lms" && (col === "review" || col === "done") && OPEN_STATES.has(card.state))
      flash(`Отмечено только на доске: в LMS работа по-прежнему «${LMS_STATE[card.state]?.[1]}».`);
    await api(`/api/cards/${encodeURIComponent(card.id)}/move`, { method: "POST", json: { col } }).catch((e) => flash(e.message));
    reload();
  };
  const workspace = async () => {
    setBusy(true);
    try { setWs(await api("/api/workspace", { method: "POST", json: { id: card.id } })); flash("Рабочая папка готова"); reload(); }
    catch (e) { flash((e as Error).message); } finally { setBusy(false); }
  };
  const cmd = ws ? `cd "${ws.dir}" && claude` : "";
  const copy = (t: string) => navigator.clipboard?.writeText(t).then(() => flash("Скопировано"));

  return (
    <>
      <div className="peek-bg" onClick={() => { save(); close(); }} />
      <aside className="peek">
        <div className="topbar" style={{ margin: "0 -30px", padding: "6px 0" }}>
          <button className="btn" onClick={() => { save(); close(); }}>✕</button>
          <span className="spacer" />
          {card.link && <a className="btn" href={card.link} target="_blank" rel="noreferrer">Открыть в LMS ↗</a>}
          <button className="btn" onClick={hide}>Скрыть</button>
        </div>
        <div className="page-icon" style={{ fontSize: 44, marginTop: 20 }}>{card.kind === "event" ? "🎓" : card.kind === "prep" ? "📖" : card.kind === "manual" ? "✏️" : "📝"}</div>
        <div className="page-title">{card.title}</div>
        <div className="props">
          {card.course && <><div className="k">◉ Курс</div><div className="v"><Tag c={card.color}>{grade?.title ?? card.course}</Tag></div></>}
          <div className="k">▤ Колонка</div>
          <div className="v">
            <select value={card.col} disabled={card.kind === "lms" && LMS_LOCKED.has(card.state)} title={card.kind === "lms" && LMS_LOCKED.has(card.state) ? "Колонку выставляет LMS по статусу задачи" : undefined} onChange={(e) => move(e.target.value as Col)} style={{ border: 0, background: "transparent" }}>
              {(["overdue", "inbox", "week", "today", "doing", "review", "done"] as Col[]).map((c) => <option key={c} value={c}>{COL_ICON[c]} {c === "overdue" ? "Просрочено" : c === "inbox" ? "Входящие" : c === "week" ? "Эта неделя" : c === "today" ? "Сегодня" : c === "doing" ? "В работе" : c === "review" ? "На проверке" : "Готово"}</option>)}
            </select>
          </div>
          {card.due && <><div className="k">⏰ {card.kind === "event" ? "Начало" : "Дедлайн"}</div><div className="v">{dueLabel(card.due)}</div></>}
          <div className="k">◎ Статус</div><div className="v"><Tag c={LMS_STATE[card.state]?.[0]}>{LMS_STATE[card.state]?.[1] ?? card.state}</Tag>{card.score != null && <Tag c={card.score >= 3.5 ? "green" : "red"}>оценка {card.score}</Tag>}</div>
          {card.delta > 0 && <><div className="k">Σ Вклад в итог</div><div className="v num">+{f2(card.delta)} из 10</div></>}
          {card.blocker && <><div className="k">⛔ Блокер</div><div className="v"><Tag c="red">{card.blocker}</Tag></div></>}
          {card.kind === "lms" && <><div className="k">⏳ Late days</div><div className="v">{card.lateDays ? <><Tag c="green">можно</Tag><span className="muted">на балансе {balance ?? "?"} · 1 LD = 1 день, максимум 7, не позже 19.12</span></> : <Tag>нельзя по силлабусу</Tag>}</div></>}
          {card.verdictLabel && <><div className="k">✓ Идти?</div><div className="v">{card.verdictLabel}</div></>}
          {card.effortH != null && <><div className="k">⌛ Оценка времени</div><div className="v">{card.effortH} ч</div></>}
        </div>

        {card.state === "overdue" && card.due && (() => {
          const n = Math.max(1, Math.ceil((Date.now() - Date.parse(card.due)) / 864e5));
          const close = new Date(Date.parse(card.due) + 7 * 864e5).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
          return <div className="callout red"><span className="ci">⏳</span><div><b>Дедлайн прошёл, но работу можно спасти.</b> Если сдать сегодня до {time(card.due)}, понадобится {n} LD, завтра {n + 1}. Окно закроется {close}. В LMS открой «Архивные задания», нажми значок календаря у задачи и перенеси дедлайн, потом сдавай. Сейчас LMS засчитывает за неё 0.</div></div>;
        })()}

        {card.kind === "lms" && (
          <>
            <h3 className="h">Работа с агентом</h3>
            <div className="actions">
              <button className="btn primary" onClick={draft} disabled={busy || run?.status === "running"}>
                {run?.status === "running" ? <><span className="spin">⟳</span> Агент работает · {minsSince(run.started_at)}</> : "✨ Черновик агентом"}
              </button>
              <button className="btn outline" onClick={() => chat("app")} disabled={!!opening}>💬 Открыть в Claude</button>
              <button className="btn outline" onClick={() => chat("terminal")} disabled={!!opening}>⌨️ В терминале</button>
              <button className="btn outline" onClick={() => api("/api/open-task", { method: "POST", json: { id: card.id } }).catch((e) => flash(e.message))}>📁 В Finder</button>
            </div>
            {run && run.status !== "running" && (
              <div className={`callout ${run.status === "failed" ? "red" : "blue"}`} style={{ marginBottom: 10 }}>
                <span className="ci">{run.status === "done" ? "✨" : "⚠️"}</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <b>{run.status === "done" ? "Черновик готов" : "Агент не справился"}</b> <span className="muted">· {new Date(run.finished_at ?? run.started_at).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}{run.cost_usd != null ? ` · $${run.cost_usd.toFixed(2)}` : ""}</span>
                  <div className="agent-summary">{run.summary}</div>
                  <div className="actions" style={{ margin: "8px 0 0" }}>
                    {run.session_id && <button className="btn outline" onClick={() => chat("terminal", true)}>⌨️ Продолжить эту сессию в терминале</button>}
                    <button className="btn outline" onClick={() => api("/api/open", { method: "POST", json: { path: run.dir } })}>📁 Открыть папку</button>
                  </div>
                </div>
              </div>
            )}
            <details className="more">
              <summary>Папка и команды</summary>
              <div className="actions">
                <button className="btn outline" onClick={workspace} disabled={busy}>{busy ? "Собираю…" : "📁 Создать или обновить папку"}</button>
                <button className="btn outline" onClick={() => copy(`/do ${card.id}`)}>Скопировать /do {card.id}</button>
              </div>
              {ws && <>
                <pre className="code">{cmd}</pre>
                <div className="actions">
                  <button className="btn outline" onClick={() => copy(cmd)}>Скопировать команду</button>
                  <button className="btn outline" onClick={() => api("/api/open", { method: "POST", json: { path: ws.dir } })}>Открыть в Finder</button>
                </div>
                {ws.cloneNotes.length > 0 && <div className="muted">{ws.cloneNotes.join(" · ")}</div>}
              </>}
            </details>
          </>
        )}

        <h3 className="h">Заметки</h3>
        <textarea className="notes" value={notes} placeholder="Пиши здесь: что задали, идеи, ссылки…" onChange={(e) => setNotes(e.target.value)} onBlur={save} />
      </aside>
    </>
  );
}

// ---------- Week ----------
function Week({ open }: { open: (id: string) => void }) {
  const [w, setW] = useState<{ week: number | null; weeks: number; days: { date: string; classes: ClassEv[]; due: Item[]; loadH: number; overloaded: boolean; suggestions: string[] }[]; recoverable: Item[] } | null>(null);
  useEffect(() => { api<any>("/api/week").then(setW); }, []);
  if (!w) return <div className="page muted">Загружаю…</div>;
  return (
    <>
      <div className="topbar"><span className="crumb">🗓️ Неделя</span></div>
      <div className="page wide">
        <div className="page-title" style={{ fontSize: 32 }}>{w.week ? (w.week > w.weeks ? "Неделя после занятий" : `Неделя ${w.week}`) : "Неделя"}{w.week && w.week <= w.weeks ? <span className="muted" style={{ fontWeight: 400, fontSize: 20 }}> из {w.weeks}</span> : null}</div>
        <div className="page-sub">{rangeLabel(w.days[0]?.date, w.days[6]?.date)}</div>
        <div className="page-sub">Нагрузка считается по оценке времени задач плюс 1.5 ч на каждую пару, куда нужно идти. Дни больше 8 ч подсвечены.</div>
        <div className="week">
          {w.days.map((d) => (
            <div key={d.date} className={`day ${d.overloaded ? "over" : ""}`}>
              <div className="dh"><span>{new Date(d.date).toLocaleDateString("ru-RU", { weekday: "short", day: "numeric" })}</span><span className="muted num">{d.loadH.toFixed(1)} ч</span></div>
              {d.classes.map((c) => (
                <div className="mini" key={c.uid}>
                  <span><b className="num">{time(c.start)}</b> {c.course && <Tag c={c.color}>{c.course}</Tag>}</span>
                  <span>{c.title}</span>
                  <Tag c={VERDICT[c.verdict]?.[0]}>{VERDICT[c.verdict]?.[1]}</Tag>
                </div>
              ))}
              {d.due.map((i) => (
                <button className="mini" key={i.id} onClick={() => open(i.id)} style={{ textAlign: "left" }}>
                  <span>⏰ <Tag c={i.color}>{i.course}</Tag> {i.blocker && <Tag c="red">блокер</Tag>}</span>
                  <span>{i.title}</span>
                  <span className="muted">+{f2(i.delta)} · {i.effortH} ч{i.lateDaysAllowed ? " · LD" : ""}</span>
                </button>
              ))}
              {d.suggestions.map((s, k) => <div key={k} className="callout yellow" style={{ padding: 8, fontSize: 12 }}>💡 {s}</div>)}
            </div>
          ))}
        </div>
        <h2 className="h">Можно вернуть на дорешках</h2>
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th>Курс</th><th>Работа</th><th>Вернёт</th><th></th></tr></thead>
          <tbody>{w.recoverable.map((i) => <tr key={i.id}><td><Tag c={i.color}>{i.course}</Tag></td><td>{i.title}</td><td className="num">+{f2(i.delta)}</td><td>{i.blocker && <Tag c="red">блокер</Tag>}</td></tr>)}</tbody>
        </table></div>
      </div>
    </>
  );
}

// ---------- Course ----------
type Override = CourseSettings["override"];

/** Notion-style inline text: looks like plain text, edits in place, saves on blur / Enter. */
function InlineText({ value, placeholder, onSave, className, ariaLabel }: { value: string; placeholder: string; onSave: (v: string) => void; className?: string; ariaLabel: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input className={`inline-input ${className ?? ""}`} aria-label={ariaLabel} value={v} placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v.trim() !== value && onSave(v.trim())}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setV(value); e.currentTarget.blur(); } }} />
  );
}

function Course({ slug, s, open, reload, flash }: { slug: string; s: State; open: (id: string) => void; reload: () => void; flash: (m: string) => void }) {
  const [data, setData] = useState<any>(null);
  const [assume, setAssume] = useState<Record<string, number>>({});
  const [wi, setWi] = useState<{ final: number; passes: boolean } | null>(null);
  const [editLinks, setEditLinks] = useState(false);
  const [draft, setDraft] = useState<Override>({});
  useEffect(() => { setData(null); setAssume({}); setEditLinks(false); }, [slug]);
  useEffect(() => { api<any>(`/api/course/${slug}`).then(setData); }, [slug, s]);
  const settings: CourseSettings | undefined = data?.settings;
  const save = async (patch: Override) => {
    const next = { ...settings!.override, ...patch };
    await api(`/api/course/${slug}/settings`, { method: "PUT", json: next });
    flash("Сохранено");
    reload();
  };
  const startLinks = () => { setDraft({ ...settings!.override, links: [...(settings!.override.links ?? [])] }); setEditLinks(true); };
  const saveLinks = async () => { await save({ syllabusUrl: draft.syllabusUrl ?? "", timeUrl: draft.timeUrl ?? "", links: (draft.links ?? []).filter((l) => l.url.trim()) }); setEditLinks(false); };
  const [busyMat, setBusyMat] = useState(false);
  const syncMaterials = async () => {
    setBusyMat(true);
    try { const r = await api<{ weeks: number; attachments: number; errors: string[] }>(`/api/course/${slug}/materials`, { method: "POST" }); flash(`Материалы обновлены: недель ${r.weeks}, файлов ${r.attachments}${r.errors.length ? `, ошибок ${r.errors.length}` : ""}`); reload(); }
    catch (e) { flash((e as Error).message); } finally { setBusyMat(false); }
  };
  const courseChat = (target: "app" | "terminal") => api("/api/chat", { method: "POST", json: { course: slug, target } }).then(() => flash(target === "app" ? "Открываю в Claude…" : "Открываю Терминал…")).catch((e) => flash(e.message));
  const resetAll = async () => { await api(`/api/course/${slug}/settings`, { method: "PUT", json: {} }); flash("Настройки курса сброшены"); setEditLinks(false); reload(); };
  const g: Grade | undefined = data?.grade;
  useEffect(() => {
    if (!g) return;
    const t = setTimeout(() => api<any>("/api/whatif", { method: "POST", json: { course: slug, assume, restAvg: 7 } }).then(setWi), 150);
    return () => clearTimeout(t);
  }, [assume, g, slug]);
  if (!data || !g) return <div className="page muted">Загружаю…</div>;
  const cards: Card[] = data.cards.filter((c: Card) => c.col !== "done");

  return (
    <>
      <div className="topbar"><span>Курсы</span><span className="muted">/</span><span className="crumb">{g.short}</span></div>
      <div className="page">
        <div className={`course-cover c-${g.color}`} />
        <InlineText className="page-title" ariaLabel="Название курса" value={g.title} placeholder={settings?.defaults.title ?? g.title} onSave={(v) => save({ title: v })} />
        <div className="props">
          <div className="k">🏷 Тег</div><div className="v"><Tag c={g.color}><InlineText className="tag-input" ariaLabel="Короткое имя курса" value={g.short} placeholder={settings?.defaults.short ?? g.short} onSave={(v) => save({ short: v })} /></Tag></div>
          <div className="k">🎨 Цвет</div><div className="v"><div className="swatches">{COLORS.map((col) => <button key={col} title={col} aria-label={`Цвет ${col}`} className={`swatch sm c-${col} ${g.color === col ? "on" : ""}`} onClick={() => col !== g.color && save({ color: col === settings?.defaults.color ? "" : col })} />)}</div></div>
          <div className="k">◎ Статус</div><div className="v"><Tag c={STATUS[g.status][0]}>{STATUS[g.status][1]}</Tag></div>
          <div className="k">Σ Сейчас</div><div className="v num"><b>{f2(g.earned)}</b>&nbsp;из 10 · потеряно {f2(g.lost)} · максимум {f2(g.maxReachable)}{g.bonusLeft > 0 ? ` (+${f2(g.bonusLeft)} бонус)` : ""}</div>
          <div className="k">⚑ Порог</div><div className="v num">{g.threshold} · нужно {Number.isFinite(g.neededShare) ? Math.round(g.neededShare * 100) : "∞"}% от оставшихся баллов</div>
          <div className="k">≈ Округление</div><div className="v">{g.rounding ?? <span className="muted">не указано в силлабусе</span>}</div>
          <div className="k">🔗 Ссылки</div><div className="v">
            <a className="btn outline" href={`https://my.centraluniversity.ru/learn/courses/view/actual/${g.id}`} target="_blank" rel="noreferrer">LMS ↗</a>
            {g.syllabusUrl && <a className="btn outline" href={g.syllabusUrl.replace("note.cu.ru", "cuhandlog.ru")} target="_blank" rel="noreferrer">Силлабус ↗</a>}
            {g.timeUrl && <a className="btn outline" href={g.timeUrl} target="_blank" rel="noreferrer">TiMe ↗</a>}
            {g.links.map((l) => <a key={l.url} className="btn outline" href={l.url} target="_blank" rel="noreferrer">{l.label} ↗</a>)}
            {!editLinks && <button className="btn" onClick={startLinks}>✎ Изменить</button>}
          </div>
          <div className="k">🗓 В календаре</div><div className="v">
            <InlineText ariaLabel="Шаблоны названия пары в календаре" value={(settings?.override.calendarMatch ?? []).join(", ")}
              placeholder={`ищу по: ${(settings?.defaults.calendarMatch ?? []).join(", ") || "нет"}; добавь свои через запятую`}
              onSave={(v) => save({ calendarMatch: v.split(",").map((x) => x.trim()).filter(Boolean) })} />
          </div>
        </div>
        {editLinks && settings && (
          <div className="course-set" style={{ marginBottom: 16 }}>
            <div className="fgrid">
              <div className="field"><label htmlFor="c-sy">Силлабус</label><input id="c-sy" className="input" placeholder={settings.defaults.syllabusUrl ?? "ссылка"} value={draft.syllabusUrl ?? ""} onChange={(e) => setDraft({ ...draft, syllabusUrl: e.target.value })} /></div>
              <div className="field"><label htmlFor="c-tm">Канал в TiMe</label><input id="c-tm" className="input" placeholder={settings.defaults.timeUrl ?? "ссылка"} value={draft.timeUrl ?? ""} onChange={(e) => setDraft({ ...draft, timeUrl: e.target.value })} /></div>
            </div>
            <div className="field">
              <label>Материалы и ссылки (репозиторий, диск, записи…)</label>
              {(draft.links ?? []).map((l, i) => (
                <div className="linkrow" key={i}>
                  <input className="input" aria-label="Название ссылки" placeholder="Название" value={l.label} onChange={(e) => setDraft({ ...draft, links: draft.links!.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                  <input className="input" aria-label="Адрес ссылки" placeholder="https://…" value={l.url} onChange={(e) => setDraft({ ...draft, links: draft.links!.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} />
                  <button className="btn" aria-label="Удалить ссылку" onClick={() => setDraft({ ...draft, links: draft.links!.filter((_, j) => j !== i) })}>✕</button>
                </div>
              ))}
              <div><button className="add" style={{ width: "auto" }} onClick={() => setDraft({ ...draft, links: [...(draft.links ?? []), { label: "", url: "" }] })}>+ Добавить ссылку</button></div>
            </div>
            <div className="actions" style={{ margin: 0 }}>
              <button className="btn primary" onClick={saveLinks}>Сохранить ссылки</button>
              <button className="btn" onClick={() => setEditLinks(false)}>Отмена</button>
              <span style={{ flex: 1 }} />
              <button className="btn" onClick={resetAll} title="Название, тег, цвет, ссылки и шаблоны календаря вернутся к значениям из силлабуса">Сбросить всё по курсу</button>
            </div>
          </div>
        )}
        <Progress g={g} />

        <div className="course-tools">
          <span className="muted">📚 Материалы курса {data.materials?.syncedAt ? `обновлены ${ago(data.materials.syncedAt)}` : "ещё не скачаны"}</span>
          <span style={{ flex: 1 }} />
          <button className="btn outline" disabled={busyMat} onClick={syncMaterials}>{busyMat ? <><span className="spin">⟳</span> Скачиваю…</> : "⟳ Обновить материалы"}</button>
          <button className="btn outline" onClick={() => api("/api/open", { method: "POST", json: { path: data.materials.dir } }).catch((e) => flash(e.message))}>📁 Папка курса</button>
          <button className="btn outline" onClick={() => courseChat("app")}>💬 Чат по курсу</button>
          <button className="btn outline" onClick={() => courseChat("terminal")}>⌨️ В терминале</button>
        </div>

        {g.warnings.map((w, i) => <div key={i} className="callout" style={{ marginTop: 10 }}><span className="ci">ℹ️</span><div>{w}</div></div>)}

        <h2 className="h">Блокеры</h2>
        <div className="list">
          {g.blockers.map((b) => (
            <div className="row" key={b.label}>
              <span>{b.status === "ok" ? "✅" : b.status === "failed" ? "❌" : b.status === "risk" ? "⚠️" : "⏳"}</span>
              <span className="title">{b.label}<small>{b.detail}</small></span>
            </div>
          ))}
          {!g.blockers.length && <div className="row muted">Нет</div>}
        </div>

        <h2 className="h">Активности</h2>
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th>Активность</th><th>Вес</th><th title="Работы с итоговой оценкой, включая нули за несданное">Оценено</th><th>Набрано</th><th>Потеряно</th><th>1 работа</th><th className="whatif-col">Что если остальное на…</th></tr></thead>
          <tbody>
            {g.activities.map((a) => (
              <tr key={a.key}>
                <td>{a.name}{a.lateDays && <> <Tag c="green">LD</Tag></>}</td>
                <td className="num">{a.weight}{Math.abs(a.weight - a.syllabusWeight) > 1e-6 && <span className="muted"> (с. {a.syllabusWeight})</span>}</td>
                <td className="num">{a.graded}/{a.planned}</td>
                <td className="num">{f2(a.earned)}</td>
                <td className="num">{a.lost > 0.005 ? f2(a.lost) : ""}</td>
                <td className="num">{f2(a.itemValue)}</td>
                <td className="whatif-col">{a.planned > a.graded
                  ? <span style={{ display: "flex", alignItems: "center", gap: 8 }}><input type="range" min={0} max={10} step={0.5} value={assume[a.key] ?? 7} onChange={(e) => setAssume({ ...assume, [a.key]: Number(e.target.value) })} /><span className="num whatif-val">{(assume[a.key] ?? 7).toFixed(1)}</span></span>
                  : <span className="muted">всё сдано</span>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        {wi && <div className={`callout ${wi.passes ? "" : "red"}`} style={{ marginTop: 10 }}><span className="ci">🔮</span><div>При таких оценках итог <b className="num">{f2(wi.final)}</b>{g.rounding ? "" : " (без округления)"}: {wi.passes ? "проходишь по формуле" : `ниже порога ${g.threshold}`}. Блокеры проверяются отдельно.</div></div>}

        {g.waiting.length > 0 && <><h3 className="h">Ждут проверки</h3><div className="list">{g.waiting.map((w, i) => <div className="row" key={i}><span>👀</span><span className="title">{w.name}</span><Tag c="purple">{w.state}</Tag></div>)}</div></>}

        <h2 className="h">Открытые задачи</h2>
        <div className="list">
          {cards.map((c) => (
            <button className="row" key={c.id} onClick={() => open(c.id)} style={{ textAlign: "left" }}>
              <span>{c.kind === "event" ? "🎓" : c.kind === "prep" ? "📖" : "📝"}</span>
              <span className="title">{c.title}<small>{dueLabel(c.due)}{c.delta > 0 ? ` · +${f2(c.delta)}` : ""}</small></span>
              {c.blocker && <Tag c="red">блокер</Tag>}
              <Tag>{COL_ICON[c.col]}</Tag>
            </button>
          ))}
        </div>

        <h2 className="h">Программа</h2>
        <div className="list">
          {data.themes.map((t: any) => {
            const openPath = (path: string) => api("/api/open", { method: "POST", json: { path } }).catch((e) => flash(e.message));
            return (
              <div className="row" key={t.id}>
                <span className="title">{t.name}<small>{t.publish_date ? new Date(t.publish_date).toLocaleDateString("ru-RU") : ""}{t.attCount ? ` · файлов: ${t.attCount}` : ""}</small></span>
                {t.hasFile && <button className="btn" title="Открыть конспект недели (markdown)" onClick={() => openPath(t.file)}>📄 Неделя</button>}
                {t.attCount > 0 && <button className="btn" title="Папка с лекциями, презентациями и условиями" onClick={() => openPath(t.attDir)}>📁 Файлы</button>}
              </div>
            );
          })}
          {!data.themes.some((t: any) => t.hasFile) && <div className="row muted">Материалы ещё не скачаны: нажми «⟳ Обновить материалы» выше.</div>}
        </div>
      </div>
    </>
  );
}

// ---------- Settings ----------
interface CourseSettings {
  id: number; lmsName: string | null;
  defaults: { title: string; short: string; color: string; syllabusUrl: string | null; timeUrl: string | null; calendarMatch: string[] };
  override: { title?: string; short?: string; color?: string; syllabusUrl?: string; timeUrl?: string; links?: { label: string; url: string }[]; calendarMatch?: string[] };
}
interface SettingsData {
  general: { semesterStart: string; workspaceRoot: string; syncIntervalMin: number; reminders: { beforeClassMin: number; digestAt: string; weeklyReviewAt: string }; webPort: number };
  caldav: { url: string; username: string; keychainService: string; calendars?: string[]; hasPassword: boolean } | null;
}
const COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

/** Yandex CalDAV connection: login, app password in Keychain, connection test, calendar choice. Shared by settings and setup. */
function CalendarForm({ saved, onSaved, flash }: { saved: SettingsData["caldav"]; onSaved: (x: SettingsData, action: "password" | "save" | "disconnect") => Promise<void> | void; flash: (m: string) => void }) {
  const [cal, setCal] = useState({ url: saved?.url ?? "https://caldav.yandex.ru", username: saved?.username ?? "", calendars: saved?.calendars ?? [] });
  const [password, setPassword] = useState("");
  const [found, setFound] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { setCal({ url: saved?.url ?? "https://caldav.yandex.ru", username: saved?.username ?? "", calendars: saved?.calendars ?? [] }); }, [saved]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e) { flash((e as Error).message); } finally { setBusy(null); }
  };
  const savePassword = () => run("pw", async () => {
    await api("/api/settings/caldav-password", { method: "POST", json: { username: cal.username, password } });
    setPassword("");
    flash("Пароль сохранён в Keychain");
    await onSaved(await api<SettingsData>("/api/settings"), "password");
  });
  const test = () => run("test", async () => {
    const r = await api<{ calendars: string[] }>("/api/settings/caldav-test", { method: "POST", json: cal });
    setFound(r.calendars);
    flash(`Подключено: календарей ${r.calendars.length}`);
  });
  const saveCal = () => run("cal", async () => {
    await onSaved(await api<SettingsData>("/api/settings", { method: "PUT", json: { caldav: cal } }), "save");
  });
  const disconnect = () => run("cal", async () => {
    setFound(null);
    await onSaved(await api<SettingsData>("/api/settings", { method: "PUT", json: { caldav: null } }), "disconnect");
  });

  return (
    <>
      <div className="fgrid">
        <div className="field"><label htmlFor="cal-url">Сервер</label><input id="cal-url" className="input" value={cal.url} onChange={(e) => setCal({ ...cal, url: e.target.value })} /></div>
        <div className="field"><label htmlFor="cal-user">Логин</label><input id="cal-user" className="input" placeholder="login@yandex.ru" value={cal.username} onChange={(e) => setCal({ ...cal, username: e.target.value })} /></div>
      </div>
      <div className="field">
        <label htmlFor="cal-pw">Пароль приложения {saved?.hasPassword && cal.username === saved.username ? <Tag c="green">сохранён в Keychain</Tag> : <Tag>не сохранён</Tag>}</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input id="cal-pw" type="password" autoComplete="off" className="input" placeholder="16 символов" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button className="btn outline" disabled={!password || !cal.username || busy === "pw"} onClick={savePassword}>Сохранить в Keychain</button>
        </div>
      </div>
      <div className="actions" style={{ margin: 0 }}>
        <button className="btn outline" disabled={!cal.username || busy === "test"} onClick={test}>{busy === "test" ? "Подключаюсь…" : "Проверить подключение"}</button>
        <button className="btn primary" disabled={!cal.username || busy === "cal"} onClick={saveCal}>Сохранить календарь</button>
        {saved && <button className="btn" onClick={disconnect}>Отключить</button>}
      </div>
      {(found ?? cal.calendars).length > 0 && (
        <div className="field">
          <label>Какие календари читать (ничего не выбрано = все)</label>
          <div className="checks">
            {[...new Set([...(found ?? []), ...cal.calendars])].map((n) => (
              <label key={n} className="check"><input type="checkbox" checked={cal.calendars.includes(n)}
                onChange={(e) => setCal({ ...cal, calendars: e.target.checked ? [...cal.calendars, n] : cal.calendars.filter((x) => x !== n) })} />{n}</label>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** Reminders, semester start and the study folder. Shared by settings and setup. */
function GeneralFields({ general, set }: { general: SettingsData["general"]; set: (g: SettingsData["general"]) => void }) {
  const rem = (patch: Partial<SettingsData["general"]["reminders"]>) => set({ ...general, reminders: { ...general.reminders, ...patch } });
  return (
    <>
      <div className="fgrid">
        <div className="field"><label htmlFor="g-digest">Утренний дайджест</label><input id="g-digest" type="time" className="input" value={general.reminders.digestAt} onChange={(e) => rem({ digestAt: e.target.value })} /></div>
        <div className="field"><label htmlFor="g-before">Напомнить о паре за, мин</label><input id="g-before" type="number" min={5} max={180} className="input" value={general.reminders.beforeClassMin} onChange={(e) => rem({ beforeClassMin: Number(e.target.value) })} /></div>
        <div className="field"><label htmlFor="g-weekly">Ревью недели</label><input id="g-weekly" className="input" placeholder="Sun 20:00" value={general.reminders.weeklyReviewAt} onChange={(e) => rem({ weeklyReviewAt: e.target.value })} /></div>
        <div className="field"><label htmlFor="g-sync">Синхронизация, раз в N мин</label><input id="g-sync" type="number" min={5} className="input" value={general.syncIntervalMin} onChange={(e) => set({ ...general, syncIntervalMin: Number(e.target.value) })} /></div>
      </div>
      <div className="field"><label htmlFor="g-sem">Начало семестра (понедельник 1-й учебной недели): от него считается номер недели</label><input id="g-sem" type="date" className="input" style={{ maxWidth: 220 }} value={general.semesterStart} onChange={(e) => set({ ...general, semesterStart: e.target.value })} /></div>
      <div className="field"><label htmlFor="g-ws">Папка для рабочих папок задач</label><input id="g-ws" className="input" value={general.workspaceRoot} onChange={(e) => set({ ...general, workspaceRoot: e.target.value })} /></div>
    </>
  );
}

function Settings({ reload, flash }: { reload: () => void; flash: (m: string) => void }) {
  const [d, setD] = useState<SettingsData | null>(null);
  const [busy, setBusy] = useState(false);
  const [general, setGeneral] = useState<SettingsData["general"] | null>(null);
  const [dirty, setDirty] = useState(false);

  const apply = (x: SettingsData) => {
    setD(x);
    setGeneral(x.general);
    setDirty(false);
  };
  useEffect(() => { api<SettingsData>("/api/settings").then(apply); }, []);
  if (!d || !general) return <div className="page muted">Загружаю…</div>;

  const calSaved = async (x: SettingsData, action: string) => {
    setD(x);
    if (action === "password") return;
    if (action === "save") {
      flash("Календарь сохранён. Синхронизирую…");
      await api("/api/sync", { method: "POST" });
    }
    reload();
  };
  const saveAll = async () => {
    setBusy(true);
    try {
      apply(await api<SettingsData>("/api/settings", { method: "PUT", json: { general } }));
      flash("Настройки сохранены");
      reload();
    } catch (e) { flash((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="topbar"><span className="crumb">⚙️ Настройки</span></div>
      <div className="page">
        <div className="page-icon">⚙️</div>
        <div className="page-title">Настройки</div>
        <div className="page-sub">Всё хранится локально в <span className="mono">~/.cu-hub/config.yaml</span> поверх правил из силлабусов. Пароль календаря лежит только в Keychain.</div>

        <div className="section">
          <h2 className="h" style={{ margin: 0 }}>🗓️ Календарь</h2>
          <div className="muted">Яндекс Календарь по CalDAV. Нужен пароль приложения: Яндекс ID → Безопасность → Пароли приложений → «Календарь CalDAV».</div>
          <CalendarForm saved={d.caldav} onSaved={calSaved} flash={flash} />
        </div>

        <div className="callout" style={{ marginTop: 12 }}><span className="ci">📚</span><div>Название, цвет, ссылки и материалы курса меняются на странице самого курса. Добавить или убрать курсы, перевойти в LMS: <a href="#setup">мастер настройки</a>.</div></div>

        <div className="section">
          <h2 className="h" style={{ margin: 0 }}>🔔 Напоминания и синхронизация</h2>
          <GeneralFields general={general} set={(g) => { setGeneral(g); setDirty(true); }} />
          <div className="muted">Частота синхронизации применяется после перезапуска демона: <span className="mono">cu install</span>.</div>
        </div>

        <div className="savebar">
          <button className="btn primary" disabled={!dirty || busy} onClick={saveAll}>{busy ? "Сохраняю…" : "Сохранить напоминания"}</button>
          {dirty && <span className="muted">Есть несохранённые изменения</span>}
        </div>
      </div>
    </>
  );
}

// ---------- Study plan ----------
interface PlanItem {
  id: string; title: string; kind: string; courseId: number | null; course: string | null; color: string | null;
  from: string; to: string; precision: "exact" | "week" | "period"; source: "academic" | "syllabus" | "lms" | "manual";
  note?: string; state?: string; score?: number | null;
}
const PKIND: Record<string, { icon: string; label: string; color: string }> = {
  test: { icon: "📝", label: "Контрольная", color: "blue" },
  project: { icon: "🛠️", label: "Проект", color: "purple" },
  exam: { icon: "🎓", label: "Экзамен или зачёт", color: "red" },
  credit: { icon: "✅", label: "Зачётная неделя", color: "yellow" },
  session: { icon: "🔥", label: "Сессия", color: "red" },
  holiday: { icon: "🌴", label: "Каникулы", color: "green" },
  retake: { icon: "🔁", label: "Пересдачи", color: "orange" },
  practice: { icon: "🏭", label: "Практика", color: "pink" },
  deadline: { icon: "⏳", label: "Срок", color: "gray" },
  other: { icon: "📌", label: "Другое", color: "gray" },
};
const SOURCE: Record<PlanItem["source"], string> = { academic: "академический календарь (хендбук)", syllabus: "силлабус и график контрольных (хендбук)", lms: "LMS, точная дата", manual: "твоя отметка" };
const TINT = new Set(["session", "holiday", "credit", "retake", "practice"]);
const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = (d: Date) => addDays(d, -((d.getDay() + 6) % 7));
const fromIso = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const fmtD = (s: string) => fromIso(s).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });

function Plan({ courses, flash }: { courses: Grade[]; flash: (m: string) => void }) {
  const [view, setView] = useState<"month" | "year">(() => (localStorage.getItem("plan.view") as any) || "month");
  const [cursor, setCursor] = useState(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1); });
  const [data, setData] = useState<{ semester: { start: string; weeks: number }; items: PlanItem[] } | null>(null);
  const [sel, setSel] = useState<PlanItem | null>(null);
  const [form, setForm] = useState<{ title: string; kind: string; courseId: string; from: string; to: string; note: string } | null>(null);
  const [drag, setDrag] = useState<{ a: string; b: string } | null>(null);
  const [hover, setHoverRaw] = useState<{ day: string; x: number; y: number } | null>(null);
  // Closing is delayed so the pointer can travel from the day into the card (to scroll it or read it).
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepOpen = () => { if (closeTimer.current) clearTimeout(closeTimer.current); };
  const setHover = (h: { day: string; x: number; y: number } | null) => {
    keepOpen();
    if (h) setHoverRaw(h);
    else closeTimer.current = setTimeout(() => setHoverRaw(null), 180);
  };
  const load = () => api<any>("/api/plan?from=2026-06-01&to=2027-09-30").then(setData);
  useEffect(() => { load(); }, []);
  useEffect(() => { try { localStorage.setItem("plan.view", view); } catch {} }, [view]);
  useEffect(() => {
    const up = () => setDrag((d) => { if (d) { const [a, b] = d.a <= d.b ? [d.a, d.b] : [d.b, d.a]; openForm(a, b); } return null; });
    addEventListener("mouseup", up);
    return () => removeEventListener("mouseup", up);
  }, []);
  if (!data) return <div className="page muted">Загружаю…</div>;

  const today = iso(new Date());
  const semStart = fromIso(data.semester.start);
  const weekNo = (d: Date) => { const n = Math.floor((mondayOf(d).getTime() - semStart.getTime()) / 6048e5) + 1; return n >= 1 && n <= data.semester.weeks ? n : null; };
  const curWeek = weekNo(new Date());
  const itemsOn = (day: string) => data.items.filter((i) => i.from <= day && i.to >= day);
  const tintOf = (day: string) => itemsOn(day).find((i) => i.source === "academic" && TINT.has(i.kind))?.kind;
  const colorOf = (i: PlanItem) => i.color ?? PKIND[i.kind]?.color ?? "gray";
  function openForm(from: string, to: string) { setSel(null); setForm({ title: "", kind: "other", courseId: "", from, to, note: "" }); }
  const shift = (n: number) => setCursor((c) => (view === "month" ? new Date(c.getFullYear(), c.getMonth() + n, 1) : new Date(c.getFullYear() + n, c.getMonth(), 1)));
  const save = async () => {
    if (!form?.title.trim()) return flash("Нужно название");
    await api("/api/plan", { method: "POST", json: { ...form, courseId: form.courseId ? Number(form.courseId) : null } });
    setForm(null); flash("Отмечено"); load();
  };
  const remove = async (id: string) => { await api(`/api/plan/${encodeURIComponent(id)}`, { method: "DELETE" }); setSel(null); load(); };
  const inDrag = (day: string) => drag && day >= (drag.a <= drag.b ? drag.a : drag.b) && day <= (drag.a <= drag.b ? drag.b : drag.a);

  // ----- month view -----
  const monthView = () => {
    const first = cursor, last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const rows: Date[] = [];
    for (let d = mondayOf(first); d <= last; d = addDays(d, 7)) rows.push(d);
    return (
      <div className="mcal">
        <div className="mhead"><span /> {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((d) => <span key={d}>{d}</span>)}</div>
        {rows.map((mon) => {
          const days = Array.from({ length: 7 }, (_, i) => addDays(mon, i));
          const a = iso(days[0]), b = iso(days[6]);
          const segs = data.items.filter((i) => i.from <= b && i.to >= a && !(i.source === "academic" && i.kind === "deadline" && false));
          const lanes: string[][] = [];
          const placed = segs.map((i) => {
            const s = Math.max(0, Math.round((fromIso(i.from > a ? i.from : a).getTime() - days[0].getTime()) / 864e5));
            const e = Math.min(6, Math.round((fromIso(i.to < b ? i.to : b).getTime() - days[0].getTime()) / 864e5));
            let lane = lanes.findIndex((l) => l.every((x) => { const [xs, xe] = x.split(":").map(Number); return e < xs || s > xe; }));
            if (lane === -1) { lanes.push([]); lane = lanes.length - 1; }
            lanes[lane].push(`${s}:${e}`);
            return { i, s, e, lane, cont: i.from < a, more: i.to > b };
          });
          const wn = weekNo(mon);
          return (
            <div className="mrow" key={a} style={{ gridTemplateRows: `26px repeat(${Math.max(lanes.length, 2)}, 24px) 6px` }}>
              <div className={`wk ${wn && wn === curWeek ? "cur" : ""}`} style={{ gridRow: "1 / -1" }} title={wn ? `Учебная неделя ${wn}` : ""}>{wn ? `Н${wn}` : ""}</div>
              {days.map((d, k) => {
                const day = iso(d), t = tintOf(day);
                return (
                  <div key={day} className={`mday ${d.getMonth() !== cursor.getMonth() ? "out" : ""} ${t ? `tint-${PKIND[t].color}` : ""} ${day === today ? "today" : ""} ${inDrag(day) ? "sel" : ""}`}
                    style={{ gridColumn: k + 2, gridRow: "1 / -1" }}
                    onMouseDown={(e) => { if (e.button === 0) { e.preventDefault(); setDrag({ a: day, b: day }); } }}
                    onMouseEnter={() => setDrag((dr) => (dr ? { ...dr, b: day } : dr))}>
                    <span className="dn">{d.getDate()}</span>
                  </div>
                );
              })}
              {placed.map(({ i, s, e, lane, cont, more }) => (
                <button key={i.id + a} className={`bar tag ${colorOf(i)} p-${i.precision} ${i.source === "lms" && (i.state === "evaluated" || i.state === "failed") ? "past" : ""}`}
                  style={{ gridColumn: `${s + 2} / ${e + 3}`, gridRow: lane + 2, borderTopLeftRadius: cont ? 0 : undefined, borderBottomLeftRadius: cont ? 0 : undefined, borderTopRightRadius: more ? 0 : undefined, borderBottomRightRadius: more ? 0 : undefined }}
                  title={`${i.title}${i.course ? ` · ${i.course}` : ""} · ${fmtD(i.from)}${i.to !== i.from ? `–${fmtD(i.to)}` : ""}`}
                  onMouseDown={(ev) => ev.stopPropagation()} onClick={() => { setForm(null); setSel(i); }}>
                  {!cont && <>{PKIND[i.kind]?.icon} {i.precision === "week" ? "≈ " : ""}{i.course ? <b>{i.course}</b> : null} {i.title}</>}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    );
  };

  // ----- year view: academic year starting September -----
  const yearView = () => {
    const startYear = cursor.getMonth() >= 8 ? cursor.getFullYear() : cursor.getFullYear() - 1;
    const months = Array.from({ length: 12 }, (_, k) => new Date(startYear, 8 + k, 1));
    return (
      <div className="ycal">
        {months.map((m) => {
          const last = new Date(m.getFullYear(), m.getMonth() + 1, 0);
          const cells: (Date | null)[] = Array((m.getDay() + 6) % 7).fill(null);
          for (let d = 1; d <= last.getDate(); d++) cells.push(new Date(m.getFullYear(), m.getMonth(), d));
          const mItems = data.items.filter((i) => i.source !== "academic" && i.from <= iso(last) && i.to >= iso(m));
          return (
            <div className="ymonth" key={iso(m)}>
              <button className="ytitle" onClick={() => { setCursor(m); setView("month"); }}>{MONTHS[m.getMonth()]} <span className="muted">{m.getFullYear()}</span>{mItems.length ? <span className="ycount">{mItems.length}</span> : null}</button>
              <div className="ygrid">
                {cells.map((d, k) => {
                  if (!d) return <span key={k} />;
                  const day = iso(d), t = tintOf(day);
                  const course = itemsOn(day).filter((i) => i.source !== "academic" && i.precision !== "period");
                  return (
                    <button key={k} className={`yday ${t ? `tint-${PKIND[t].color}` : ""} ${day === today ? "today" : ""}`}
                      onMouseEnter={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHover({ day, x: r.left + r.width / 2, y: r.bottom }); }}
                      onMouseLeave={() => setHover(null)}
                      onFocus={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHover({ day, x: r.left + r.width / 2, y: r.bottom }); }}
                      onBlur={() => setHover(null)}
                      onClick={() => { setCursor(new Date(d.getFullYear(), d.getMonth(), 1)); setView("month"); }}>
                      {d.getDate()}
                      {course.length > 0 && (
                        <span className="ydots" aria-label={`отметок: ${course.length}`}>
                          {course.slice(0, 4).map((i) => <i key={i.id} className={`ydot c-${colorOf(i)} ${i.precision === "week" ? "approx" : ""}`} />)}
                          {course.length > 4 && <b className="ymore">+</b>}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  };


  // Hover card for a day in the year view.
  const dayPopover = () => {
    if (!hover || view !== "year") return null;
    const d = fromIso(hover.day);
    const all = itemsOn(hover.day);
    const periods = all.filter((i) => i.source === "academic");
    const items = all.filter((i) => i.source !== "academic");
    const wn = weekNo(d);
    const W = 280;
    const left = Math.min(Math.max(hover.x - W / 2, 8), innerWidth - W - 8);
    const top0 = hover.y - 28; // top edge of the hovered day
    const below = innerHeight - hover.y >= top0;
    const maxH = (below ? innerHeight - hover.y : top0) - 16;
    return (
      <div className="ypop" style={{ left, width: W, maxHeight: Math.max(maxH, 160), ...(below ? { top: hover.y + 4 } : { bottom: innerHeight - top0 + 4 }) }}
        role="dialog" aria-label="Отметки дня" onMouseEnter={keepOpen} onMouseLeave={() => setHover(null)}>
        <div className="ypop-h">
          <b>{d.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" })}</b>
          {wn ? <span className="muted">неделя {wn}</span> : null}
        </div>
        {periods.map((p) => <div key={p.id} className={`ypop-period tint-${PKIND[p.kind]?.color ?? "gray"}`}>{PKIND[p.kind]?.icon} {p.title} <span className="muted">· {fmtD(p.from)}{p.to !== p.from ? `–${fmtD(p.to)}` : ""}</span></div>)}
        {items.map((i) => (
          <div key={i.id} className="ypop-item">
            <span>{PKIND[i.kind]?.icon}</span>
            <div style={{ minWidth: 0 }}>
              <div className="ypop-title">{i.course && <Tag c={i.color}>{i.course}</Tag>} {i.title}</div>
              <div className="muted ypop-sub">
                {i.precision === "exact" ? (i.from === i.to ? "точная дата" : `${fmtD(i.from)}–${fmtD(i.to)}`) : i.precision === "week" ? `где-то на неделе, ${fmtD(i.from)}–${fmtD(i.to)}` : `в течение периода, ${fmtD(i.from)}–${fmtD(i.to)}`}
                {i.source === "lms" && i.state ? ` · ${LMS_STATE[i.state]?.[1] ?? i.state}${i.score != null ? `, ${i.score}` : ""}` : ""}
                {i.source === "manual" ? " · твоя отметка" : ""}
              </div>
            </div>
          </div>
        ))}
        <button className="ypop-open" onClick={() => { setHoverRaw(null); setCursor(new Date(d.getFullYear(), d.getMonth(), 1)); setView("month"); }}>Открыть {MONTHS[d.getMonth()].toLowerCase()} →</button>
        {!all.length && <div className="muted">Ничего не запланировано</div>}
      </div>
    );
  };
  const rangeFrom = view === "month" ? iso(cursor) : iso(new Date(cursor.getMonth() >= 8 ? cursor.getFullYear() : cursor.getFullYear() - 1, 8, 1));
  const rangeTo = view === "month" ? iso(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0)) : iso(new Date(cursor.getMonth() >= 8 ? cursor.getFullYear() + 1 : cursor.getFullYear(), 7, 31));
  const listed = data.items.filter((i) => i.source !== "academic" && i.from <= rangeTo && i.to >= rangeFrom);
  const title = view === "month" ? `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}` : `${rangeFrom.slice(0, 4)}/${rangeTo.slice(0, 4)} учебный год`;

  return (
    <>
      <div className="topbar"><span className="crumb">🗺️ Учебный план</span></div>
      <div className="page wide">
        <div className="page-title" style={{ fontSize: 32 }}>Учебный план</div>
        <div className="page-sub">{curWeek ? `Сейчас неделя ${curWeek} из ${data.semester.weeks}. ` : ""}Точные даты берутся из LMS, недели из силлабусов и графика контрольных в хендбуке (≈ и пунктир), сессия и каникулы из академического календаря. Выдели дни мышкой, чтобы отметить свой промежуток.</div>
        <div className="board-bar">
          <button className="btn outline" onClick={() => shift(-1)} aria-label="Назад">←</button>
          <button className="btn outline" onClick={() => { const n = new Date(); setCursor(new Date(n.getFullYear(), n.getMonth(), 1)); }}>Сегодня</button>
          <button className="btn outline" onClick={() => shift(1)} aria-label="Вперёд">→</button>
          <b style={{ fontSize: 18, marginLeft: 8 }}>{title}</b>
          <span style={{ flex: 1 }} />
          <button className="btn outline" onClick={() => openForm(today, today)}>+ Отметить промежуток</button>
          <button className={`chip ${view === "month" ? "on" : ""}`} onClick={() => setView("month")}>Месяц</button>
          <button className={`chip ${view === "year" ? "on" : ""}`} onClick={() => setView("year")}>Год</button>
        </div>

        {form && (
          <div className="course-set" style={{ marginBottom: 14 }}>
            <div className="fgrid">
              <div className="field"><label htmlFor="pl-t">Что</label><input id="pl-t" autoFocus className="input" placeholder="Например: подготовка к экзамену" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} onKeyDown={(e) => e.key === "Enter" && save()} /></div>
              <div className="field"><label htmlFor="pl-k">Тип</label><select id="pl-k" className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{Object.entries(PKIND).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}</select></div>
              <div className="field"><label htmlFor="pl-c">Курс</label><select id="pl-c" className="input" value={form.courseId} onChange={(e) => setForm({ ...form, courseId: e.target.value })}><option value="">Без курса</option>{courses.filter((g) => g.activities.length).map((g) => <option key={g.id} value={g.id}>{g.short}</option>)}</select></div>
              <div className="field"><label htmlFor="pl-f">С</label><input id="pl-f" type="date" className="input" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} /></div>
              <div className="field"><label htmlFor="pl-to">По</label><input id="pl-to" type="date" className="input" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} /></div>
            </div>
            <div className="field"><label htmlFor="pl-n">Заметка</label><input id="pl-n" className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></div>
            <div className="actions" style={{ margin: 0 }}><button className="btn primary" onClick={save}>Отметить</button><button className="btn" onClick={() => setForm(null)}>Отмена</button></div>
          </div>
        )}

        {sel && (
          <div className={`callout ${PKIND[sel.kind]?.color === "red" ? "red" : ""}`} style={{ marginBottom: 14, alignItems: "flex-start" }}>
            <span className="ci">{PKIND[sel.kind]?.icon}</span>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
              <div><b>{sel.title}</b>{sel.course && <> · <Tag c={sel.color}>{sel.course}</Tag></>}</div>
              <div className="num">{fmtD(sel.from)}{sel.to !== sel.from ? ` – ${fmtD(sel.to)}` : ""}{sel.precision === "week" ? " · точная дата неизвестна, только неделя" : sel.precision === "period" ? " · в течение периода, дата будет в расписании" : ""}</div>
              <div className="muted">Источник: {SOURCE[sel.source]}{sel.note ? ` · ${sel.note}` : ""}{sel.state ? ` · в LMS: ${LMS_STATE[sel.state]?.[1] ?? sel.state}` : ""}{sel.score != null ? `, оценка ${sel.score}` : ""}</div>
            </div>
            {sel.source === "manual" && <button className="btn" onClick={() => remove(sel.id)}>Удалить</button>}
            <button className="btn" onClick={() => setSel(null)} aria-label="Закрыть">✕</button>
          </div>
        )}

        {view === "month" ? <div className="tbl-wrap">{monthView()}</div> : yearView()}
        {dayPopover()}

        <div className="legend">
          {Object.entries(PKIND).filter(([k]) => k !== "other").map(([k, v]) => <span key={k} className={TINT.has(k) ? `lg tint-${v.color}` : "lg"}>{v.icon} {v.label}</span>)}
          <span className="lg"><span className="tag gray p-week" style={{ height: 16 }}>≈ неделя</span> известна только неделя</span>
        </div>

        <h2 className="h">{view === "month" ? "В этом месяце" : "За учебный год"}</h2>
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th>Когда</th><th>Курс</th><th>Что</th><th>Тип</th><th>Точность</th></tr></thead>
          <tbody>
            {listed.map((i) => (
              <tr key={i.id} onClick={() => setSel(i)} style={{ cursor: "pointer" }}>
                <td className="num" style={{ whiteSpace: "nowrap" }}>{fmtD(i.from)}{i.to !== i.from ? ` – ${fmtD(i.to)}` : ""}{weekNo(fromIso(i.from)) ? <span className="muted"> · Н{weekNo(fromIso(i.from))}</span> : null}</td>
                <td>{i.course ? <Tag c={i.color}>{i.course}</Tag> : <span className="muted">все</span>}</td>
                <td>{i.title}</td>
                <td>{PKIND[i.kind]?.icon} {PKIND[i.kind]?.label}</td>
                <td>{i.precision === "exact" ? <Tag c="green">точно</Tag> : i.precision === "week" ? <Tag>неделя</Tag> : <Tag c="yellow">период</Tag>}</td>
              </tr>
            ))}
            {!listed.length && <tr><td colSpan={5} className="muted">Ничего не запланировано</td></tr>}
          </tbody>
        </table></div>
      </div>
    </>
  );
}

// ---------- Setup wizard ----------
interface SetupCourse {
  id: number; name: string; category: string; archived: boolean; rule: "repo" | "user" | null; ruleFile: string | null;
  tracked: boolean; short: string; color: string; totalWeight: number;
  activities: { name: string; weight: number; planned: number; lateDays: boolean; kind: string }[];
}
interface SetupData {
  done: boolean;
  session: { ok: boolean; name: string | null };
  login: { status: "idle" | "installing" | "waiting" | "ok" | "error"; error: string | null };
  settings: SettingsData;
  firstSync: { running: boolean; report: { errors: string[] } | null } | null;
}
const STEPS = ["Вход в LMS", "Курсы", "Учебный год", "Календарь", "Готово"];
const RULE_TAG: Record<string, [string, string, string]> = {
  repo: ["green", "по силлабусу", "Правила из rules/*.yaml: веса, блокеры и контрольные точки уже описаны"],
  user: ["blue", "из LMS", "Правила созданы мастером из LMS, лежат в ~/.cu-hub/rules"],
  none: ["yellow", "создадим из LMS", "Веса и число работ возьмём из LMS. Блокеры и контрольные точки добавишь по силлабусу"],
};

/** First-run setup: LMS session → courses → academic year and reminders → calendar → first sync. */
function Setup({ onDone, flash }: { onDone: () => void; flash: (m: string) => void }) {
  const [step, setStep] = useState(0);
  const [d, setD] = useState<SetupData | null>(null);
  const [courses, setCourses] = useState<SetupCourse[] | null>(null);
  const [coursesErr, setCoursesErr] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [general, setGeneral] = useState<SettingsData["general"] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api<SetupData>("/api/setup").then((x) => { setD(x); setGeneral((g) => g ?? x.settings.general); return x; }), []);
  useEffect(() => { load(); }, [load]);
  // While the LMS window is open, poll until the session appears.
  const waiting = d?.login.status === "waiting" || d?.login.status === "installing";
  const syncRunning = !!d?.firstSync?.running;
  useEffect(() => {
    if (!waiting && !syncRunning) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [waiting, syncRunning, load]);
  useEffect(() => {
    if (step !== 1 || courses) return;
    setCoursesErr(null);
    api<SetupCourse[]>("/api/setup/courses").then(setCourses).catch((e) => setCoursesErr(e.message));
  }, [step, courses]);

  if (!d || !general) return <div className="page muted">Загружаю…</div>;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e) { flash((e as Error).message); } finally { setBusy(false); }
  };
  const login = () => run(async () => { await api("/api/setup/login", { method: "POST" }); await load(); });
  const patch = (id: number, p: Partial<SetupCourse>) => setCourses((cs) => cs!.map((c) => (c.id === id ? { ...c, ...p } : c)));
  const picked = courses?.filter((c) => c.tracked) ?? [];
  const saveCourses = () => run(async () => {
    await api("/api/setup/courses", { method: "PUT", json: picked.map((c) => ({ id: c.id, short: c.short, color: c.color })) });
    setStep(2);
  });
  const saveGeneral = () => run(async () => {
    const x = await api<SettingsData>("/api/settings", { method: "PUT", json: { general } });
    setD({ ...d, settings: x });
    setStep(3);
  });
  const finish = () => run(async () => {
    await api("/api/setup/finish", { method: "POST" });
    await load();
  });
  const report = d.firstSync?.report ?? null;
  const canGo = (i: number) => i === 0 || (d.session.ok && (i === 1 || (courses !== null && picked.length > 0 && i <= Math.max(step, 2))));

  return (
    <div className="setup">
      <div className="page">
        <div className="page-icon">🎓</div>
        <div className="page-title">Настройка учебного штаба</div>
        <div className="page-sub">Пара минут: войдём в LMS, выберем курсы, и доска соберётся сама. Всё хранится только на этом компьютере в <span className="mono">~/.cu-hub</span>.</div>

        <ol className="steps">
          {STEPS.map((t, i) => (
            <li key={t}><button className={`step ${i === step ? "on" : ""} ${i < step ? "done" : ""}`} disabled={!canGo(i)} onClick={() => setStep(i)}>
              <span className="n">{i < step ? "✓" : i + 1}</span>{t}
            </button></li>
          ))}
        </ol>

        {step === 0 && (
          <div className="section">
            <h2 className="h" style={{ margin: 0 }}>🔑 Вход в LMS</h2>
            <div className="muted">Откроется отдельное окно Chromium со страницей LMS. Войди как обычно: логин и пароль вводишь только ты, программа их не видит и не хранит. Окно закроется само, когда вход получится.</div>
            {d.session.ok ? (
              <div className="callout" style={{ background: "var(--t-green)", color: "var(--t-green-fg)" }}><span className="ci">✅</span><div>Сессия LMS активна{d.session.name ? `: ${d.session.name}` : ""}.</div></div>
            ) : d.login.status === "installing" ? (
              <div className="callout blue"><span className="ci"><span className="spin">⟳</span></span><div>Скачиваю браузер Chromium для входа (около 150 МБ, только в первый раз)…</div></div>
            ) : d.login.status === "waiting" ? (
              <div className="callout blue"><span className="ci"><span className="spin">⟳</span></span><div>Жду, пока ты войдёшь в открывшемся окне. Если окна не видно, поищи его в Dock.</div></div>
            ) : d.login.status === "error" ? (
              <div className="callout red"><span className="ci">⚠️</span><div>{d.login.error}</div></div>
            ) : null}
            <div className="actions" style={{ margin: 0 }}>
              {!d.session.ok && <button className="btn primary" disabled={busy || waiting} onClick={login}>{waiting ? "Окно входа открыто…" : "Войти в LMS"}</button>}
              {d.session.ok && <button className="btn outline" disabled={busy || waiting} onClick={login}>Войти заново</button>}
              {d.session.ok && <button className="btn primary" onClick={() => setStep(1)}>Дальше: курсы →</button>}
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="section">
            <h2 className="h" style={{ margin: 0 }}>📚 Курсы</h2>
            <div className="muted">Это твои курсы из LMS. Отметь те, что нужно вести на доске, и задай короткое имя для меню. Оценка считается по весам активностей из LMS.</div>
            {coursesErr && <div className="callout red"><span className="ci">⚠️</span><div>{coursesErr}</div></div>}
            {!courses && !coursesErr && <div className="muted"><span className="spin">⟳</span> Загружаю курсы из LMS…</div>}
            {courses && (
              <div className="tbl-wrap"><table className="tbl">
                <thead><tr><th></th><th>Курс</th><th>Короткое имя</th><th>Цвет</th><th>Правила</th></tr></thead>
                <tbody>
                  {courses.map((c) => {
                    const [tc, tl, tt] = RULE_TAG[c.rule ?? "none"];
                    return (
                      <React.Fragment key={c.id}>
                        <tr style={{ opacity: c.tracked ? 1 : 0.55 }}>
                          <td><input type="checkbox" aria-label={`Вести курс ${c.name}`} checked={c.tracked} onChange={(e) => patch(c.id, { tracked: e.target.checked })} /></td>
                          <td>
                            <button className="linklike" onClick={() => setOpen(open === c.id ? null : c.id)} title="Показать активности и веса">{c.name}</button>
                            <div className="muted" style={{ fontSize: 12 }}>
                              {c.activities.length ? `${c.activities.length} активн. · сумма весов ${c.totalWeight}` : "нет оцениваемых активностей"}{c.archived ? " · архив" : ""}
                            </div>
                          </td>
                          <td><input className="input" style={{ maxWidth: 150 }} aria-label="Короткое имя" value={c.short} onChange={(e) => patch(c.id, { short: e.target.value })} /></td>
                          <td><div className="swatches">{COLORS.map((col) => <button key={col} title={col} aria-label={`Цвет ${col}`} className={`swatch sm c-${col} ${c.color === col ? "on" : ""}`} onClick={() => patch(c.id, { color: col })} />)}</div></td>
                          <td><Tag c={tc} title={tt}>{tl}</Tag></td>
                        </tr>
                        {open === c.id && (
                          <tr><td></td><td colSpan={4}>
                            {c.activities.length ? (
                              <table className="tbl mini-tbl"><tbody>
                                {c.activities.map((a) => <tr key={a.name}><td>{a.name}</td><td className="num">вес {a.weight}</td><td className="num">работ {a.planned}</td><td>{a.lateDays ? "late days" : ""}</td></tr>)}
                              </tbody></table>
                            ) : <div className="muted">В LMS у курса нет активностей с весом: он попадёт на доску без оценки.</div>}
                          </td></tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table></div>
            )}
            {courses && courses.some((c) => c.tracked && !c.rule) && (
              <div className="callout yellow"><span className="ci">✍️</span><div>Для курсов с пометкой «создадим из LMS» появятся файлы в <span className="mono">~/.cu-hub/rules</span>. Блокеры (например, «экзамен ≥ 3.5») и контрольные точки по неделям есть только в силлабусе: их можно дописать потом, подсказки в <span className="mono">rules/README.md</span>.</div></div>
            )}
            <div className="actions" style={{ margin: 0 }}>
              <button className="btn" onClick={() => setStep(0)}>← Назад</button>
              <button className="btn primary" disabled={busy || !picked.length} onClick={saveCourses}>{busy ? "Сохраняю…" : `Сохранить курсы (${picked.length}) →`}</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="section">
            <h2 className="h" style={{ margin: 0 }}>🗺️ Учебный год и напоминания</h2>
            <div className="callout"><span className="ci">ℹ️</span><div>Сессия, каникулы и зачётная неделя берутся из <span className="mono">rules/_academic.yaml</span> (2026/27, Школа технологий). Если у тебя другой график, положи свою копию в <span className="mono">~/.cu-hub/rules/_academic.yaml</span>. Начало семестра можно поправить прямо здесь.</div></div>
            <GeneralFields general={general} set={setGeneral} />
            <div className="actions" style={{ margin: 0 }}>
              <button className="btn" onClick={() => setStep(1)}>← Назад</button>
              <button className="btn primary" disabled={busy} onClick={saveGeneral}>Дальше: календарь →</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="section">
            <h2 className="h" style={{ margin: 0 }}>🗓️ Календарь (по желанию)</h2>
            <div className="muted">Расписание пар из Яндекс Календаря по CalDAV: с ним появятся вердикты «идти на пару» и напоминания. Нужен пароль приложения: Яндекс ID → Безопасность → Пароли приложений → «Календарь CalDAV». Можно пропустить и подключить потом в настройках.</div>
            <CalendarForm saved={d.settings.caldav} onSaved={(x) => setD({ ...d, settings: x })} flash={flash} />
            <div className="actions" style={{ margin: 0 }}>
              <button className="btn" onClick={() => setStep(2)}>← Назад</button>
              <button className="btn primary" onClick={() => setStep(4)}>{d.settings.caldav ? "Дальше →" : "Пропустить →"}</button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="section">
            <h2 className="h" style={{ margin: 0 }}>🚀 Готово</h2>
            <div className="muted">Первая синхронизация скачает задания и материалы выбранных курсов в <span className="mono">{general.workspaceRoot}</span>. Это может занять пару минут.</div>
            <ul className="muted" style={{ margin: 0 }}>
              <li>Курсов на доске: {picked.length || "?"}</li>
              <li>Календарь: {d.settings.caldav ? d.settings.caldav.username : "не подключён"}</li>
              <li>Начало семестра: {general.semesterStart}</li>
            </ul>
            {report && (report.errors.length
              ? <div className="callout yellow"><span className="ci">⚠️</span><div>Синхронизация прошла с ошибками: {report.errors.join("; ")}. Доску уже можно открыть, остальное догонит фоновая синхронизация.</div></div>
              : <div className="callout" style={{ background: "var(--t-green)", color: "var(--t-green-fg)" }}><span className="ci">✅</span><div>Всё синхронизировано.</div></div>)}
            <div className="callout"><span className="ci">💡</span><div>Чтобы доска и напоминания работали в фоне после перезагрузки, выполни в терминале <span className="mono">cu install</span>. MCP-сервер для Claude Code уже прописан в <span className="mono">.mcp.json</span> проекта.</div></div>
            <div className="actions" style={{ margin: 0 }}>
              <button className="btn" onClick={() => setStep(3)}>← Назад</button>
              {!report && <button className="btn primary" disabled={busy || syncRunning} onClick={finish}>{busy || syncRunning ? <><span className="spin">⟳</span> Синхронизирую…</> : "Синхронизировать и открыть доску"}</button>}
              {report && <button className="btn primary" onClick={onDone}>Открыть доску →</button>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
