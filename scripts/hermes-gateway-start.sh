#!/bin/bash
set -e

RAM_CREDS_DIR="/dev/shm/hermes-creds"
mkdir -p "$RAM_CREDS_DIR"
chmod 700 "$RAM_CREDS_DIR"

# 1. Если systemd передал расшифрованные секреты через LoadCredentialEncrypted ($CREDENTIALS_DIRECTORY),
#    копируем их в /dev/shm/hermes-creds (RAM tmpfs, права 0600 slava:slava) для доступа из CLI и hermes-bridge
if [ -n "${CREDENTIALS_DIRECTORY:-}" ] && [ -d "$CREDENTIALS_DIRECTORY" ]; then
    for cred_file in "$CREDENTIALS_DIRECTORY"/*; do
        [ -f "$cred_file" ] || continue
        base_name="$(basename "$cred_file")"
        cp -f "$cred_file" "$RAM_CREDS_DIR/$base_name"
        chmod 600 "$RAM_CREDS_DIR/$base_name"
    done
fi

# 2. Если в /etc/credstore.encrypted есть .cred файлы, которые ещё не попали в RAM_CREDS_DIR,
#    расшифровываем их на лету в RAM (/dev/shm/hermes-creds) через sudo systemd-creds decrypt
for enc_file in $(sudo find /etc/credstore.encrypted -maxdepth 1 -name '*.cred' -type f 2>/dev/null | sort); do
    cred_name="$(basename "$enc_file" .cred)"
    if [ ! -s "$RAM_CREDS_DIR/$cred_name" ]; then
        sudo systemd-creds decrypt --name="$cred_name" "$enc_file" - > "$RAM_CREDS_DIR/$cred_name" 2>/dev/null || true
        chmod 600 "$RAM_CREDS_DIR/$cred_name"
    fi
done

# Подгрузка Service Account JSON для Vertex AI
if [ -s "$RAM_CREDS_DIR/VERTEX_SA.json" ]; then
    export VERTEX_CREDENTIALS_PATH="$RAM_CREDS_DIR/VERTEX_SA.json"
    export GOOGLE_APPLICATION_CREDENTIALS="$RAM_CREDS_DIR/VERTEX_SA.json"
fi

# Подгрузка Gemini API Key если есть
if [ -s "$RAM_CREDS_DIR/GEMINI_API_KEY" ]; then
    export GEMINI_API_KEY="$(cat "$RAM_CREDS_DIR/GEMINI_API_KEY")"
    export GOOGLE_API_KEY="$GEMINI_API_KEY"
fi

# Подгрузка OpenCode API Key (только официальные переменные из _HERMES_PROVIDER_ENV_BLOCKLIST)
if [ -s "$RAM_CREDS_DIR/OPENCODE_GO_API_KEY" ]; then
    export OPENCODE_GO_API_KEY="$(cat "$RAM_CREDS_DIR/OPENCODE_GO_API_KEY")"
    export OPENCODE_ZEN_API_KEY="$OPENCODE_GO_API_KEY"
    export OPENCODE_GO_BASE_URL="https://opencode.ai/zen/go/v1"
fi

# 3. Автоматическая сборка глобального /etc/hermes/.env -> /dev/shm/hermes-creds/managed.env и профильных .env в RAM
MANAGED_ENV="${RAM_CREDS_DIR}/managed.env"
: > "$MANAGED_ENV"
chmod 600 "$MANAGED_ENV"
{
    echo "# --- Auto-generated in RAM (/dev/shm) by hermes-gateway-start.sh ---"
    if [ -s "$RAM_CREDS_DIR/VERTEX_SA.json" ]; then
        printf 'VERTEX_CREDENTIALS_PATH=%s/VERTEX_SA.json\n' "$RAM_CREDS_DIR"
        printf 'GOOGLE_APPLICATION_CREDENTIALS=%s/VERTEX_SA.json\n' "$RAM_CREDS_DIR"
    fi
    if [ -n "${OPENCODE_GO_API_KEY:-}" ]; then
        printf 'OPENCODE_GO_API_KEY=%s\n' "$OPENCODE_GO_API_KEY"
        printf 'OPENCODE_ZEN_API_KEY=%s\n' "$OPENCODE_GO_API_KEY"
        printf 'OPENCODE_GO_BASE_URL=https://opencode.ai/zen/go/v1\n'
    fi
    if [ -n "${GEMINI_API_KEY:-}" ]; then
        printf 'GEMINI_API_KEY=%s\n' "$GEMINI_API_KEY"
        printf 'GOOGLE_API_KEY=%s\n' "$GEMINI_API_KEY"
    fi
} >> "$MANAGED_ENV"
sudo mkdir -p /etc/hermes
sudo chmod 755 /etc/hermes
sudo ln -sfn "$MANAGED_ENV" /etc/hermes/.env

PROFILES_ROOT="/home/slava/.hermes/profiles"
if [ -d "$PROFILES_ROOT" ]; then
    for prof_dir in "$PROFILES_ROOT"/*; do
        [ -d "$prof_dir" ] || continue
        prof_name="$(basename "$prof_dir")"
        tpl_file="${prof_dir}/.env.template"
        env_link="${prof_dir}/.env"
        ram_env="${RAM_CREDS_DIR}/${prof_name}.env"
        if [ ! -f "$tpl_file" ] && [ -f "$env_link" ] && [ ! -L "$env_link" ]; then
            grep -vE '^(export )?(OPENCODE_GO_API_KEY|OPENCODE_API_KEY|OPENCODE_ZEN_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|HERMES_DASHBOARD_BASIC_AUTH_USERNAME|HERMES_DASHBOARD_BASIC_AUTH_PASSWORD)=' "$env_link" > "$tpl_file" || true
            chmod 600 "$tpl_file"
        fi
        if [ -f "$tpl_file" ]; then
            cp -f "$tpl_file" "$ram_env"
            chmod 600 "$ram_env"
            {
                echo ""
                echo "# --- Auto-generated in RAM (/dev/shm) by hermes-gateway-start.sh ---"
                if [ -n "${OPENCODE_GO_API_KEY:-}" ]; then
                    printf 'OPENCODE_GO_API_KEY=%s\n' "$OPENCODE_GO_API_KEY"
                    printf 'OPENCODE_ZEN_API_KEY=%s\n' "$OPENCODE_GO_API_KEY"
                fi
                if [ -n "${GEMINI_API_KEY:-}" ]; then
                    printf 'GEMINI_API_KEY=%s\n' "$GEMINI_API_KEY"
                    printf 'GOOGLE_API_KEY=%s\n' "$GEMINI_API_KEY"
                fi
            } >> "$ram_env"
            ln -sfn "$ram_env" "$env_link"
        fi
    done
fi

exec /home/slava/.hermes/hermes-agent/.hermes/bin/hermes gateway run
