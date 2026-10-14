#!/usr/bin/env bash
set -euo pipefail

# Скрипт миграции конфигов, памяти и скиллов Hermes Agent (~/.hermes)
# с тестового root-инстанса на пользователя slava (/home/slava/.hermes).
#
# Варианты запуска:
#   1) Напрямую по SSH с тестового инстанса:
#      migrate-hermes-from-test.sh root@192.168.1.XX
#   2) Из заранее снятого архива (.tar.gz / .tar.zst / .tgz):
#      migrate-hermes-from-test.sh /path/to/hermes-root-backup.tar.gz

SOURCE="${1:-}"
TARGET_DIR="/home/slava/.hermes"
BACKUP_OLD="/home/slava/.hermes.pre-migration.$(date +%Y%m%d-%H%M%S)"

if [ -z "$SOURCE" ]; then
    cat <<EOF
Использование:
  $0 <root@IP_ТЕСТОВОГО_RP5 | /путь/к/архиву.tar.gz>

Примеры:
  $0 root@192.168.1.50
  $0 ~/shared/hermes_root_backup.tar.gz
EOF
    exit 1
fi

echo "[1/4] Остановка сервиса hermes-gateway (если запущен)..."
sudo systemctl stop hermes-gateway.service 2>/dev/null || true

if [ -d "$TARGET_DIR" ]; then
    echo "[2/4] Сохранение текущего каталога ~/.hermes в ${BACKUP_OLD}..."
    cp -a "$TARGET_DIR" "$BACKUP_OLD"
fi
mkdir -p "$TARGET_DIR"

if [ -f "$SOURCE" ]; then
    echo "[3/4] Распаковка архива ${SOURCE}..."
    TMP_EXTRACT=$(mktemp -d)
    tar -xf "$SOURCE" -C "$TMP_EXTRACT"
    # Ищем config.yaml или содержимое .hermes внутри распакованного архива
    if [ -d "${TMP_EXTRACT}/.hermes" ]; then
        rsync -a --exclude='venv' --exclude='.venv' --exclude='node_modules' "${TMP_EXTRACT}/.hermes/" "${TARGET_DIR}/"
    elif [ -d "${TMP_EXTRACT}/root/.hermes" ]; then
        rsync -a --exclude='venv' --exclude='.venv' --exclude='node_modules' "${TMP_EXTRACT}/root/.hermes/" "${TARGET_DIR}/"
    else
        rsync -a --exclude='venv' --exclude='.venv' --exclude='node_modules' "${TMP_EXTRACT}/" "${TARGET_DIR}/"
    fi
    rm -rf "$TMP_EXTRACT"
else
    echo "[3/4] Копирование /root/.hermes с ${SOURCE} по rsync (без виртуальных окружений, чтобы не сломать пути)..."
    rsync -avz --progress \
        --exclude='venv' \
        --exclude='.venv' \
        --exclude='hermes-agent' \
        --exclude='node_modules' \
        --exclude='__pycache__' \
        "${SOURCE}:/root/.hermes/" "${TARGET_DIR}/"
fi

echo "[4/4] Исправление путей /root/.hermes -> /home/slava/.hermes и владельца slava:slava..."
find "$TARGET_DIR" -maxdepth 3 -type f \( -name "*.yaml" -o -name "*.yml" -o -name "*.json" -o -name "*.env" -o -name "*.md" -o -name "*.toml" \) \
    -exec sed -i 's|/root/.hermes|/home/slava/.hermes|g; s|/root/|/home/slava/|g' {} + 2>/dev/null || true

sudo chown -R slava:slava "$TARGET_DIR"
chmod 700 "$TARGET_DIR"
[ -f "${TARGET_DIR}/.env" ] && chmod 600 "${TARGET_DIR}/.env"

echo "[+] Готово! Проверка окружения через hermes doctor..."
export PATH="/home/slava/.local/bin:/home/slava/.hermes/bin:$PATH"
hermes doctor || true

echo "[+] Для запуска шлюза выполните: sudo systemctl enable --now hermes-gateway.service"
