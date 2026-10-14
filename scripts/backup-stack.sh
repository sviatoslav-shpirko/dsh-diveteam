#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="/home/slava/backups"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
WORK_DIR="$(mktemp -d)"
ARCHIVE="${BACKUP_DIR}/farvater-backup-${TIMESTAMP}.tar.zst"

mkdir -p "$BACKUP_DIR"

echo "[1/3] Дамп базы данных PostgreSQL (n8n)..."
if docker ps --format '{{.Names}}' | grep -q '^n8n-postgres$'; then
    docker exec n8n-postgres pg_dump -U n8n -d n8n > "${WORK_DIR}/n8n_postgres.sql"
fi

echo "[2/3] Копирование данных n8n, AdGuard Home и конфигов Hermes Agent (~/.hermes)..."
mkdir -p "${WORK_DIR}/n8n-stack" "${WORK_DIR}/hermes"
cp -a /home/slava/n8n-stack/{Dockerfile,docker-compose.yml,.env,custom_nodes,n8n_data,adguard_conf} "${WORK_DIR}/n8n-stack/" 2>/dev/null || true

if [ -d /home/slava/.hermes ]; then
    rsync -a \
        --exclude='venv' \
        --exclude='.venv' \
        --exclude='hermes-agent' \
        --exclude='node_modules' \
        --exclude='__pycache__' \
        /home/slava/.hermes/ "${WORK_DIR}/hermes/"
fi

echo "[3/3] Сжатие архива (zstd)..."
tar -C "$WORK_DIR" -I "zstd -T0 -10" -cf "$ARCHIVE" .
rm -rf "$WORK_DIR"

# Храним последние 10 бэкапов
ls -1t "${BACKUP_DIR}"/farvater-backup-*.tar.zst 2>/dev/null | tail -n +11 | xargs -r rm -f

echo "[+] Бэкап успешно создан: ${ARCHIVE} ($(du -h "$ARCHIVE" | cut -f1))"
