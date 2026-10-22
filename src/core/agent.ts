import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../config";
import { getDb } from "./db";
import { notifyOnce } from "./notify";
import { createWorkspace } from "./workspace";
import { workItems } from "./engine";

/** Tools the background agent may use without a prompt: files, the hub MCP, and typical build/run commands. */
const DEFAULT_TOOLS = [
  "Read", "Glob", "Grep", "Write", "Edit", "MultiEdit", "TodoWrite", "mcp__cu-hub",
  "Bash(ls:*)", "Bash(cat:*)", "Bash(mkdir:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)",
  "Bash(java:*)", "Bash(javac:*)", "Bash(mvn:*)", "Bash(./mvnw:*)", "Bash(gradle:*)", "Bash(./gradlew:*)",
  "Bash(python3:*)", "Bash(pip:*)", "Bash(node:*)", "Bash(bun:*)",
];

export function claudeBin(): string {
  const cfg = loadConfig().agent?.claudeBin;
  if (cfg && existsSync(cfg)) return cfg;
  const candidates = [join(homedir(), ".local/bin/claude"), join(homedir(), ".claude/local/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
  const found = candidates.find((p) => existsSync(p)) ?? Bun.which("claude");
  if (!found) throw new Error("Не нашёл claude CLI: укажи agent.claudeBin в ~/.cu-hub/config.yaml");
  return found;
}

const draftPrompt = (t: string) => `Задача «${t}». Прочитай CLAUDE.md, BRIEF.md, MATERIALS.md и ../COURSE_NOTES.md (если есть); если задание опирается на прошлые темы, загляни в ../_course (оглавление ../_course/README.md, вложения в ../_course/attachments, PDF читай инструментом Read) и в ../HISTORY.md как образец формата.
Сделай готовую работу в этой папке в том формате, который требует задание: код в файлах проекта, текст в DRAFT.md, материалы для презентации и т.д.
Рядом напиши EXPLAIN.md (что сделано в каждой части и почему так) и DEFENSE.md (7-10 вероятных вопросов на защите с короткими ответами и ссылками на места в работе).
В конце коротко перечисли созданные файлы, что студенту проверить перед сдачей и что непонятно в условии.`;

export interface AgentRun {
  id: string; card_id: string; dir: string; pid: number | null; mode: string; status: "running" | "done" | "failed";
  started_at: string; finished_at: string | null; session_id: string | null; summary: string | null; cost_usd: number | null;
}

const alive = (pid: number | null) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

export function latestRun(cardId: string): AgentRun | null {
  refreshRuns();
  return getDb().query("SELECT * FROM agent_runs WHERE card_id = ? ORDER BY started_at DESC LIMIT 1").get(cardId) as AgentRun | null;
}

/** Starts `claude -p` in the task folder, detached from the hub so a daemon restart does not kill it. */
export async function startDraft(cardId: string): Promise<AgentRun> {
  const prev = latestRun(cardId);
  if (prev?.status === "running") return prev;
  const it = workItems().find((i) => i.id === cardId);
  if (!it) throw new Error("Черновик можно сделать только для задачи из LMS");
  const ws = await createWorkspace(cardId);
  const mode = "draft";
  const out = join(ws.dir, ".cu-agent");
  mkdirSync(out, { recursive: true });
  const cfg = loadConfig().agent ?? {};
  const args = [
    claudeBin(), "-p", draftPrompt(it.title),
    "--output-format", "json",
    "--permission-mode", "acceptEdits",
    "--max-turns", String(cfg.maxTurns ?? 60),
    "--add-dir", dirname(ws.courseDir),
    "--add-dir", join(loadConfig().workspaceRoot, "_templates"),
    "--allowedTools", (cfg.allowedTools ?? DEFAULT_TOOLS).join(" "),
  ];
  // sh backgrounds the process and prints its pid; the agent is reparented to launchd and outlives the hub.
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const cmd = `cd ${q(ws.dir)} && nohup ${args.map(q).join(" ")} > .cu-agent/result.json 2> .cu-agent/stderr.log < /dev/null & echo $!`;
  const r = Bun.spawnSync(["/bin/sh", "-c", cmd], { env: { ...process.env, PATH: `${join(homedir(), ".local/bin")}:${join(homedir(), ".bun/bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` } });
  const pid = Number(r.stdout.toString().trim()) || null;
  const run: AgentRun = {
    id: crypto.randomUUID().slice(0, 8), card_id: cardId, dir: ws.dir, pid, mode, status: "running",
    started_at: new Date().toISOString(), finished_at: null, session_id: null, summary: null, cost_usd: null,
  };
  getDb().query(`INSERT INTO agent_runs(id, card_id, dir, pid, mode, status, started_at) VALUES(?,?,?,?,?,?,?)`)
    .run(run.id, run.card_id, run.dir, run.pid, run.mode, run.status, run.started_at);
  return run;
}

/** Marks finished runs from their result.json and notifies once. */
export function refreshRuns() {
  const db = getDb();
  const running = db.query("SELECT * FROM agent_runs WHERE status = 'running'").all() as AgentRun[];
  for (const r of running) {
    if (alive(r.pid)) continue;
    const file = join(r.dir, ".cu-agent/result.json");
    let status: AgentRun["status"] = "failed";
    let summary = "Агент завершился без результата: смотри .cu-agent/stderr.log";
    let session: string | null = null;
    let cost: number | null = null;
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      session = j.session_id ?? null;
      cost = j.total_cost_usd ?? null;
      summary = String(j.result ?? summary);
      status = j.is_error ? "failed" : "done";
    } catch {
      const err = existsSync(join(r.dir, ".cu-agent/stderr.log")) ? readFileSync(join(r.dir, ".cu-agent/stderr.log"), "utf8").trim().slice(-400) : "";
      if (err) summary = err;
    }
    db.query("UPDATE agent_runs SET status=?, finished_at=?, session_id=?, summary=?, cost_usd=? WHERE id=?")
      .run(status, new Date().toISOString(), session, summary, cost, r.id);
    const title = r.dir.split("/").pop();
    notifyOnce(`agent:${r.id}`, status === "done" ? "Черновик готов" : "Агент не справился", `${title}: ${summary.slice(0, 120)}`, { sound: true });
  }
}

export type ChatTarget = "app" | "terminal";

/** Opens a chat in the folder: Claude desktop (Code tab) via deep link, or Terminal.app with claude. */
export function openChat(dir: string, target: ChatTarget, opts: { prompt?: string; resume?: string | null } = {}) {
  if (!existsSync(dir)) throw new Error(`Папки нет: ${dir}`);
  if (target === "app") {
    const p = new URLSearchParams();
    p.set("folder", dir);
    if (opts.prompt) p.set("q", opts.prompt);
    const r = Bun.spawnSync(["open", `claude://code/new?${p.toString().replace(/\+/g, "%20")}`]);
    if (r.exitCode !== 0) throw new Error("Не удалось открыть приложение Claude");
    return;
  }
  const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const claudeCmd = opts.resume ? `${sh(claudeBin())} --resume ${sh(opts.resume)}` : sh(claudeBin());
  const line = `cd ${sh(dir)} && ${claudeCmd}`;
  const script = `tell application "Terminal"
  activate
  do script "${line.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"
end tell`;
  const r = Bun.spawnSync(["osascript", "-e", script]);
  if (r.exitCode !== 0) throw new Error(`Terminal: ${r.stderr.toString().trim()}`);
}
