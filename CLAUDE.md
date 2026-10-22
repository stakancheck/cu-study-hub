# cu-study-hub

Локальный «учебный штаб» для LMS Центрального университета. Bun + TypeScript, SQLite (`bun:sqlite`),
React-доска через HTML-импорты Bun, MCP-сервер на `@modelcontextprotocol/sdk`.

## Структура

- `src/connectors/lms/` – сессия (Playwright persistent profile → cookies.json) и клиент `/api/micro-lms/*`
- `src/connectors/caldav.ts` – Яндекс CalDAV, развёртка повторяющихся событий через ical.js
- `src/core/engine.ts` – формула оценки, блокеры, work items, приоритет, late days, what-if
- `src/core/board.ts` – карточки и колонки (LMS-статус review/done важнее ручной колонки)
- `src/core/attendance.ts` – вердикт «идти на пару» по весам аудиторных активностей
- `src/core/planner.ts` – today / week / digest
- `src/core/workspace.ts` – рабочие папки задач для агента
- `src/core/materials.ts` – зеркало курса в ~/study/<курс>/_course (недели, вложения через `/content/download-link`, силлабус, repo)
- `src/core/setup.ts` – мастер первого запуска: вход в LMS из веба, выбор курсов, правила из весов LMS в `~/.cu-hub/rules`
- `src/core/agent.ts` – фоновый `claude -p` в папке задачи, открытие чата (claude://code/new, Terminal.app)
- `src/mcp/server.ts`, `src/web/`, `src/cli.ts`, `src/sync.ts` (синхронизация и напоминания)
- `rules/*.yaml` – правила курсов из силлабусов; `~/.cu-hub/rules/*.yaml` (от мастера) важнее при том же `lms_id`
- `.mcp.json` генерируется (`writeProjectMcp`), в git его нет

## Правила

- LMS только читаем. Никаких POST в LMS (сдача, late days) из кода.
- Формула LMS: по активности `Σ(score+extraScore)/maxExercisesCount × weight`, шкала 10.
- Имена файлов LMS приходят в NFD: в `download-link` передавай filename ровно как в API, иначе S3 вернёт 404.
- `/deadlines` в LMS неполный: задачи без созданной карточки берём из `courses/:id/overview` (state `notCreated`).
- Проверка: `bun run typecheck`, `bun cu course`. Мастер и всё, что пишет данные, проверяй начисто:
  `CU_HUB_DATA=<временная папка> CU_HUB_PORT=4399 bun cu serve`, чтобы не трогать `~/.cu-hub` и демон на 4321.
- Не используй длинное тире в текстах и коде.
