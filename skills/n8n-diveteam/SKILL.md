---
name: n8n-diveteam
description: Управление локальным стеком n8n + PostgreSQL на сервере diveteam (Raspberry Pi 5), установка npm/apk пакетов в контейнер n8n, работа с общей папкой /home/slava/shared и двусторонняя интеграция Hermes <-> n8n.
---

# Управление стеком n8n на сервере `diveteam`

На этом сервере (`diveteam`, `192.168.0.55`) развёрнут кастомный стек **n8n + PostgreSQL 16** в Docker Compose.

## 1. Расположение файлов и папок
* **Директория стека Docker Compose:** `/home/slava/n8n-stack`
  * `Dockerfile` — кастомный образ `diveteam/n8n-custom:latest` (базируется на `n8nio/n8n:latest` с восстановленным пакетным менеджером `apk` и глобальными `npm`-модулями).
  * `docker-compose.yml` — конфигурация `n8n` + `postgres:16-alpine`.
  * `n8n_data/` — данные n8n (`/home/node/.n8n` внутри контейнера, включая установленные из UI Community Nodes).
  * `custom_nodes/` — папка для самописных кастомных узлов (`/home/node/.n8n/custom` внутри контейнера).
* **Общая папка обмена файлами между Hermes и n8n:**
  * На хосте (`diveteam`): `/home/slava/shared`
  * Внутри контейнера `n8n`: `/data/shared`
  * Любые файлы (аудио, видео, PDF, JSON, CSV), которые нужно передать из Hermes в n8n или обратно, сохраняй в `/home/slava/shared`.

## 2. Доустановка пакетов в контейнер n8n (`n8n-ctl`)
Для установки новых библиотек в n8n используй встроенную утилиту `/usr/local/bin/n8n-ctl`:

* **Добавить npm-пакет для узла `Code` (`require('...')`):**
  ```bash
  n8n-ctl add-npm <имя_пакета>
  ```
* **Добавить системную утилиту Alpine (`apk`) для узла `Execute Command`:**
  ```bash
  n8n-ctl add-apk <имя_пакета>
  ```
* **Пересобрать / перезапустить / посмотреть статус и логи:**
  ```bash
  n8n-ctl rebuild
  n8n-ctl restart
  n8n-ctl status
  n8n-ctl logs
  ```

## 3. Двусторонняя связь Hermes <-> n8n
1. **Вызов Hermes Agent из воркфлоу n8n:**
   На хосте запущен сервис `hermes-bridge.service` (порт `8765`).
   Внутри любого воркфлоу n8n используй узел **HTTP Request**:
   * **Method:** `POST`
   * **URL:** `http://host.docker.internal:8765/run`
   * **Body (JSON):**
     ```json
     {
       "prompt": "Текст задачи для Hermes Agent",
       "timeout": 300
     }
     ```
2. **Управление n8n из Hermes Agent (REST API / MCP):**
   * Локальный URL n8n: `http://127.0.0.1:5678`
   * API-эндпоинт: `http://127.0.0.1:5678/api/v1/workflows` (заголовок `X-N8N-API-KEY: <ключ из Settings -> n8n API>`).
   * Вебхуки n8n: `http://127.0.0.1:5678/webhook/<путь>` или `http://127.0.0.1:5678/webhook-test/<путь>`.

## 4. Резервное копирование
Для создания полного бэкапа БД PostgreSQL, данных n8n и конфигов `~/.hermes` выполни:
```bash
backup-diveteam
```
Бэкапы сохраняются в `/home/slava/backups/`.
