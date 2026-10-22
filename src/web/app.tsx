import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

// ---------- types (mirrors server payloads) ----------
type Col = "inbox" | "week" | "today" | "doing" | "review" | "done";
interface Card {
  id: string; kind: "lms" | "event" | "prep" | "manual"; courseId: number | null; course: string | null; color: string | null;
  title: string; subtitle: string; col: Col; due: string | null; delta: number; blocker: string | null; lateDays: boolean;
  state: string; verdict?: string; verdictLabel?: string; priority: number; notes: string; aiMode?: string; link?: string;
  score?: number | null; effortH?: number; ord: number;
}
interface Activity { key: string; name: string; kind: string; weight: number; syllabusWeight: number; planned: number; graded: number; earned: number; remaining: number; lost: number; itemValue: number; lateDays: boolean; scores: { name: string; score: number }[] }
interface Grade {
  id: number; slug: string; title: string; short: string; color: string; threshold: number; earned: number; lost: number; remaining: number;
  maxReachable: number; bonusLeft: number; neededShare: number; status: "ok" | "watch" | "risk" | "blocked" | "impossible";
  activities: Activity[]; blockers: { label: string; status: string; detail: string }[]; warnings: string[];
  waiting: { name: string; state: string }[]; rounding: string | null; aiMode: string; aiNote: string; syllabusUrl: string | null; timeUrl: string | null;
}
interface ClassEv { uid: string; start: string; end: string; title: string; location: string; courseId: number | null; course: string | null; color: string | null; verdict: string; points: number; reason: string; attended: number | null }
interface Item { id: string; course: string; color: string; title: string; deadline: string | null; delta: number; blocker: string | null; lateDaysAllowed: boolean; state: string; hoursLeft: number | null; effortH: number; lateDayAdvice?: { allowed: boolean; reasoning: string; suggestDays: number } | null }
interface State {
  today: { alerts: { level: string; course: string; text: string }[]; classes: ClassEv[]; deadlines72h: Item[]; top: Item[] };
  grades: Grade[];
  board: { columns: { id: Col; title: string }[]; cards: Card[] };
  meta: { lateDaysBalance: number | null; lmsSyncedAt: string | null; calSyncedAt: string | null; lastSync: { errors: string[] } | null; syncing: boolean; calendarConfigured: boolean };
}

