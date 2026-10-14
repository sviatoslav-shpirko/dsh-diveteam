# Выжимка по проекту «Фарватер» на базе DeepSeek Harness (`dsh`) — Handover для нового чата

> **Назначение документа:** Полный контекст для продолжения разработки в новом чате в рабочей директории `/home/slava/Projects/DSH/`.
> **Связанные документы в этой же папке:**
> - [ARCHITECTURE.md](file:///home/slava/Projects/DSH/ARCHITECTURE.md) — полная целевая архитектура системы.
> - [IMPLEMENTATION_PLAN.md](file:///home/slava/Projects/DSH/IMPLEMENTATION_PLAN.md) — пошаговый план построения из 8 фич с описанием работы каждой фичи.

---

## 1. Краткая суть проекта и главные архитектурные решения

После неудачного опыта с **Hermes AI** (огромный промпт-блоат, жёсткая дрессировка моделей и навязчивый ревьюер памяти каждые несколько сообщений) и **Paperclip AI** (корпоративный оверхед: 500 000+ токенов и создание подзадач на простой вопрос «Привет, работаешь?») проектируется собственная автономная мульти-агентная система **«Фарватер»** на базе **[DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness)**.

### Ключевые принципы, утверждённые владельцем (`@slava`):
1. **Двухэтапная стратегия (Local-First $\to$ Bundle $\to$ `farvater`):**
   - Сначала вся система собирается, отлаживается и проходит приёмку по 5 контрольным сценариям (**Golden Tasks**) локально на ноутбуке **`p1-arch`** (Arch Linux).
   - Затем готовая рабочая «сборка» упаковывается и переносится на выделенный сервер **Raspberry Pi 5 (`farvater`, `192.168.0.55`, 8 ГБ RAM, Debian 13 Trixie)**.
2. **Два строго разделённых режима в веб-панели (`dsh web`):**
   - **Режим 1 (Окно прямого чата):** тонкий вызов выбранной модели из пулов **OpenCode Go** и **Google AI Studio (Gemini)** с нулевым промпт-оверхедом (`Model-visible ⟺ logged`) и прозрачным счётчиком токенов/квот (`dsh-cost-meter`).
   - **Режим 2 (Командный Канбан-оркестратор):** 6 ролей агентов вокруг доски задач (`@linxin666/dsh-client-ui-task-board` с выключенным скрытым судьёй `goalVerification: false` + наш серверный плагин `@farvater/dsh-dispatcher`).
3. **Шесть ролей агентов (`roles/*.md` $\to$ `@deepseek-ai/dsh-agent-preset`):**
   - `shturman` (Штурман) — дефолтный агент в Web и единственная роль, привязанная к живому диалогу в Telegram. Работает последовательно на универсальной Pro-модели (`opencode-go/glm-5.1`). Ищет контекст через `graphify query`. Простые задачи планирует и раздаёт сам; сложные ($>2$ репо/сервисов, новая архитектура, эскалации или по прямой команде) передаёт на `arch`.
   - `arch` (Архитектор) — работает последовательно на топовой модели (`gpt-6-astra` / `glm-5.1`). Задаёт уточняющие вопросы через статус `Clarify (@slava)` с пингом в Telegram, пишет план и бьёт задачу на подзадачи с зависимостями (`dependsOn`), разруливает эскалации.
   - `dev` (Разработчик) — работает параллельно (в квоте тяжёлых воркеров) строго в изолированном `git worktree` задачи. Имеет доступ к вызову `opencode` CLI и `agy` CLI. Если нужен системный тул или скилл — запрашивает подзадачу у `sre`.
   - `qa` (Тестировщик / Ревьюер) — заходит в **тот же самый `git worktree`** после `dev`, гоняет тесты и выносит вердикт (`farvater_qa_verdict`: `pass` $\to$ `merge.lock` $\to$ `Done`, либо `fail` $\to$ возврат на `dev`; после 2 неудач подряд — авто-эскалация на `arch`).
   - `sre` (Инфра / Хост / Ansible / n8n) — работает с эксклюзивным локом хоста (`host.lock`). Имеет доступ к `opencode` CLI и `sudo agy --dangerously-skip-permissions`. Ставит пакеты/скиллы по запросу агентов, правит и проверяет Ansible (`--check`), чинит упавшие детерминированные автоматизации в `n8n` (Docker). Перед деплоем на прод или удалением данных обязан запросить аппрув через `farvater_request_approval` (статус `Clarify @slava` + пинг в Telegram).
   - `reg` (Регистратор / Архивариус) — работает на дешёвой Flash-модели (`google/gemini-2.5-flash`) по событию перехода задачи в `Done` или по команде. Читает авто-экспортированный отчёт `vault/tasks/done/TASK-<id>.md`, пишет технический урок в `vault/memory/lessons/`, наводит порядок в `vault/notes/`, делает `git commit` в `vault/` и запускает `graphify --update`. **Никогда не правит `CORE.md` напрямую** — только формирует дифф в `vault/memory/proposals/CORE-diff-<id>.md` (`farvater_propose_core_diff`) на решение `@slava` (применить самому или поручить `shturman`).
4. **Конкурентность и 3 режима изоляции + `merge.lock`:**
   - Семафор **`maxHeavyWorkers = 3`** ограничивает только тяжёлые роли (`dev`, `qa`, `sre`). Лёгкие сессии (`shturman`, `arch`, `reg`) работают вне квоты без ожидания.
   - Режимы изоляции: `git_worktree` (с последовательной очередью слияния `merge.lock` в `main`), `host_exclusive` (`/tmp/farvater-host.lock`), `notes_vault` (Git-репозиторий `vault/`).
5. **Глобальный Стоп-Кран и безопасность плагинов:**
   - При превышении дневного лимита токенов (`maxDailyTokens`) все активные агенты останавливаются (`interrupt()`), очередь ставится на паузу, в Telegram уходит алерт.
   - Все сторонние плагины проходят обязательный аудит кода: отключены `openviking` и `aegis`, из всех пакетов `@linxin666/*` вырезана телеметрия `reportDailyHeartbeat` (`https://dsh-market.com/api/telemetry/event`).

---

## 2. Важные переменные, секреты, SSH-ключи и реквизиты

### 2.1. SSH-ключи и подключение к боевому хосту `farvater` (RP5)
- **Хост:** `farvater` / `farvater.local` / `farvater.lan`
- **IPv4-адрес в LAN:** `192.168.0.55` (шлюз `192.168.0.1`)
- **Пользователь:** `slava` (беспарольный `sudo`, кроме запрета на форматирование `/dev/mmcblk0` в `/etc/sudoers.d/010_pi-nopasswd`; `/boot/firmware` защищён через `ReadOnlyPaths`)
- **Конфигурация SSH на локальной машине (`/home/slava/.ssh/config`):**
  ```sshconfig
  Host farvater farvater.local 192.168.0.55
      HostName 192.168.0.55
      User slava
      IdentityFile ~/.ssh/id_ed25519
      IdentityFile ~/.ssh/slava_key
      StrictHostKeyChecking accept-new

  Host github.com
      HostName github.com
      User git
      IdentityFile ~/.ssh/slava_key
      IdentitiesOnly yes
      AddKeysToAgent yes
  ```
- **Быстрая проверка подключения:** `ssh farvater` (использует ключи `~/.ssh/id_ed25519` и `~/.ssh/slava_key`).

### 2.2. Переменные окружения и API-ключи
| Переменная | Назначение | Важные особенности и ограничения |
|---|---|---|
| `OPENCODE_GO_API_KEY` | Ключ подписки OpenCode Go (`https://opencode.ai/zen/go/v1`) | Основной ключ для `@deepseek-ai/dsh-llm-pi-ai` (`opencode-go`) |
| `OPENCODE_ZEN_API_KEY` | Дополнительный ключ OpenCode Zen | Используется наравне с `OPENCODE_GO_API_KEY` |
| ⛔ `OPENCODE_API_KEY` | **НЕ ИСПОЛЬЗОВАТЬ!** | На `farvater` запрещена (не входит в блоклист окружения и может утечь в дампы снапшотов). Использовать только `OPENCODE_GO_API_KEY`! |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Ключ Google AI Studio (Gemini Flash / Pro) | Используется для провайдера `google` в `dsh-llm-pi-ai` и для `graphify --update` |
| `FARVATER_TG_BOT_TOKEN` | Токен Telegram-бота | На `farvater`: `8569629510:AAEMPNCt_76p5pAp0SptSZa0FpNvh0c009k` (Bot ID: `8569629510`) |
| `FARVATER_TG_CHAT_ID` | Разрешённый ID чата / пользователя (`@slava`) | `81815557` (Святослав). Бот принимает команды и сообщения строго от этого ID |

### 2.3. Как хранятся секреты на `farvater` (`systemd-creds` + RAM `/dev/shm`)
На Raspberry Pi 5 (`192.168.0.55`) действует правило **Zero-Plaintext-on-Disk**:
- Зашифрованные блобы лежат в `/etc/credstore.encrypted/*.cred` (`0600 root:root`), привязанные к `/var/lib/systemd/credential.secret`:
  - `/etc/credstore.encrypted/OPENCODE_GO_API_KEY.cred`
  - `/etc/credstore.encrypted/GEMINI_API_KEY.cred`
  - `/etc/credstore.encrypted/VERTEX_SA.json.cred`
  - `/etc/credstore.encrypted/HERMES_DASHBOARD_PASSWORD.cred`
- При загрузке они расшифровываются **только в оперативную память (`tmpfs`)** в каталог `/dev/shm/hermes-creds/` (`0700 slava:slava`, включён `loginctl enable-linger slava`).
- При деплое `dsh` на `farvater` его `systemd`-юнит должен точно так же подхватывать переменные окружения из `/dev/shm/hermes-creds/` (или через `LoadCredentialEncrypted=`), не записывая открытые ключи на SD-карту.

---

## 3. Важные пути и симлинки (на локальной машине `p1-arch` и на `farvater`)

### 3.1. На локальной рабочей машине (`p1-arch`)
1. **Бинарник `dsh`:**
   - `/home/slava/.local/bin/dsh` — bash-обёртка:
     ```bash
     #!/usr/bin/env bash
     exec pnpm --dir /home/slava/Projects/DeepSeek-Harness --silent dsh "$@"
     ```
2. **Исходники самого DeepSeek Harness:**
   - `/home/slava/Projects/DeepSeek-Harness`
3. **Рабочий профиль `deskweb`:**
   - `/home/slava/.dsh/profiles/deskweb/`
   - Конфиг патчей: `/home/slava/.dsh/profiles/deskweb/cordis.patch.yml`
   - Манифест плагинов: `/home/slava/.dsh/profiles/deskweb/package.json`
   - Хранилище карточек Канбана (`ledger-v2.json`): `/home/slava/.dsh/storages/task-board/ledger-v2.json` (или внутри профиля).
4. **Симлинки для плагина `@farvater/dsh-dispatcher` и зависимостей `@deepseek-ai/*`:**
   - В предыдущем чате черновик кода создавался в `/home/slava/Projects/Hermes_N8N_rp5/`.
   - Были созданы следующие симлинки (при переносе разработки в `/home/slava/Projects/DSH/` их нужно переключить на `/home/slava/Projects/DSH/`):
     - `/home/slava/.dsh/profiles/deskweb/node_modules/@farvater/dsh-dispatcher` $\to$ указывает на пакет `packages/dsh-dispatcher` проекта (плюс путь `file:...` в `/home/slava/.dsh/profiles/deskweb/package.json`).
     - Для запуска `node --test` вне `dsh` в `node_modules/@deepseek-ai/` проекта создаются 2 симлинка на внутренние пакеты `DeepSeek-Harness`:
       - `node_modules/@deepseek-ai/dsh-tools` $\to$ `/home/slava/Projects/DeepSeek-Harness/packages/core/tools`
       - `node_modules/@deepseek-ai/schemastery` $\to$ `/home/slava/Projects/DeepSeek-Harness/packages/core/tools/node_modules/@deepseek-ai/schemastery`

### 3.2. На боевом сервере `farvater` (`192.168.0.55`)
1. **Antigravity CLI (`agy`):**
   - Установлен в `/home/slava/.local/bin/agy`.
   - **Симлинк для `sudo` (`secure_path`):** `/usr/local/bin/agy -> /home/slava/.local/bin/agy`.
   - В `/home/slava/.bashrc`: `alias agy='sudo agy --dangerously-skip-permissions'`.
2. **Стек `n8n` + `PostgreSQL 16` + `AdGuard Home`:**
   - Директория: `/home/slava/n8n-stack/` (`docker-compose.yml`, кастомный `Dockerfile` `farvater/n8n-custom:latest`).
   - Утилита управления: `/usr/local/bin/n8n-ctl` (`add-npm`, `add-apk`, `rebuild`, `restart`, `logs`, `status`).
   - Утилита бэкапа: `/usr/local/bin/backup-farvater` (сохраняет архивы в `/home/slava/backups/`).
   - Общая папка обмена между хостом и контейнером `n8n`: `/home/slava/shared` (внутри контейнера `n8n` примонтирована как `/data/shared`).
3. **Симлинки секретов в RAM (`tmpfs`):**
   - `/home/slava/.hermes/profiles/farvater-agent/.env -> /dev/shm/hermes-creds/farvater-agent.env`
   - `/etc/hermes/.env -> /dev/shm/hermes-creds/managed.env`

---

## 4. Что уже было сделано в `/home/slava/Projects/Hermes_N8N_rp5/` и с чего начать в `/home/slava/Projects/DSH/`

### Что уже сделано в профиле `/home/slava/.dsh/profiles/deskweb/`:
1. Удалены `@openviking/dsh-memory-plugin`, `aegis` и дублирующий `@linxin666/dsh-web-all`. *(Папка `/home/slava/.openviking` на диске не удалялась — при необходимости спросить пользователя).*
2. Во всех 22 файлах плагинов `@linxin666/*` в `/home/slava/.dsh/profiles/deskweb/node_modules/@linxin666/` обезврежена телеметрия `reportDailyHeartbeat` (`https://dsh-market.com/api/telemetry/event` заменена на `return;`).
3. В `/home/slava/.dsh/profiles/deskweb/cordis.patch.yml` прописаны нативные роуты `opencode-go` и `google` (`@deepseek-ai/dsh-llm-pi-ai`), включён `ui-task-board` (`goalVerification: false`, `announceToAgent: false`, `maxSubtaskDepth: 3`) и дефолтный пресет `shturman`.

### Черновые наработки в `/home/slava/Projects/Hermes_N8N_rp5/` (можно перенести в `/home/slava/Projects/DSH/` и довести до ума по плану):
- `roles/{shturman,arch,dev,qa,sre,reg}.md` — стартовые файлы 6 ролей.
- `vault/` — стартовая структура (`memory/CORE.md`, `memory/lessons/`, `memory/proposals/`, `notes/`, `inbox/`, `tasks/done/`).
- `packages/dsh-dispatcher/` — первая версия серверного плагина-диспетчера (`lib/index.js`, `lib/worktree.js`, `lib/roles.js`, `lib/telegram.js`, `test/dispatcher.test.mjs`).
- `scripts/sync-roles.mjs` и `scripts/bundle-for-farvater.sh`.

### Что нужно сделать дальше в новом чате (строго по [IMPLEMENTATION_PLAN.md](file:///home/slava/Projects/DSH/IMPLEMENTATION_PLAN.md)):
1. Перенести (или пересоздать начисто) `roles/`, `vault/`, `packages/dsh-dispatcher/` и `scripts/` в `/home/slava/Projects/DSH/` и переключить симлинк `/home/slava/.dsh/profiles/deskweb/node_modules/@farvater/dsh-dispatcher` на `/home/slava/Projects/DSH/packages/dsh-dispatcher`.
2. **Фича 1:** Настроить `dsh-gateway` (`gateway.users` / `hosts`) и проверить вживую окно прямого чата с моделями OpenCode Go и Gemini.
3. **Фича 2:** Инициализировать `vault/` как Git-репозиторий и собрать первичный граф знаний `graphify` (`vault/graphify-out/graph.json`).
4. **Фича 3:** Усилить промпты 6 ролей в `roles/*.md` (чёткие инструкции вызова `opencode` и `agy` CLI, запрос тулов/скиллов к `sre`, работа с `graphify query`).
5. **Фичи 4–5:** Доработать `@farvater/dsh-dispatcher`:
   - добавить проверку зависимостей `dependsOn` между подзадачами в `processQueue()`;
   - добавить наглядные теги/бейджи фаз (`Clarify @slava`, `QA Review`, `Merge Lock`) на карточки Канбана.
6. **Фича 6:** Проверить и докрутить сценарии `sre` (запрос от `dev` на установку скилла/тула, цикл `Ansible --check -> farvater_request_approval -> deploy`, починка `n8n`).
7. **Фича 7:** Доработать Telegram-мост (`lib/telegram.js`): подключить живой диалог входящих сообщений напрямую к сессии `shturman` с ответом обратно в Telegram, добавить команду `/status`, а в `reg` добавить авто-коммит в Git-репозиторий `vault/` и вызов `graphify --update`.
8. **Фича 8:** Прогнать вживую 5 контрольных сценариев (**Golden Tasks**) на локальной машине и упаковать финальную сборку для деплоя на `farvater` (`192.168.0.55`).
