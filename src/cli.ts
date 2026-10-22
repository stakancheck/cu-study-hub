#!/usr/bin/env bun
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE, DATA_DIR, loadConfig, ROOT } from "./config";
import { interactiveLogin } from "./connectors/lms/session";
import { gradeAll } from "./core/engine";
import { digestMarkdown, today, week } from "./core/planner";
import { ruleBySlug } from "./core/rules";
import { findItem } from "./core/engine";
import { createWorkspace } from "./core/workspace";
import { syncAll } from "./sync";

const PLIST = join(homedir(), "Library/LaunchAgents/ru.cu.study-hub.plist");
const [cmd, ...args] = process.argv.slice(2);
const r2 = (n: number) => n.toFixed(2);

const HELP = `Учебный штаб ЦУ

  bun cu login              войти в LMS (откроется окно браузера)
  bun cu sync               синхронизировать LMS, календарь, силлабусы
  bun cu today              дайджест на сегодня
  bun cu week               план недели
  bun cu course [курс]      оценки по курсу (без аргумента: все)
  bun cu do <задача>        создать рабочую папку для агента
  bun cu serve              доска на localhost + фоновая синхронизация и напоминания
  bun cu calendars          показать календари CalDAV (для настройки)
  bun cu install            автозапуск демона через launchd
  bun cu uninstall          убрать автозапуск`;

switch (cmd) {
  case "login": {
    console.log("Открываю браузер. Войди в LMS, окно закроется само.");
    await interactiveLogin();
    console.log("Готово, сессия сохранена. Запускаю синхронизацию...");
    console.log(JSON.stringify(await syncAll(), null, 2));
    break;
  }
  case "sync": {
    const r = await syncAll();
    console.log(JSON.stringify(r, null, 2));
    if (r.errors.length) process.exitCode = 1;
    break;
  }
  case "today":
    console.log(digestMarkdown(today()));
    break;
  case "week": {
    const w = week();
    for (const d of w.days) {
      console.log(`\n## ${new Date(d.date).toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "short" })} · ${d.loadH.toFixed(1)} ч${d.overloaded ? " ⚠️" : ""}`);
      for (const c of d.classes) console.log(`  ${new Date(c.start).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })} [${c.verdict}] ${c.course ?? "?"} · ${c.title}`);
      for (const i of d.due) console.log(`  ⏰ ${i.course} · ${i.title} (+${r2(i.delta)}${i.blocker ? ", блокер" : ""})`);
      for (const s of d.suggestions) console.log(`  💡 ${s}`);
    }
    if (w.recoverable.length) {
      console.log("\n## Можно вернуть на дорешках");
      for (const i of w.recoverable.slice(0, 10)) console.log(`  ${i.course} · ${i.title} (+${r2(i.delta)})`);
    }
    break;
  }
  case "course": {
    const grades = gradeAll();
    const sel = args[0] ? grades.filter((g) => g.id === ruleBySlug(args.join(" "))?.lms_id) : grades;
    for (const g of sel) {
      console.log(`\n${g.title} [${g.status}]`);
      console.log(`  сейчас ${r2(g.earned)} · потеряно ${r2(g.lost)} · максимум ${r2(g.maxReachable)} · порог ${g.threshold} · нужно ${Math.round(g.neededShare * 100)}% остатка`);
      for (const a of g.activities) console.log(`  - ${a.name}: ${r2(a.earned)} (${a.graded}/${a.planned}, одна работа = ${r2(a.itemValue)})`);
      for (const b of g.blockers) console.log(`  ▸ ${b.label}: ${b.status} (${b.detail})`);
      for (const w of g.warnings) console.log(`  ! ${w}`);
    }
    break;
  }
  case "do": {
    const it = findItem(args.join(" "));
    if (!it) { console.error("Не нашёл задачу"); process.exit(1); }
    const res = await createWorkspace(it.id);
    console.log(`Папка: ${res.dir}\nРежим ИИ: ${res.aiMode}\n${res.cloneNotes.join("\n")}\n\ncd "${res.dir}" && claude`);
    break;
  }
  case "serve":
    await import("./web/server");
    break;
  case "calendars": {
    const { createDAVClient } = await import("tsdav");
    const cfg = loadConfig().caldav;
    if (!cfg) { console.error(`Добавь секцию caldav в ${CONFIG_FILE}`); process.exit(1); }
    const pw = Bun.spawnSync(["security", "find-generic-password", "-s", cfg.keychainService, "-a", cfg.username, "-w"]).stdout.toString().trim();
    const client = await createDAVClient({ serverUrl: cfg.url, credentials: { username: cfg.username, password: pw }, authMethod: "Basic", defaultAccountType: "caldav" });
    for (const c of await client.fetchCalendars()) console.log(`- ${c.displayName}  (${c.url})`);
    break;
  }
  case "install": {
    const plist = launchdPlist();
    mkdirSync(join(homedir(), "Library/LaunchAgents"), { recursive: true });
    writeFileSync(PLIST, plist);
    Bun.spawnSync(["launchctl", "unload", PLIST]);
    const r = Bun.spawnSync(["launchctl", "load", "-w", PLIST]);
    console.log(r.exitCode === 0 ? `Демон установлен: ${PLIST}\nДоска: http://localhost:${loadConfig().webPort}` : r.stderr.toString());
    break;
  }
  case "uninstall":
    if (existsSync(PLIST)) { Bun.spawnSync(["launchctl", "unload", PLIST]); unlinkSync(PLIST); }
    console.log("Автозапуск убран");
    break;
  default:
    console.log(HELP);
}

function launchdPlist() {
  const bun = process.execPath;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ru.cu.study-hub</string>
  <key>ProgramArguments</key><array><string>${bun}</string><string>${join(ROOT, "src/cli.ts")}</string><string>serve</string></array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(DATA_DIR, "daemon.log")}</string>
  <key>StandardErrorPath</key><string>${join(DATA_DIR, "daemon.log")}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string><key>CU_DAEMON</key><string>1</string></dict>
</dict></plist>`;
}
