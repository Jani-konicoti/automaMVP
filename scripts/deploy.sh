#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."

git pull --ff-only

if [ ! -f .env.production ]; then
  echo "Manca .env.production. Copia .env.production.example e compilalo prima del deploy." >&2
  exit 1
fi

if grep -Eq '^CLOUDFLARE_TUNNEL_TOKEN=.+$' .env.production; then
  docker compose --env-file .env.production --profile tunnel up -d --build --remove-orphans
else
  docker compose --env-file .env.production up -d --build --remove-orphans
fi

docker compose --env-file .env.production ps
