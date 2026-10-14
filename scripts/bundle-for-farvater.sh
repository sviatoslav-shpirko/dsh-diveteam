#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_DIR="${HOME}/.dsh/profiles/deskweb"
OUT_ARCHIVE="${ROOT_DIR}/farvater-bundle.tar.gz"
STAGE_DIR="$(mktemp -d /tmp/farvater-bundle-stage.XXXXXX)"

trap 'rm -rf "${STAGE_DIR}"' EXIT

echo "[1/4] Синхронизация ролей и генерация cordis.patch.yml..."
node "${ROOT_DIR}/scripts/sync-roles.mjs"

echo "[2/4] Подготовка файлов проекта (roles, vault, skills, packages, scripts/dsh-agy)..."
mkdir -p "${STAGE_DIR}/farvater-project/packages" "${STAGE_DIR}/farvater-project/scripts"
cp -a "${ROOT_DIR}/roles" "${STAGE_DIR}/farvater-project/"
cp -a "${ROOT_DIR}/vault" "${STAGE_DIR}/farvater-project/"
cp -a "${ROOT_DIR}/skills" "${STAGE_DIR}/farvater-project/"
cp -a "${ROOT_DIR}/packages/dsh-dispatcher" "${STAGE_DIR}/farvater-project/packages/"
if [ -d "${ROOT_DIR}/packages/dsh-client-farvater-ui" ]; then
  cp -a "${ROOT_DIR}/packages/dsh-client-farvater-ui" "${STAGE_DIR}/farvater-project/packages/"
fi
cp -a "${ROOT_DIR}/scripts/sync-roles.mjs" "${STAGE_DIR}/farvater-project/scripts/"
cp -a "${ROOT_DIR}/scripts/dsh-agy" "${STAGE_DIR}/farvater-project/scripts/"
cp -a "${ROOT_DIR}/scripts/link-farvater.sh" "${STAGE_DIR}/farvater-project/scripts/"
if [ -f "${ROOT_DIR}/scripts/n8n-ctl" ]; then
  cp -a "${ROOT_DIR}/scripts/n8n-ctl" "${STAGE_DIR}/farvater-project/scripts/"
fi

echo "[3/4] Копирование очищенного профиля deskweb (cordis.patch.yml, package.json)..."
mkdir -p "${STAGE_DIR}/dsh-profile-deskweb"
cp -a "${PROFILE_DIR}/package.json" "${STAGE_DIR}/dsh-profile-deskweb/"
cp -a "${PROFILE_DIR}/cordis.patch.yml" "${STAGE_DIR}/dsh-profile-deskweb/"

cat > "${STAGE_DIR}/install-on-farvater.sh" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
BUNDLE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_PROJECT="${FARVATER_ROOT:-${HOME}/farvater}"
TARGET_PROFILE="${HOME}/.dsh/profiles/deskweb"
USER_SKILLS_DIR="${HOME}/.dsh/skills"

mkdir -p "${TARGET_PROJECT}" "${TARGET_PROFILE}" "${HOME}/.local/bin" "${USER_SKILLS_DIR}" "${TARGET_PROJECT}/.dsh/skills"
cp -a "${BUNDLE_ROOT}/farvater-project/." "${TARGET_PROJECT}/"
cp -a "${BUNDLE_ROOT}/dsh-profile-deskweb/cordis.patch.yml" "${TARGET_PROFILE}/cordis.patch.yml"

sed -e "s|/home/slava/Projects/DSH|${TARGET_PROJECT}|g" \
    -e "s|/home/slava/Projects/Hermes_N8N_rp5|${TARGET_PROJECT}|g" \
    "${BUNDLE_ROOT}/dsh-profile-deskweb/package.json" > "${TARGET_PROFILE}/package.json"

chmod +x "${TARGET_PROJECT}/scripts/dsh-agy" "${TARGET_PROJECT}/scripts/link-farvater.sh"
ln -sfn "${TARGET_PROJECT}/scripts/dsh-agy" "${HOME}/.local/bin/dsh-agy"

for skill_dir in "${TARGET_PROJECT}/skills"/*; do
  if [ -d "${skill_dir}" ] && [ -f "${skill_dir}/SKILL.md" ]; then
    skill_name="$(basename "${skill_dir}")"
    ln -sfn "${skill_dir}" "${USER_SKILLS_DIR}/${skill_name}"
    ln -sfn "${skill_dir}" "${TARGET_PROJECT}/.dsh/skills/${skill_name}"
  fi
done

node "${TARGET_PROJECT}/scripts/sync-roles.mjs"

mkdir -p "${TARGET_PROFILE}/node_modules/@farvater"
ln -sfn "${TARGET_PROJECT}/packages/dsh-dispatcher" "${TARGET_PROFILE}/node_modules/@farvater/dsh-dispatcher"
if [ -d "${TARGET_PROJECT}/packages/dsh-client-farvater-ui" ]; then
  ln -sfn "${TARGET_PROJECT}/packages/dsh-client-farvater-ui" "${TARGET_PROFILE}/node_modules/@farvater/dsh-client-farvater-ui"
fi

echo "✅ Сборка Фарватер (роли, dsh-agy, скиллы, диспетчер) установлена в ${TARGET_PROJECT} и профиль ${TARGET_PROFILE}"
EOF
chmod +x "${STAGE_DIR}/install-on-farvater.sh"

echo "[4/4] Упаковка архива ${OUT_ARCHIVE}..."
tar -czf "${OUT_ARCHIVE}" -C "${STAGE_DIR}" .
ls -lh "${OUT_ARCHIVE}"
echo "✅ Готово! Для переноса на Raspberry Pi 5 (192.168.0.55): scp ${OUT_ARCHIVE} slava@192.168.0.55:~/"
