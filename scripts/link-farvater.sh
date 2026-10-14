#!/usr/bin/env bash
# Establish the Farvater development symlinks for /home/slava/Projects/DSH.
#
# 1. Links @deepseek-ai/{dsh-tools,schemastery} into PROJECT_ROOT/node_modules
#    so @farvater/dsh-dispatcher tests and modules resolve cleanly.
# 2. Links @farvater/{dsh-dispatcher,dsh-client-farvater-ui} into the deskweb profile.
# 3. Links scripts/dsh-agy into ~/.local/bin/dsh-agy.
# 4. Links skills/{agy,creds,n8n-farvater} into ~/.dsh/skills/ and PROJECT_ROOT/.dsh/skills/.

set -euo pipefail

DSH_REPO="${DSH_REPO:-/home/slava/Projects/DeepSeek-Harness}"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/deskweb}"
USER_SKILLS_DIR="${DSH_HOME:-$HOME/.dsh}/skills"

# 1. Project-level symlinks to the dsh source (for the dispatcher's imports).
mkdir -p "$PROJECT_ROOT/node_modules/@deepseek-ai"
ln -sfn "$DSH_REPO/packages/core/tools" "$PROJECT_ROOT/node_modules/@deepseek-ai/dsh-tools"
ln -sfn "$DSH_REPO/packages/core/tools/node_modules/@deepseek-ai/schemastery" "$PROJECT_ROOT/node_modules/@deepseek-ai/schemastery"

# 2. Profile-level symlinks to this project (live development).
mkdir -p "$PROFILE_DIR/node_modules/@diveteam"
for pkg in dsh-dispatcher dsh-client-diveteam-ui; do
  dst="$PROFILE_DIR/node_modules/@diveteam/$pkg"
  rm -rf "$dst"
  ln -s "$PROJECT_ROOT/packages/$pkg" "$dst"
  echo "linked @diveteam/$pkg -> $PROJECT_ROOT/packages/$pkg"
done

# 3. CLI wrapper symlinks (dsh-agy, dsh-github-token, dsh-git-credential-helper, dsh-telegram-token, vault-sync).
mkdir -p "$HOME/.local/bin"
for bin_name in dsh-agy dsh-github-token dsh-git-credential-helper dsh-telegram-token vault-sync; do
  if [ -f "$PROJECT_ROOT/scripts/$bin_name" ]; then
    chmod +x "$PROJECT_ROOT/scripts/$bin_name"
    ln -sfn "$PROJECT_ROOT/scripts/$bin_name" "$HOME/.local/bin/$bin_name"
    echo "linked ~/.local/bin/$bin_name -> $PROJECT_ROOT/scripts/$bin_name"
  fi
done

# 4. Skills symlinks (user-level ~/.dsh/skills and project-level .dsh/skills).
mkdir -p "$USER_SKILLS_DIR" "$PROJECT_ROOT/.dsh/skills"
for skill_dir in "$PROJECT_ROOT/skills"/*; do
  if [ -d "$skill_dir" ] && [ -f "$skill_dir/SKILL.md" ]; then
    skill_name="$(basename "$skill_dir")"
    ln -sfn "$skill_dir" "$USER_SKILLS_DIR/$skill_name"
    ln -sfn "$skill_dir" "$PROJECT_ROOT/.dsh/skills/$skill_name"
    echo "linked skill $skill_name -> $skill_dir"
  fi
done

echo "done"