// ---------- helpers ----------
const api = async <T,>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> => {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json" }, body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
};
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
const STATUS: Record<Grade["status"], [string, string]> = {
  ok: ["green", "В норме"], watch: ["yellow", "Мало запаса"], risk: ["orange", "Риск"], blocked: ["red", "Блокер"], impossible: ["red", "Не сдать по формуле"],
};
const VERDICT: Record<string, [string, string]> = {
  must: ["red", "Обязательно"], should: ["yellow", "Желательно"], recording: ["blue", "Можно запись"], optional: ["gray", "По желанию"], unknown: ["gray", "?"],
};
const LMS_STATE: Record<string, [string, string]> = {
  notCreated: ["gray", "Нет в LMS"], backlog: ["gray", "Не начато"], inProgress: ["blue", "В работе"], submitted: ["purple", "Отправлено"],
  review: ["purple", "На проверке"], evaluated: ["green", "Оценено"], failed: ["red", "Не сдано"], planned: ["gray", "Запланировано"],
  attended: ["green", "Был"], skipped: ["red", "Пропустил"], open: ["gray", "Открыто"], done: ["green", "Готово"],
};
const AI: Record<string, [string, string]> = {
  execute: ["green", "ИИ: черновик"], assist: ["yellow", "ИИ: вместе"], tutor_only: ["red", "ИИ: только подсказки"],
};
const COL_ICON: Record<Col, string> = { inbox: "📥", week: "🗓️", today: "🔥", doing: "🛠️", review: "👀", done: "✅" };

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
type Route = { page: "today" } | { page: "board" } | { page: "week" } | { page: "course"; slug: string };
const parseHash = (): Route => {
  const h = location.hash.slice(1);
  if (h.startsWith("course-")) return { page: "course", slug: h.slice(7) };
  if (h === "board" || h === "week") return { page: h };
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

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="ws"><span className="avatar">🎓</span>Учебный штаб</div>
        <button className={`nav ${route.page === "today" ? "active" : ""}`} onClick={() => go("today")}><span className="ic">🏠</span>Сегодня</button>
        <button className={`nav ${route.page === "board" ? "active" : ""}`} onClick={() => go("board")}><span className="ic">📋</span>Доска<span className="badge">{state.board.cards.filter((c) => c.col === "today").length || ""}</span></button>
        <button className={`nav ${route.page === "week" ? "active" : ""}`} onClick={() => go("week")}><span className="ic">🗓️</span>Неделя</button>
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
        {route.page === "board" && <Board s={state} open={setPeek} reload={load} />}
        {route.page === "week" && <Week open={setPeek} />}
        {route.page === "course" && <Course slug={route.slug} s={state} open={setPeek} />}
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
        <div className="page-sub">Late days: {s.meta.lateDaysBalance ?? "?"} · синхронизация LMS {ago(s.meta.lmsSyncedAt)}</div>
        {s.meta.lastSync?.errors?.length ? <div className="callout yellow"><span className="ci">⚠️</span><div>{s.meta.lastSync.errors.join(" · ")}</div></div> : null}
        {crit.map((a, i) => (
          <div key={i} className={`callout ${a.level === "crit" ? "red" : "yellow"}`}><span className="ci">{a.level === "crit" ? "🚨" : "⚠️"}</span><div><b>{a.course}</b> · {a.text}</div></div>
        ))}

        <h2 className="h">Пары</h2>
        {!s.meta.calendarConfigured && <div className="callout blue"><span className="ci">🗓️</span><div>Календарь не подключён: добавь секцию <code>caldav</code> в <code>~/.cu-hub/config.yaml</code> (см. README).</div></div>}
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
function Board({ s, open, reload }: { s: State; open: (id: string) => void; reload: () => void }) {
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
    setCards((cs) => cs.map((c) => (c.id === drag ? { ...c, col } : c)));
    await api(`/api/cards/${encodeURIComponent(drag)}/move`, { method: "POST", json: { col } });
    setDrag(null);
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
            return (
              <div key={col.id} className={`col ${over === col.id ? "drop" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setOver(col.id); }} onDragLeave={() => setOver(null)} onDrop={() => drop(col.id)}>
                <div className="col-h"><span>{COL_ICON[col.id]}</span><b>{col.title}</b><span className="count">{list.length}</span></div>
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
        {c.kind === "lms" && c.score != null && <Tag c={c.score >= 3.5 ? "green" : "red"}>{c.score}</Tag>}
        {c.kind === "lms" && c.state === "notCreated" && <Tag>нет в LMS</Tag>}
      </div>
      {c.due && c.kind !== "event" && <div className={`kd ${late ? "late" : ""}`}>⏰ {dueLabel(c.due)}</div>}
    </div>
  );
}

// ---------- Peek ----------
function Peek({ card, grade, close, reload, flash, balance }: { card: Card; grade?: Grade; close: () => void; reload: () => void; flash: (m: string) => void; balance: number | null }) {
  const [notes, setNotes] = useState(card.notes);
  const [ws, setWs] = useState<{ dir: string; cloneNotes: string[]; aiMode: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setNotes(card.notes); setWs(null); }, [card.id]);
  useEffect(() => { const f = (e: KeyboardEvent) => e.key === "Escape" && close(); addEventListener("keydown", f); return () => removeEventListener("keydown", f); }, [close]);
  const save = () => notes !== card.notes && api(`/api/cards/${encodeURIComponent(card.id)}`, { method: "PATCH", json: { notes } }).then(reload);
  const hide = async () => { await api(`/api/cards/${encodeURIComponent(card.id)}`, { method: "PATCH", json: { hidden: true } }); close(); reload(); };
  const move = async (col: Col) => { await api(`/api/cards/${encodeURIComponent(card.id)}/move`, { method: "POST", json: { col } }); reload(); };
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
            <select value={card.col} onChange={(e) => move(e.target.value as Col)} style={{ border: 0, background: "transparent" }}>
              {(["inbox", "week", "today", "doing", "review", "done"] as Col[]).map((c) => <option key={c} value={c}>{COL_ICON[c]} {c === "inbox" ? "Входящие" : c === "week" ? "Эта неделя" : c === "today" ? "Сегодня" : c === "doing" ? "В работе" : c === "review" ? "На проверке" : "Готово"}</option>)}
            </select>
          </div>
          {card.due && <><div className="k">⏰ {card.kind === "event" ? "Начало" : "Дедлайн"}</div><div className="v">{dueLabel(card.due)}</div></>}
          <div className="k">◎ Статус</div><div className="v"><Tag c={LMS_STATE[card.state]?.[0]}>{LMS_STATE[card.state]?.[1] ?? card.state}</Tag>{card.score != null && <Tag c={card.score >= 3.5 ? "green" : "red"}>оценка {card.score}</Tag>}</div>
          {card.delta > 0 && <><div className="k">Σ Вклад в итог</div><div className="v num">+{f2(card.delta)} из 10</div></>}
          {card.blocker && <><div className="k">⛔ Блокер</div><div className="v"><Tag c="red">{card.blocker}</Tag></div></>}
          {card.kind === "lms" && <><div className="k">⏳ Late days</div><div className="v">{card.lateDays ? <><Tag c="green">можно</Tag><span className="muted">на балансе {balance ?? "?"} · 1 LD = 1 день, максимум 7, не позже 19.12</span></> : <Tag>нельзя по силлабусу</Tag>}</div></>}
          {card.aiMode && <><div className="k">✦ Политика ИИ</div><div className="v"><Tag c={AI[card.aiMode]?.[0]}>{AI[card.aiMode]?.[1]}</Tag></div></>}
          {card.verdictLabel && <><div className="k">✓ Идти?</div><div className="v">{card.verdictLabel}</div></>}
          {card.effortH != null && <><div className="k">⌛ Оценка времени</div><div className="v">{card.effortH} ч</div></>}
        </div>

        {grade && card.aiMode && <div className={`callout ${card.aiMode === "tutor_only" ? "red" : ""}`}><span className="ci">✦</span><div><b>Политика ИИ курса.</b> {grade.aiNote}</div></div>}

        {card.kind === "lms" && (
          <>
            <h3 className="h">Работа с агентом</h3>
            <div className="actions">
              <button className="btn primary" onClick={workspace} disabled={busy}>{busy ? "Собираю…" : "📁 Создать рабочую папку"}</button>
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
  const [w, setW] = useState<{ days: { date: string; classes: ClassEv[]; due: Item[]; loadH: number; overloaded: boolean; suggestions: string[] }[]; recoverable: Item[] } | null>(null);
  useEffect(() => { api<any>("/api/week").then(setW); }, []);
  if (!w) return <div className="page muted">Загружаю…</div>;
  return (
    <>
      <div className="topbar"><span className="crumb">🗓️ Неделя</span></div>
      <div className="page wide">
        <div className="page-title" style={{ fontSize: 32 }}>Неделя</div>
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
function Course({ slug, s, open }: { slug: string; s: State; open: (id: string) => void }) {
  const [data, setData] = useState<any>(null);
  const [assume, setAssume] = useState<Record<string, number>>({});
  const [wi, setWi] = useState<{ final: number; passes: boolean } | null>(null);
  useEffect(() => { setData(null); setAssume({}); api<any>(`/api/course/${slug}`).then(setData); }, [slug, s]);
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
        <div className={`cover c-${g.color}`} style={{ margin: "-36px -56px 24px", height: 90, opacity: 0.35 }} />
        <div className="page-title">{g.title}</div>
        <div className="props">
          <div className="k">◎ Статус</div><div className="v"><Tag c={STATUS[g.status][0]}>{STATUS[g.status][1]}</Tag></div>
          <div className="k">Σ Сейчас</div><div className="v num"><b>{f2(g.earned)}</b>&nbsp;из 10 · потеряно {f2(g.lost)} · максимум {f2(g.maxReachable)}{g.bonusLeft > 0 ? ` (+${f2(g.bonusLeft)} бонус)` : ""}</div>
          <div className="k">⚑ Порог</div><div className="v num">{g.threshold} · нужно {Number.isFinite(g.neededShare) ? Math.round(g.neededShare * 100) : "∞"}% от оставшихся баллов</div>
          <div className="k">≈ Округление</div><div className="v">{g.rounding ?? <span className="muted">не указано в силлабусе</span>}</div>
          <div className="k">✦ Политика ИИ</div><div className="v"><Tag c={AI[g.aiMode]?.[0]}>{AI[g.aiMode]?.[1]}</Tag></div>
          <div className="k">🔗 Ссылки</div><div className="v">
            <a className="btn outline" href={`https://my.centraluniversity.ru/learn/courses/view/actual/${g.id}`} target="_blank" rel="noreferrer">LMS ↗</a>
            {g.syllabusUrl && <a className="btn outline" href={g.syllabusUrl.replace("note.cu.ru", "cuhandlog.ru")} target="_blank" rel="noreferrer">Силлабус ↗</a>}
            {g.timeUrl && <a className="btn outline" href={g.timeUrl} target="_blank" rel="noreferrer">TiMe ↗</a>}
          </div>
        </div>
        <Progress g={g} />

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
          <thead><tr><th>Активность</th><th>Вес</th><th>Сдано</th><th>Набрано</th><th>Потеряно</th><th>1 работа</th><th>Что если остальное на…</th></tr></thead>
          <tbody>
            {g.activities.map((a) => (
              <tr key={a.key}>
                <td>{a.name}{a.lateDays && <> <Tag c="green">LD</Tag></>}</td>
                <td className="num">{a.weight}{Math.abs(a.weight - a.syllabusWeight) > 1e-6 && <span className="muted"> (с. {a.syllabusWeight})</span>}</td>
                <td className="num">{a.graded}/{a.planned}</td>
                <td className="num">{f2(a.earned)}</td>
                <td className="num">{a.lost > 0.005 ? f2(a.lost) : ""}</td>
                <td className="num">{f2(a.itemValue)}</td>
                <td>{a.planned > a.graded
                  ? <span style={{ display: "flex", alignItems: "center", gap: 8 }}><input type="range" min={0} max={10} step={0.5} value={assume[a.key] ?? 7} onChange={(e) => setAssume({ ...assume, [a.key]: Number(e.target.value) })} /><span className="num">{assume[a.key] ?? 7}</span></span>
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
          {data.themes.map((t: any) => <div className="row" key={t.id}><span className="title">{t.name}</span><span className="muted">{t.publish_date ? new Date(t.publish_date).toLocaleDateString("ru-RU") : ""}</span></div>)}
        </div>
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
