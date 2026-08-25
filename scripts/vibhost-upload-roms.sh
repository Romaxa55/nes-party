#!/usr/bin/env bash
# Заливает public/roms/*.b64 и index.json на VibHost VM в раздачу nginx.
# Бинарники держим как base64-текст: MCP-инструмент записи умеет только UTF-8,
# а фронтенд декодирует .b64 сам (см. beginFromUrl в src/host-page.ts).
#
# Использование:
#   VHP_TOKEN=vhp_live_... ./scripts/vibhost-upload-roms.sh
#
# Пишем в обе точки: dist/ раздаётся nginx прямо сейчас, public/ переживёт
# пересборку при redeploy (Vite копирует public/ в dist). После
# vh_redeploy_project скрипт нужно прогнать заново — redeploy клонирует
# репозиторий заново, и залитых файлов в нём нет.
set -euo pipefail

: "${VHP_TOKEN:?Set VHP_TOKEN (VibHost API token, vhp_live_...)}"
PROJECT_ID="${VHP_PROJECT_ID:-025be44d-e54d-4b2e-a790-5fab9fd49b27}"
MCP_URL="${VHP_MCP_URL:-https://my.livemy.app/api/mcp/messages}"
APP_DIR="${VHP_APP_DIR:-/home/appuser/app}"
ROMS_DIR="$(cd "$(dirname "$0")/.." && pwd)/public/roms"
SITE_URL="${VHP_SITE_URL:-https://vh-prod-download-main-025be44d.livemy.site}"

upload() {
  local remote="$1" local_file="$2"
  local body
  body=$(python3 -c '
import json, sys
pid, path, local = sys.argv[1], sys.argv[2], sys.argv[3]
content = open(local, encoding="utf-8").read()
print(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
    "name": "vh_write_file_on_project",
    "arguments": {"projectId": pid, "path": path, "content": content,
                  "confirmed": True}}}))
' "$PROJECT_ID" "$remote" "$local_file")

  curl -s --max-time 90 -X POST "$MCP_URL" \
    -H "Authorization: Bearer $VHP_TOKEN" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    --data-binary "$body" |
    python3 -c '
import json, sys
raw = sys.stdin.read()
for line in raw.splitlines():
    if line.startswith("data: "):
        raw = line[6:]
        break
try:
    outer = json.loads(raw)
    inner = json.loads(outer["result"]["content"][0]["text"])
    ok = inner.get("success") is True
except Exception:
    ok = False
print(("OK  " if ok else "FAIL") + " " + sys.argv[1])
sys.exit(0 if ok else 1)
' "$remote"
}

shopt -s nullglob
files=("$ROMS_DIR"/*.b64 "$ROMS_DIR"/index.json)
if [ ${#files[@]} -eq 0 ]; then
  echo "Нет файлов в $ROMS_DIR — нечего заливать." >&2
  exit 1
fi

for f in "${files[@]}"; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  upload "$APP_DIR/dist/roms/$name" "$f"
  upload "$APP_DIR/public/roms/$name" "$f"
done

echo "Готово. Проверка: $SITE_URL/roms/index.json"
