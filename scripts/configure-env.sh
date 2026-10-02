#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -e .env ]]; then echo '.env already exists; edit it manually.' >&2; exit 1; fi
app_url="${1:-}"
if [[ ! "$app_url" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?/?$ ]]; then
  echo 'Usage: bash scripts/configure-env.sh https://your.domain' >&2; exit 1
fi
command -v openssl >/dev/null
umask 077
db_password="$(openssl rand -hex 32)"
session_secret="$(openssl rand -hex 48)"
admin_password="$(openssl rand -hex 24)"
admin_path="control-$(openssl rand -hex 8)"
cat > .env <<EOF
POSTGRES_PASSWORD=$db_password
DATABASE_URL=postgresql://paste:$db_password@db:5432/paste
SESSION_SECRET=$session_secret
ADMIN_PASSWORD=$admin_password
ADMIN_PATH=$admin_path
APP_URL=${app_url%/}
HOST_PORT=3000
TRUST_PROXY=true
EOF
echo "Created .env with random secrets."
echo "Administrator URL: ${app_url%/}/$admin_path"
echo "Administrator password: $admin_password"
echo 'Save these credentials in your password manager.'
