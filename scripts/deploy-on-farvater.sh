#!/usr/bin/env bash
set -euo pipefail

echo "========================================================"
echo " Развёртывание стека Farvater (RPi 5 8GB: Hermes + n8n)"
echo "========================================================"

# 1. Настройка прав sudo с защитой /dev/mmcblk0 и /boot/firmware
echo "[1/8] Настройка безопасного sudoers для slava (защита /dev/mmcblk0)..."
sudo tee /etc/sudoers.d/010_pi-nopasswd > /dev/null <<'EOF'
Cmnd_Alias DANGEROUS_DISK = /usr/sbin/fdisk /dev/mmcblk0*, /usr/sbin/sfdisk /dev/mmcblk0*, /usr/sbin/parted /dev/mmcblk0*, /usr/sbin/mkfs* /dev/mmcblk0*, /usr/sbin/wipefs * /dev/mmcblk0*, /usr/bin/dd *of=/dev/mmcblk0*
slava ALL=(ALL) NOPASSWD: ALL, !DANGEROUS_DISK
EOF
sudo chmod 440 /etc/sudoers.d/010_pi-nopasswd

# 2. Оптимизация под microSD-карту и 8 ГБ RAM (zram, log2ram, journald, fstab)
echo "[2/8] Установка базовых пакетов и защита SD-карты (zram, log2ram, noatime)..."
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    curl wget git jq rsync zstd unzip ca-certificates gnupg lsb-release \
    python3 python3-pip python3-venv ffmpeg ripgrep

# В Raspberry Pi OS Trixie уже активен /dev/zram0 (2 ГБ в RAM через rpi-swap)
/sbin/swapon --show || true

# Ограничиваем systemd-journald в RAM (до 64 МБ), чтобы не тереть SD-карту
sudo mkdir -p /etc/systemd/journald.conf.d
sudo tee /etc/systemd/journald.conf.d/00-rpi-sdcard.conf > /dev/null <<'EOF'
[Journal]
Storage=volatile
RuntimeMaxUse=64M
EOF
sudo systemctl restart systemd-journald

# Установка log2ram
if ! command -v log2ram >/dev/null 2>&1; then
    echo "deb [signed-by=/usr/share/keyrings/azlux-archive-keyring.gpg] http://packages.azlux.fr/debian/ bookworm main" | sudo tee /etc/apt/sources.list.d/azlux.list >/dev/null
    sudo wget -qO /usr/share/keyrings/azlux-archive-keyring.gpg https://azlux.fr/repo.gpg
    sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y log2ram || true
    if [ -f /etc/log2ram.conf ]; then
        sudo sed -i 's/^SIZE=.*/SIZE=128M/' /etc/log2ram.conf
    fi
fi

# Добавляем commit=60 к корневому разделу ext4 в /etc/fstab (снижение частоты сброса метаданных)
if grep -q "ext4.*defaults,noatime" /etc/fstab && ! grep -q "commit=60" /etc/fstab; then
    sudo sed -i 's/defaults,noatime/defaults,noatime,commit=60/' /etc/fstab
fi

# 3. Установка Docker и Docker Compose (с ротацией логов)
echo "[3/8] Установка Docker и настройка лимитов логов контейнеров..."
if ! command -v docker >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | sudo sh
fi
sudo usermod -aG docker slava

sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json > /dev/null <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
EOF
sudo systemctl enable --now docker
sudo systemctl restart docker

# 4. Установка Tailscale (для подключения к Headscale и HTTPS-доступа к n8n)
echo "[4/8] Установка клиента Tailscale..."
if ! command -v tailscale >/dev/null 2>&1; then
    curl -fsSL https://tailscale.com/install.sh | sh
fi
sudo systemctl enable --now tailscaled

# 5. Установка NousResearch Hermes Agent (нативно от пользователя slava в неинтерактивном режиме)
echo "[5/8] Установка NousResearch Hermes Agent (от имени slava)..."
mkdir -p /home/slava/shared /home/slava/backups
if [ ! -x /home/slava/.local/bin/hermes ]; then
    curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --non-interactive
fi

# 6. Установка Antigravity CLI (agy) и настройка алиаса
echo "[6/8] Установка Antigravity CLI (agy) и настройка алиаса в ~/.bashrc..."
if [ ! -x /home/slava/.local/bin/agy ]; then
    curl -fsSL https://antigravity.google/cli/install.sh | bash
fi
sudo ln -sf /home/slava/.local/bin/agy /usr/local/bin/agy
if ! grep -q "alias agy=" /home/slava/.bashrc; then
    echo "alias agy='sudo agy --dangerously-skip-permissions'" >> /home/slava/.bashrc
fi

# 7. Установка утилит управления, моста Hermes <-> n8n и systemd-сервисов
echo "[7/8] Установка сервисов hermes-bridge, hermes-gateway и утилит n8n-ctl..."
sudo install -m 0755 /home/slava/deploy_bundle/scripts/n8n-ctl /usr/local/bin/n8n-ctl
sudo install -m 0755 /home/slava/deploy_bundle/scripts/hermes-bridge.py /usr/local/bin/hermes-bridge.py
sudo install -m 0755 /home/slava/deploy_bundle/scripts/migrate-hermes-from-test.sh /usr/local/bin/migrate-hermes-from-test
sudo install -m 0755 /home/slava/deploy_bundle/scripts/backup-stack.sh /usr/local/bin/backup-farvater

sudo cp /home/slava/deploy_bundle/systemd/hermes-bridge.service /etc/systemd/system/
sudo cp /home/slava/deploy_bundle/systemd/hermes-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-bridge.service
# hermes-gateway включим, но запустим после переноса/настройки конфигов ~/.hermes
sudo systemctl enable hermes-gateway.service

# 8. Сборка и запуск кастомного стека AdGuard Home + n8n + PostgreSQL
echo "[8/8] Настройка /etc/hosts и развёртывание Docker Compose стека (AdGuard Home + n8n + PostgreSQL)..."
if ! grep -q "192.168.0.55" /etc/hosts; then
    echo "192.168.0.55 farvater farvater.local farvater.lan n8n.farvater.lan" | sudo tee -a /etc/hosts >/dev/null
fi
mkdir -p /home/slava/n8n-stack/{n8n_data,custom_nodes,postgres_data,adguard_work,adguard_conf}
cp -f /home/slava/deploy_bundle/n8n-stack/{Dockerfile,docker-compose.yml} /home/slava/n8n-stack/
if [ ! -f /home/slava/n8n-stack/.env ]; then
    cp /home/slava/deploy_bundle/n8n-stack/.env /home/slava/n8n-stack/.env
fi
sudo chown -R 1000:1000 /home/slava/n8n-stack/{n8n_data,custom_nodes} /home/slava/shared

cd /home/slava/n8n-stack
sudo docker compose up -d --build

echo "========================================================"
echo " Готово! Стек AdGuard Home, n8n + PostgreSQL, Hermes Agent и agy развёрнуты!"
echo " - AdGuard Home Setup / UI: http://192.168.0.55:3000 (после настройки -> :8080)"
echo " - n8n UI (LAN): http://192.168.0.55:5678 (http://farvater.lan:5678)"
echo " - Мост n8n -> Hermes: http://host.docker.internal:8765/run"
echo "========================================================"
