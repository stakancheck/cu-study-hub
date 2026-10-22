# Учебный штаб ЦУ

Локальный инструмент поверх LMS Центрального университета, силлабусов и Яндекс Календаря:
канбан задач, расчёт оценки по формуле каждого курса, вердикты «идти на пару или нет»,
советы по late days и рабочие папки под задачи для Claude Code.

## Быстрый старт

```bash
bun install
bun cu login        # откроется окно Chromium: войди в LMS руками, окно закроется само
bun cu today        # дайджест в терминале
bun cu serve        # доска на http://localhost:4321
```

Автозапуск (демон: доска, синхронизация каждые 30 минут, напоминания, утренний дайджест):

```bash
bun cu install
```

## Команды

| Команда | Что делает |
|---|---|
| `bun cu login` | Вход в LMS в отдельном профиле браузера (`~/.cu-hub/browser-profile`). Пароль нигде не сохраняется |
| `bun cu sync` | LMS + календарь + проверка силлабусов на изменения |
| `bun cu today` / `week` | Дайджест дня / план недели |
| `bun cu course [курс]` | Баллы, блокеры, расхождения LMS и силлабуса |
| `bun cu do <задача>` | Рабочая папка `~/study/<курс>/<задача>` с BRIEF.md, MATERIALS.md, CLAUDE.md |
| `bun cu serve` | Веб-доска и фоновые задачи |
| `bun cu calendars` | Список календарей CalDAV |

## Claude Code

В проекте лежит `.mcp.json` с MCP-сервером `cu-hub` и команды:
`/today`, `/week`, `/course <курс>`, `/do <задача>`, `/defend`, `/after <что было на паре>`.

Каждая рабочая папка задачи тоже содержит `.mcp.json`, `/do` и `/defend`, поэтому `cd <папка> && claude`
сразу видит контекст. Чтобы `cu-hub` был доступен из любой папки:

```bash
claude mcp add --scope user cu-hub -- bun ~/Projects/cu-study-hub/src/mcp/server.ts
```

Инструменты MCP: `sync`, `today`, `week_plan`, `course_grades`, `grades_whatif`, `board_get`, `card_move`,
`card_add`, `card_note`, `classes`, `attendance_mark`, `late_days_advice`, `task_context`, `workspace_create`, `recoverable`.

## Календарь (Яндекс, CalDAV)

1. Создай пароль приложения: Яндекс ID → Безопасность → Пароли приложений → «Календарь CalDAV».
2. Положи его в Keychain (команда спросит пароль, в историю shell он не попадёт):

   ```bash
   security add-generic-password -s cu-hub-caldav -a <логин>@yandex.ru -w
   ```

3. Создай `~/.cu-hub/config.yaml`:

   ```yaml
   caldav:
     url: https://caldav.yandex.ru
     username: <логин>@yandex.ru
     keychainService: cu-hub-caldav
     calendars: []        # пусто = все; имена смотри через `bun cu calendars`
   ```

4. `bun cu sync`. События сопоставляются с курсами по `calendar.match` в `rules/*.yaml`.

## Правила курсов

`rules/<курс>.yaml`: веса и плановое число работ по силлабусу, блокеры, late days, политика ИИ,
шаблоны календаря и задачи подготовки. Движок считает оценку так же, как LMS:
по каждой активности `Σ баллов / плановое число работ × вес`. Если веса в LMS и силлабусе
расходятся, считается по LMS, а расхождение показывается на доске.

Режимы политики ИИ (`ai_policy.mode`) попадают в CLAUDE.md рабочей папки:

- `execute`: агент делает черновик и готовит конспект к защите;
- `assist`: работа вместе, с объяснением каждого шага;
- `tutor_only`: агент не пишет решение, только план, вопросы и проверка.

## Данные

Всё лежит в `~/.cu-hub/`: `hub.sqlite`, `cookies.json` (права 600), `browser-profile/`, `digest.md`, `daemon.log`.
Инструмент только читает LMS. Сдавать работы и переносить дедлайны на late days ты делаешь сам.

## Что дальше

- Облако: демон на VPS с headless-сессией, Telegram-бот для дайджеста и «был на паре?».
- TiMe: коннектор объявлений, если появится доступ.
