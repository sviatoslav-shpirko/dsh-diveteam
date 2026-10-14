---
name: creds
description: 'Управление секретами, авторизацией GitHub и Telegram-ботом в системе «DiveTeam» (dsh): работа с GitHub по HTTPS-токену из KDE Wallet (dsh-github-token / dsh-git-credential-helper), токен Telegram-бота Штурмана из KDE Wallet (dsh-telegram-token), синхронизация memvault (vault-sync) и шифрование секретов systemd-creds (/dev/shm/hermes-creds).'
whenToUse: 'Используй при любых операциях с GitHub (git clone/pull/push, gh CLI, GitHub API, синхронизация vault с sviatoslav-shpirko/memvault), проверке доступа к GitHub (dsh-github-token status) или Telegram-боту (dsh-telegram-token status), а также при настройке или ротации зашифрованных секретов systemd-creds на хосте diveteam.'
user-invocable: true
---

# Скилл `creds` — Авторизация GitHub и Telegram (KDE Wallet) и безопасное хранение секретов (`systemd-creds`)

В системе «DiveTeam» на базе DeepSeek Harness (`dsh`) действует жёсткое правило безопасности: **открытые токены и ключи никогда не записываются на диск в конфигурационные файлы или логи чата**. Все операции с GitHub и Telegram Bot API выполняются с динамической подгрузкой токенов из **KDE Wallet** (или RAM `tmpfs` на `diveteam`).

---

## 1. Работа с GitHub в `dsh` (HTTPS-токен из KDE Wallet вместо SSH)

### 1.1. Где хранится и как извлекается токен GitHub
1. **На рабочей станции разработки `p1-arch` (Arch Linux):**
   - Токен (Personal Access Token со всеми правами к репозиториям и API) хранится в **KDE Wallet** (бумажник `kdewallet`, папка `Git_tokens`, запись `github_first_test_token`).
   - Извлекается динамически в оперативную память утилитой **`/home/slava/.local/bin/dsh-github-token`** (`kwallet-query -f Git_tokens -r github_first_test_token kdewallet`).
2. **На целевом боевом сервере `diveteam` (Raspberry Pi 5):**
   - Извлекается из RAM-диска `/dev/shm/hermes-creds/GITHUB_TOKEN` (или `/run/credentials/hermes-gateway.service/GITHUB_TOKEN`), куда расшифровывается через `systemd-creds`.
3. **Внутри запущенных сессий `dsh`, субагентов и `dsh-agy`:**
   - Обёртки запуска `~/.local/bin/dsh`, `~/.local/bin/dsh-gui`, адаптер `dsh-agy` и плагин `diveteam-dispatcher` автоматически экспортируют `GH_TOKEN`, `GITHUB_TOKEN`, `DIVETEAM_GITHUB_TOKEN` и `FARVATER_GITHUB_TOKEN` в память процесса.
   - Настроен Git Credential Helper **`/home/slava/.local/bin/dsh-git-credential-helper`** и автоматическое перенаправление URL: любые обращения к `git@github.com:<owner>/<repo>.git` или `ssh://git@github.com/...` прозрачно переписываются Git в `https://github.com/<owner>/<repo>.git` с авторизацией по токену (`GIT_TERMINAL_PROMPT=0`).

### 1.2. Команды проверки и работы с GitHub
```bash
# Безопасная проверка статуса токена, маскированного префикса, прав и доступа к sviatoslav-shpirko/memvault:
dsh-github-token status
dsh-github-token status --human

# Проверка доступа к конкретному репозиторию:
dsh-github-token status --repo sviatoslav-shpirko/memvault

# Клонирование, pull и push любых репозиториев GitHub (всегда по HTTPS через dsh-git-credential-helper):
git clone https://github.com/sviatoslav-shpirko/memvault.git
git pull origin main
git push origin main

# Использование GitHub CLI (gh) или curl с переменной $GH_TOKEN в памяти:
gh auth status
gh repo view sviatoslav-shpirko/memvault
curl -sS -H "Authorization: Bearer $(dsh-github-token print)" https://api.github.com/user | jq '{login, id}'
```

> ⛔ **Правило безопасности:** НИКОГДА не выводи сырой вывод `dsh-github-token print`, `dsh-telegram-token print` или `kwallet-query` напрямую в stdout/чат и никогда не сохраняй токены в `.git/config`, `.env`, `CORE.md` или `cordis.patch.yml`. Для диагностики используй только `dsh-github-token status` и `dsh-telegram-token status`.

### 1.3. Синхронизация хранилища знаний `vault/` с `https://github.com/sviatoslav-shpirko/memvault`
Хранилище знаний `/home/slava/Projects/DSH/vault` привязано к удалённому приватному репозиторию `https://github.com/sviatoslav-shpirko/memvault.git`. Для обновления графа `graphify`, коммита и пуша в `memvault` используй скрипт **`vault-sync`** (`/home/slava/.local/bin/vault-sync`):
```bash
# Полная синхронизация: graphify update + git commit + git push origin main:
vault-sync

# Только локальное обновление графа и коммит без push:
vault-sync --no-push

# Быстрый поиск по ассоциативному графу знаний vault/graphify-out/graph.json:
vault-sync query "CORE MEMORY"
vault-sync query "dsh-agy"
```

---

## 2. Токен Telegram-бота Штурмана (`@diveteam_shturman_bot`) из KDE Wallet

