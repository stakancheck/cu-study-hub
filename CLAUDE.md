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
- `src/mcp/server.ts`, `src/web/`, `src/cli.ts`, `src/sync.ts` (синхронизация и напоминания)
- `rules/*.yaml` – правила курсов из силлабусов

## Правила

- LMS только читаем. Никаких POST в LMS (сдача, late days) из кода.
- Формула LMS: по активности `Σ(score+extraScore)/maxExercisesCount × weight`, шкала 10.
- `/deadlines` в LMS неполный: задачи без созданной карточки берём из `courses/:id/overview` (state `notCreated`).
- Проверка: `bun run typecheck`, `bun cu course`.
- Не используй длинное тире в текстах и коде.
