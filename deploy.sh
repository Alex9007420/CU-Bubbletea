#!/usr/bin/env bash
# deploy.sh — Ship workspace "CU-Bubbletea" to a remote VM
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:?Set REMOTE_HOST=<ip>}"
REMOTE_USER="${REMOTE_USER:-azureuser}"
REMOTE_DIR="${REMOTE_DIR:-/home/$REMOTE_USER/workspace-CU-Bubbletea}"
WORKSPACE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Deploying to $REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR ..."

# Sync files
rsync -avz --progress \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.env' \
  "$WORKSPACE_DIR/" \
  "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/"

# Ensure Docker on remote
ssh "$REMOTE_USER@$REMOTE_HOST" 'command -v docker || (sudo apt-get update -qq && sudo apt-get install -y -qq docker.io && sudo systemctl enable --now docker)'

# Start on remote
ssh "$REMOTE_USER@$REMOTE_HOST" bash -s -- "$REMOTE_DIR" <<'REMOTE'
  DIR="$1"
  cd "$DIR"
  if [ -f docker-compose.yml ]; then
    docker compose up -d
    echo "Started via docker-compose"
  else
    echo "Workspace synced to $DIR"
    echo "Run: claude --print 'your prompt' -C $DIR"
  fi
REMOTE

echo "Deploy complete: http://$REMOTE_HOST:3000"
