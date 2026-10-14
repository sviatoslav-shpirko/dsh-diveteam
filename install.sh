#!/usr/bin/env bash
# ==============================================================================
# DiveTeam Multi-Agent Orchestrator for DeepSeek Harness (DSH)
# One-command installer for local workstation and remote hosts.
#
# Usage:
#   ./install.sh [--profile <profile_name>] [--dsh-home <path>] [--skip-build]
# ==============================================================================

set -euo pipefail

# ANSI color codes
BOLD='\033[1m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}${BOLD}[INFO]${NC} $*"; }
log_ok()   { echo -e "${GREEN}${BOLD}[OK]${NC} $*"; }
log_warn() { echo -e "${YELLOW}${BOLD}[WARN]${NC} $*"; }
log_err()  { echo -e "${RED}${BOLD}[ERROR]${NC} $*" >&2; }

# Resolve repository root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

# Defaults
PROFILE="deskweb"
DSH_HOME="${DSH_HOME:-${HOME}/.dsh}"
BIN_DIR="${HOME}/.local/bin"
SKIP_BUILD=false

# Parse command line flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile|-p)
      PROFILE="$2"
      shift 2
      ;;
    --dsh-home)
      DSH_HOME="$2"
      shift 2
      ;;
    --bin-dir)
      BIN_DIR="$2"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    --help|-h)
      echo "DiveTeam Installer"
      echo "Usage: ./install.sh [options]"
      echo ""
      echo "Options:"
      echo "  -p, --profile <name>   DSH profile name (default: deskweb)"
      echo "      --dsh-home <path>  Path to .dsh directory (default: ~/.dsh)"
      echo "      --bin-dir <path>   Path to user bin directory (default: ~/.local/bin)"
      echo "      --skip-build       Skip rebuilding frontend tsdown bundle"
      echo "  -h, --help             Show this help message"
      exit 0
      ;;
    *)
      log_err "Unknown argument: $1"
      exit 1
      ;;
  esac
done

echo -e "${BOLD}======================================================${NC}"
echo -e "${BOLD}  🌊 DiveTeam Installer for DeepSeek Harness (dsh)   ${NC}"
echo -e "${BOLD}======================================================${NC}"
log_info "Source Directory : ${SCRIPT_DIR}"
log_info "Target Profile   : ${PROFILE}"
log_info "DSH Home         : ${DSH_HOME}"
log_info "User Bin Dir     : ${BIN_DIR}"
echo ""

# 1. Check Node.js >= 22
log_info "Checking Node.js version..."
if ! command -v node >/dev/null 2>&1; then
  log_err "Node.js is not installed. Please install Node.js >= 22.0.0."
  exit 1
fi

NODE_MAJOR=$(node -v | sed -E 's/v([0-9]+).*/\1/')
if [[ "${NODE_MAJOR}" -lt 22 ]]; then
  log_err "Node.js version is $(node -v). DiveTeam and DSH require Node.js >= 22.0.0."
  exit 1
fi
log_ok "Node.js version $(node -v) is supported."

# 2. Check DSH CLI
if command -v dsh >/dev/null 2>&1; then
  log_ok "DSH binary found: $(command -v dsh)"
else
  log_warn "dsh binary not found on PATH. If running as a systemd service or global npm package, ensure ~/.local/bin is on PATH."
fi

# 3. Build UI bundle if needed
if [[ "${SKIP_BUILD}" = false ]]; then
  log_info "Verifying DiveTeam UI bundle..."
  UI_DIR="${SCRIPT_DIR}/packages/dsh-client-diveteam-ui"
  if [[ ! -f "${UI_DIR}/lib/client.js" || ! -f "${UI_DIR}/lib/index.js" ]]; then
    log_info "Compiling DiveTeam UI with tsdown..."
    (
      cd "${UI_DIR}"
      if [[ -x "./node_modules/.bin/tsdown" ]]; then
        ./node_modules/.bin/tsdown
      elif command -v tsdown >/dev/null 2>&1; then
        tsdown
      elif command -v npx >/dev/null 2>&1; then
        npx tsdown
      else
        log_warn "Could not build UI bundle (tsdown missing). Using existing lib/ files."
      fi
    )
    log_ok "DiveTeam UI bundle compiled successfully."
  else
    log_ok "DiveTeam UI bundle already built (lib/client.js present)."
  fi
fi

# 4. Prepare target profile directory
PROFILE_DIR="${DSH_HOME}/profiles/${PROFILE}"
log_info "Configuring profile directory: ${PROFILE_DIR}"
mkdir -p "${PROFILE_DIR}"

PROFILE_PKG="${PROFILE_DIR}/package.json"
if [[ ! -f "${PROFILE_PKG}" ]]; then
  log_info "Creating initial ${PROFILE_PKG}..."
  cat << EOF > "${PROFILE_PKG}"
{
  "name": "dsh-profile-${PROFILE}",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app"
      ]
    }
  }
}
EOF
fi

# 5. Wire DiveTeam plugins into profile package.json using Node.js script
log_info "Updating dependencies and bundles in ${PROFILE_PKG}..."
node - << 'EOF' "${PROFILE_PKG}" "${SCRIPT_DIR}"
const fs = require('node:fs');
const [,, pkgPath, repoRoot] = process.argv;

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.dependencies = pkg.dependencies || {};

