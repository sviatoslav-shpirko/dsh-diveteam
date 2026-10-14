---
name: agy
description: 'Делегирование автономного кодинга, рефакторинга, архитектурного планирования, код-ревью и системной SRE-диагностики в Google Antigravity CLI (agy) через безопасный адаптер dsh-agy (/home/slava/.local/bin/dsh-agy).'
whenToUse: 'Используй, когда пользователь в чате просит вызвать agy (/agy), проверить модели/статус agy, либо когда агенту роли (dev, sre, qa, arch, shturman, reg) нужно делегировать объёмную разработку, рефакторинг, аудит или привилегированную диагностику хоста.'
user-invocable: true
---

# Скилл `agy` — Вызов Google Antigravity CLI через адаптер `dsh-agy`

В системе «DiveTeam» на базе DeepSeek Harness (`dsh`) вызов внешнего агента **Google Antigravity CLI (`agy`)** выполняется **строго через скрипт-обвязку `dsh-agy`** (`/home/slava/.local/bin/dsh-agy` $\to$ `/home/slava/Projects/DSH/scripts/dsh-agy`), а не сырыми вызовами `agy` в shell.

## 1. Почему обязательно использовать `dsh-agy` вместо сырого `agy`
1. **Санитизация окружения безопасности «DiveTeam»:** автоматически удаляет запрещённую переменную `OPENCODE_API_KEY` из окружения дочернего процесса и гарантирует наличие `~/.local/bin` и `/usr/local/bin` в `PATH`.
2. **Контроль `git worktree` и диффа:** автоматически определяет рабочую директорию (`--workdir`, `DIVETEAM_WORKTREE`, `FARVATER_WORKTREE`, `DSH_WORKTREE` или `cwd`), снимает слепок `git status` до и после запуска и возвращает точный список изменённых файлов (`files_changed`) и `git_diff_stat`.
3. **Структурированный JSON-контракт:** вызывает `agy -p "<prompt>" --output-format json` с контролем таймаута (`--print-timeout`), перехватывает ошибки и возвращает чистый JSON с `conversation_id`, `status`, `response`, `usage`, `duration_seconds` и метаданными роли (`role`, `task_id`).
4. **Поддержка `sudo` для роли `sre`:** флаг `--sudo` безопасно запускает `sudo -n /path/to/agy --dangerously-skip-permissions` при работе под эксклюзивным локом хоста (`host.lock`).

---

## 2. Использование из прямого чата `dsh` (по запросу пользователя или `/agy`)

Когда пользователь в чате пишет `/agy ...` или просит проверить статус/модели `agy` либо выполнить задачу через Antigravity CLI:

### 2.1. Проверка статуса и доступных моделей
```bash
# Проверить версию agy, доступность беспарольного sudo, текущий git-репозиторий и число сессий:
dsh-agy status

# Человекочитаемый статус:
dsh-agy status --human

# Получить актуальный список моделей Antigravity CLI (Gemini 3.8/3.7/3.1, Claude Sonnet/Opus 4.6, GPT-OSS):
dsh-agy models
```

### 2.2. Делегирование задачи из чата
```bash
# Выполнить задачу в указанной директории с человекочитаемым отчётом:
dsh-agy run --workdir /home/slava/Projects/DSH --human "Проанализируй структуру проекта и предложи улучшения"

# Выполнить задачу в режиме планирования (без модификации файлов):
dsh-agy run --workdir /home/slava/Projects/DSH --mode plan --effort high "Составь пошаговый план рефакторинга модуля X"

# Выбрать конкретную модель (например, claude-sonnet-4-6 или gemini-3.1-pro-high):
dsh-agy run --workdir /path/to/repo --model claude-sonnet-4-6 "Реализуй фичу Y и напиши тесты"

# Продолжить предыдущую сессию agy по UUID или последнюю:
dsh-agy run --conversation <UUID> "Доработай обработку ошибок"
dsh-agy run --continue-last "Запусти тесты и исправь ворнинги"
```

---

## 3. Регламент вызова `dsh-agy` для 6 ролей «DiveTeam»

### 💻 3.1. Роль `dev` (Разработчик — изоляция `git_worktree`)
Агент `dev` работает внутри выделенного `git worktree` задачи (`{{cwd}}`). Для объёмного кодинга, написания новых модулей, сложного рефакторинга или генерации тестов вызывай `dsh-agy`:
```bash
# Базовый вызов внутри текущего git worktree задачи:
dsh-agy run --workdir . --role dev --effort high "Реализуй модуль X согласно ТЗ, добавь unit-тесты и проверь их прохождение"

# Передача длинного ТЗ через временный файл (чтобы избежать проблем с экранированием кавычек в bash):
cat << 'EOF' > /tmp/agy-task.md
Подробное техническое задание...
EOF
dsh-agy run --workdir . --role dev --task-file /tmp/agy-task.md
```
> **Важно для `dev`:** НИКОГДА не используй `--sudo`. После завершения `dsh-agy run` проверь поле `files_changed` и `git_diff_stat` в JSON-ответе и убедись, что тесты проходят.