### 2.1. Где хранится и как извлекается токен Telegram
1. **На рабочей станции `p1-arch` (Arch Linux):**
   - Токен бота `@diveteam_shturman_bot` хранится в **KDE Wallet** (бумажник `kdewallet`, папка `Telegram_bot_tokens`, запись `diveteam_shturman_bot` с фоллбэком на `farvater_shturman_bot`).
   - Извлекается динамически в оперативную память утилитой **`/home/slava/.local/bin/dsh-telegram-token`** (`kwallet-query -f Telegram_bot_tokens -r diveteam_shturman_bot kdewallet`).
2. **На боевом сервере `diveteam`:**
   - Извлекается из `/dev/shm/hermes-creds/DIVETEAM_TG_BOT_TOKEN` (или `FARVATER_TG_BOT_TOKEN`).
3. **Белый список авторизации (Whitelisted Owner ID):**
   - Разрешённый ID чата и пользователя владельца (Славы): **`81815557`** (`DIVETEAM_TG_CHAT_ID="81815557"`, `DIVETEAM_TG_USER_ID="81815557"`, с фоллбэком на `FARVATER_*`).
   - Любые входящие сообщения или команды от других `chat.id` / `from.id` строго отбрасываются мостом `TelegramBridge`.
4. **Автоматический экспорт и команды бота:**
   - Обёртки `~/.local/bin/dsh`, `~/.local/bin/dsh-gui` и `DiveTeamDispatcher.ensureTelegramTokenEnv()` автоматически подгружают `DIVETEAM_TG_BOT_TOKEN`, `DIVETEAM_TG_CHAT_ID="81815557"` и `DIVETEAM_TG_USER_ID="81815557"` (с фоллбэком на `FARVATER_*`) при старте и запускают long-polling.
   - Поддерживаемые команды в Telegram: `/status`, `/tasks`, `/approve <TASK-ID> [комментарий]`, `/reject <TASK-ID> [причина]`, а также свободные текстовые сообщения (напрямую пересылаются агенту `shturman` с отправкой ответа в Telegram).

### 2.2. Команды проверки и отправки уведомлений в Telegram
```bash
# Безопасная проверка статуса токена в KDE Wallet и вызов getMe (маскированный токен):
dsh-telegram-token status
dsh-telegram-token status --human

# Отправка сообщения владельцу (81815557):
dsh-telegram-token send "Текст уведомления от DiveTeam"
```

---

## 3. Зашифрованные секреты `systemd-creds` на сервере `diveteam`

На сервере `diveteam` все API-ключи и сервисные аккаунты хранятся **исключительно в зашифрованном виде** в `/etc/credstore.encrypted/*.cred` (привязаны к ключу хоста `/var/lib/systemd/credential.secret`).
На карту памяти (SD) открытые ключи никогда не записываются — расшифровка происходит только в оперативную память (`tmpfs`: `/run/credentials/hermes-gateway.service/` и `/dev/shm/hermes-creds/`).

### 3.1. Доступные секреты в `/dev/shm/hermes-creds/`
* `VERTEX_SA.json` (`/etc/credstore.encrypted/VERTEX_SA.json.cred`) — Google Cloud Vertex AI Service Account JSON.
* `OPENCODE_GO_API_KEY` (`/etc/credstore.encrypted/OPENCODE_GO_API_KEY.cred`) — API-ключ OpenCode / Zen Go (переменная `OPENCODE_API_KEY` строго запрещена!).
* `GEMINI_API_KEY` (`/etc/credstore.encrypted/GEMINI_API_KEY.cred`) — Google AI Studio Gemini API Key.
* `GITHUB_TOKEN` (`/etc/credstore.encrypted/GITHUB_TOKEN.cred`) — GitHub Personal Access Token (читается автоматически скриптом `dsh-github-token`).
* `DIVETEAM_TG_BOT_TOKEN` / `FARVATER_TG_BOT_TOKEN` (`/etc/credstore.encrypted/DIVETEAM_TG_BOT_TOKEN.cred`) — токен Telegram-бота `@diveteam_shturman_bot` (читается автоматически скриптом `dsh-telegram-token`).

### 3.2. Быстрое управление через утилиту `hermes-creds`
* **Зашифровать файл (например, JSON-ключ) и безопасно уничтожить исходник (`shred -u`):**
  ```bash
  hermes-creds set VERTEX_SA.json ~/vertex_sa_input.json
  ```
* **Зашифровать строковый токен напрямую из памяти (без записи на диск):**
  ```bash
  hermes-creds set-string OPENCODE_GO_API_KEY "sk-..."
  hermes-creds set-string GEMINI_API_KEY "AIza..."
  hermes-creds set-string GITHUB_TOKEN "$(dsh-github-token print)"
  hermes-creds set-string DIVETEAM_TG_BOT_TOKEN "$(dsh-telegram-token print)"
  ```
* **Проверить статус секретов на диске и в RAM:**
  ```bash
  hermes-creds status
  ```
* **Принудительно расшифровать все `.cred` в `/dev/shm/hermes-creds`:**
  ```bash
  hermes-creds sync-ram
  ```

### 3.3. Ручное шифрование через `systemd-creds`
> **ВАЖНО:** Параметр `--name=<ИМЯ>` строго обязателен! Без него `systemd-creds` запишет имя с расширением `.cred`, и `systemd` выдаст ошибку `status=243/CREDENTIALS`.

```bash
sudo systemd-creds -H --name=VERTEX_SA.json encrypt ~/vertex_sa_input.json /etc/credstore.encrypted/VERTEX_SA.json.cred
sudo chmod 600 /etc/credstore.encrypted/VERTEX_SA.json.cred
shred -u ~/vertex_sa_input.json
```