// Remove legacy farvater dependencies if present
delete pkg.dependencies['@farvater/dsh-dispatcher'];
delete pkg.dependencies['@farvater/dsh-client-farvater-ui'];

// Add diveteam file dependencies
pkg.dependencies['@diveteam/dsh-dispatcher'] = `file:${repoRoot}/packages/dsh-dispatcher`;
pkg.dependencies['@diveteam/dsh-client-diveteam-ui'] = `file:${repoRoot}/packages/dsh-client-diveteam-ui`;

if (!pkg.dsh) pkg.dsh = {};
if (!pkg.dsh.profile) pkg.dsh.profile = {};
if (!Array.isArray(pkg.dsh.profile.bundles)) {
  pkg.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
}

// Clean legacy bundles
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(
  b => b !== '@farvater/dsh-dispatcher' && b !== '@farvater/dsh-client-farvater-ui'
);

// Ensure diveteam bundles are registered
if (!pkg.dsh.profile.bundles.includes('@diveteam/dsh-dispatcher')) {
  pkg.dsh.profile.bundles.push('@diveteam/dsh-dispatcher');
}
if (!pkg.dsh.profile.bundles.includes('@diveteam/dsh-client-diveteam-ui')) {
  pkg.dsh.profile.bundles.push('@diveteam/dsh-client-diveteam-ui');
}

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log('Successfully updated profile package.json');
EOF
log_ok "Profile dependencies and bundles updated."

# 6. Install scripts into user bin directory (~/.local/bin)
mkdir -p "${BIN_DIR}"
log_info "Linking DiveTeam scripts into ${BIN_DIR}..."

SCRIPTS=(
  "dsh-agy"
  "dsh-github-token"
  "dsh-git-credential-helper"
  "dsh-telegram-token"
  "vault-sync"
)

for script in "${SCRIPTS[@]}"; do
  src="${SCRIPT_DIR}/scripts/${script}"
  dst="${BIN_DIR}/${script}"
  if [[ -f "${src}" ]]; then
    chmod +x "${src}"
    ln -sf "${src}" "${dst}"
    log_ok "Linked ${script} -> ${dst}"
  fi
done

# 7. Link skills into ~/.dsh/skills
SKILLS_DEST="${DSH_HOME}/skills"
mkdir -p "${SKILLS_DEST}"
if [[ -d "${SCRIPT_DIR}/skills" ]]; then
  log_info "Linking DiveTeam skills into ${SKILLS_DEST}..."
  for skill_dir in "${SCRIPT_DIR}/skills"/*; do
    if [[ -d "${skill_dir}" ]]; then
      skill_name=$(basename "${skill_dir}")
      ln -sfn "${skill_dir}" "${SKILLS_DEST}/${skill_name}"
      log_ok "Linked skill ${skill_name} -> ${SKILLS_DEST}/${skill_name}"
    fi
  done
fi

# 8. Synchronize role presets into cordis.patch.yml
log_info "Synchronizing agent role presets (scripts/sync-roles.mjs)..."
export DSH_PROFILE_PATCH="${PROFILE_DIR}/cordis.patch.yml"
node "${SCRIPT_DIR}/scripts/sync-roles.mjs"
log_ok "Role presets generated and synchronized into ${DSH_PROFILE_PATCH}."

# 9. Verify or initialize workflow rules
if [[ ! -f "${SCRIPT_DIR}/workflow-rules.json" ]]; then
  log_info "Initializing default workflow-rules.json..."
  cat << 'EOF' > "${SCRIPT_DIR}/workflow-rules.json"
{
  "maxHeavyWorkers": 3,
  "maxQaRetries": 2,
  "autoMergeOnPass": true,
  "requireSreApproval": true,
  "circuitBreakerTokens": 2000000,
  "escalateToArchOnFailure": true
}
EOF
  log_ok "Created workflow-rules.json."
fi

echo ""
echo -e "${GREEN}${BOLD}======================================================${NC}"
echo -e "${GREEN}${BOLD}  ✅ DiveTeam successfully installed!                 ${NC}"
echo -e "${GREEN}${BOLD}======================================================${NC}"
echo ""
echo "Next steps:"
echo "1. Verify ~/.local/bin is in your PATH:"
echo "   export PATH=\"${BIN_DIR}:\$PATH\""
echo ""
echo "2. Configure Telegram Bot Token (optional):"
echo "   dsh-telegram-token set <YOUR_BOT_TOKEN>"
echo "   or export DIVETEAM_TG_BOT_TOKEN=\"<YOUR_BOT_TOKEN>\""
echo ""
echo "3. Configure GitHub Token (optional):"
echo "   dsh-github-token set <YOUR_GITHUB_TOKEN>"
echo "   or export DIVETEAM_GITHUB_TOKEN=\"<YOUR_GITHUB_TOKEN>\""
echo ""
echo "4. Launch DSH with profile '${PROFILE}':"
echo "   dsh --profile ${PROFILE}"
echo ""
echo "5. Open Web UI in browser: http://127.0.0.1:3080"
echo "   Click on the 'DiveTeam' tab in the sidebar to open the Control Panel."
echo ""