### 🛠️ 3.2. Роль `sre` (Инфраструктура / Хост / Ansible / n8n — изоляция `host_exclusive`)
Агент `sre` работает под защитой `/tmp/diveteam-host.lock` и имеет право запускать `dsh-agy` как в обычном режиме, так и с привилегиями `root` (`--sudo`):
```bash
# Системная диагностика, установка пакетов/скиллов или отладка контейнеров с правами root:
dsh-agy run --sudo --role sre --workdir /home/slava/n8n-stack "Проверь логи контейнера n8n, найди причину падения воркфлоу и подготовь исправление"

# Аудит и подготовка изменений в плейбуках Ansible (режим планирования/проверки):
dsh-agy run --role sre --workdir /etc/ansible --mode plan "Проверь роли Ansible и предложи изменения для сервиса X"
```
> **Важно для `sre`:** Перед любым боевым деплоем в прод, перезапуском критичных контейнеров БД или удалением данных сначала используй `--mode plan` или `--check`, а затем вызови `diveteam_request_approval`.

### 🧪 3.3. Роль `qa` (Тестировщик / Ревьюер — тот же `git_worktree`)
Агент `qa` может использовать `dsh-agy` в режиме `--mode plan` для глубокого независимого код-ревью и поиска скрытых багов/уязвимостей в диффе ветки задачи:
```bash
dsh-agy run --workdir . --role qa --mode plan --effort high "Проведи код-ревью изменений git diff main...HEAD, проверь граничные случаи и безопасность"
```
> **Важно для `qa`:** Используй `--mode plan`, чтобы `qa` не переписывал код молча за `dev`. По итогам проверки вынеси вердикт через `diveteam_qa_verdict`.

### 🧭 3.4. Роли `shturman` и `arch` (Планирование и архитектурный аудит)
Чтобы не засорять собственное окно контекста чтением десятков исходных файлов (правило защиты от промпт-блоата на 100k+ токенов), `shturman` и `arch` могут делегировать разведку кодовой базы в `dsh-agy --mode plan`:
```bash
dsh-agy run --workdir /path/to/repo --role arch --mode plan --effort high "Изучи архитектуру репозитория и верни краткую сводку затрагиваемых файлов и интерфейсов для задачи X"
```

---

## 4. Справочник аргументов `dsh-agy`

```text
dsh-agy status [--human]
dsh-agy models [--human]
dsh-agy agents [--human]
dsh-agy run [ОПЦИИ] "<текст задачи>"
```

| Флаг | Описание |
|---|---|
| `task` (позиционный) | Текст промпта/задачи для `agy` (или `-` для чтения из `stdin`) |
| `--task-file`, `-f <path>` | Прочитать промпт задачи из файла (рекомендуется для многострочных ТЗ) |
| `--workdir`, `-w <dir>` | Рабочая папка (по умолчанию: `$DIVETEAM_WORKTREE` $\to$ `$FARVATER_WORKTREE` $\to$ `$DSH_WORKTREE` $\to$ `cwd`) |
| `--mode <accept-edits\|plan>` | Режим работы: `accept-edits` (внесение правок) или `plan` (только анализ/ревью без правок) |
| `--effort`, `-e <level>` | Уровень рассуждений: `low`, `medium`, `high` (по умолчанию), `xhigh`, `max` |
| `--model`, `-m <name>` | Явный выбор модели из `dsh-agy models` (напр. `gemini-3.8-flash-high`, `claude-sonnet-4-6`) |
| `--sudo` | Запуск через `sudo -n agy --dangerously-skip-permissions` (только для роли `sre`) |
| `--no-autonomous` | Отключить авто-подтверждение тулов (`--dangerously-skip-permissions` включён по умолчанию) |
| `--conversation`, `-c <id>` | Продолжить существующий диалог `agy` по `conversation_id` |
| `--continue-last` | Продолжить последнюю сессию `agy` (`--continue`) |
| `--add-dir <dir>` | Добавить дополнительную папку в workspace (можно указывать несколько раз) |
| `--timeout`, `-t <sec>` | Таймаут выполнения в секундах (по умолчанию `300`) |
| `--role <role>` | Метка роли «DiveTeam» (`shturman`, `arch`, `dev`, `qa`, `sre`, `reg`) |
| `--task-id <id>` | ID карточки задачи для логирования в JSON-ответе |
| `--human` | Вывести читаемый текстовый отчёт вместо JSON |

## 5. Формат JSON-ответа `dsh-agy run`
```json
{
  "ok": true,
  "status": "SUCCESS",
  "conversation_id": "uuid-сессии",
  "response": "Итоговый ответ агента agy...",
  "duration_seconds": 18.4,
  "num_turns": 4,
  "usage": {},
  "role": "dev",
  "task_id": "t-6a89631d",
  "sudo": false,
  "workdir": "/home/slava/Projects/DSH/worktrees/repo/task-6a89631d",
  "is_git_repo": true,
  "git_branch": "task/6a89631d",
  "files_changed": ["src/index.js", "test/index.test.js"],
  "git_diff_stat": "2 files changed, 45 insertions(+), 3 deletions(-)",
  "stderr": null
}
```
