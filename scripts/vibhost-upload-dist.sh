#!/usr/bin/env bash
# Заливает локальную прод-сборку (dist/) на VibHost VM в раздачу nginx.
# Нужен, потому что vh_redeploy_project перезапускает сервис, но не делает
# git pull + npm run build — код на VM остаётся старым. Все файлы сборки
# текстовые (HTML/CSS/JS), поэтому проходят через vh_write_file_on_project.
#
# Использование:
#   npm run build && VHP_TOKEN=vhp_live_... ./scripts/vibhost-upload-dist.sh
#
# Ромы (/roms) не трогает — их заливает vibhost-upload-roms.sh.
set -euo pipefail

: "${VHP_TOKEN:?Set VHP_TOKEN (VibHost API token, vhp_live_...)}"
PROJECT_ID="${VHP_PROJECT_ID:-025be44d-e54d-4b2e-a790-5fab9fd49b27}"
MCP_URL="${VHP_MCP_URL:-https://my.livemy.app/api/mcp/messages}"
APP_DIR="${VHP_APP_DIR:-/home/appuser/app}"
DIST_DIR="$(cd "$(dirname "$0")/.." && pwd)/dist"
SITE_URL="${VHP_SITE_URL:-https://vh-prod-download-main-025be44d.livemy.site}"

[ -d "$DIST_DIR" ] || { echo "Нет $DIST_DIR — сначала npm run build" >&2; exit 1; }

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
data = "\n".join(l[6:] for l in raw.splitlines() if l.startswith("data: ")) or raw
try:
    outer = json.loads(data, strict=False)
    inner = json.loads(outer["result"]["content"][0]["text"], strict=False)
    ok = inner.get("success") is True
except Exception:
    ok = False
print(("OK  " if ok else "FAIL") + " " + sys.argv[1])
sys.exit(0 if ok else 1)
' "$remote"
}

# Все файлы сборки, с сохранением структуры каталогов. Каталог roms/
# пропускаем: он попадает в dist из локального public/ и содержит бинарники —
# ромы на VM заливает vibhost-upload-roms.sh.
find "$DIST_DIR" -type f ! -path "*/roms/*" | while read -r f; do
  rel="${f#"$DIST_DIR"/}"
  upload "$APP_DIR/dist/$rel" "$f"
done

echo "Готово. Проверка: $SITE_URL/host.html"
