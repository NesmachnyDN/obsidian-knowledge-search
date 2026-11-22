#!/usr/bin/env bash
# Real Obsidian desktop/CLI smoke. ALL source files and app profiles are disposable.
# This script never inspects or modifies the user's configured Vault or global app data.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app="${OBSIDIAN_EXE:-/snap/obsidian/current/app/obsidian}"
cli="${OBSIDIAN_CLI:-/snap/obsidian/current/app/obsidian-cli}"
for bin in "$app" "$cli"; do
  test -x "$bin" || { echo "HOST_SMOKE_UNAVAILABLE: Obsidian binary missing" >&2; exit 2; }
done
command -v xvfb-run >/dev/null || { echo "HOST_SMOKE_UNAVAILABLE: xvfb-run missing" >&2; exit 2; }
tmp="$(mktemp -d /tmp/oks-native-host-XXXXXXXX)"
trap 'rm -rf -- "$tmp"' EXIT
export HOME="$tmp/home"
export XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share" XDG_CACHE_HOME="$HOME/.cache"
mkdir -p "$XDG_CONFIG_HOME/obsidian" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$tmp/electron" "$tmp/vault/.obsidian/plugins/oks-synthetic-evidence"
printf '%s\n' '# Synthetic Obsidian Host' 'REQ-OKS-SMOKE: local only.' 'See [[second]].' > "$tmp/vault/first.md"
printf '%s\n' '---' 'status: active' '---' '# Second' 'Synthetic second note.' > "$tmp/vault/second.md"
cp "$repo/dist/main.js" "$repo/dist/manifest.json" "$repo/dist/standalone-worker.js" "$tmp/vault/.obsidian/plugins/oks-synthetic-evidence/"
printf '%s\n' '["oks-synthetic-evidence"]' > "$tmp/vault/.obsidian/community-plugins.json"
printf '%s\n' '{"safeMode":false}' > "$tmp/vault/.obsidian/app.json"
export tmp app cli
python3 - <<'PY'
import json,os,time
root=os.environ['tmp']
settings={'vaults':{'oks04a':{'path':root+'/vault','ts':int(time.time()*1000),'open':True}},'cli':True}
for target in [os.environ['XDG_CONFIG_HOME']+'/obsidian/obsidian.json',root+'/electron/obsidian.json']:
 with open(target,'w',encoding='utf-8') as stream: json.dump(settings,stream)
PY
fixture_sha="$(sha256sum "$tmp/vault/second.md" | cut -d' ' -f1)"
assert_contains() {
  local got="$1" expected="$2"
  if [[ "$got" != *"$expected"* ]]; then
    printf 'HOST_SMOKE_FAILURE: expected %s; got %s\n' "$expected" "$got" >&2
    return 1
  fi
}
timeout 57s xvfb-run -a -s '-screen 0 1280x800x24' bash -c '
  set -euo pipefail
  "$app" --no-sandbox --disable-gpu --user-data-dir="$tmp/electron" > "$tmp/host.log" 2>&1 &
  p=$!
  trap '\''kill "$p" 2>/dev/null || :; wait "$p" 2>/dev/null || :'\'' EXIT
  sleep 13
  version="$(timeout 8s "$cli" version)"
  [[ "$version" == *"1.15"* ]] || { echo "HOST_SMOKE_FAILURE: wrong version $version" >&2; exit 1; }
  echo "BROWSER_CAPABILITIES:"
  timeout 8s "$cli" eval "code=JSON.stringify({worker:typeof Worker,blob:typeof Blob,url:typeof URL.createObjectURL,crypto:typeof crypto,nodeBuffer:typeof Buffer})"
  timeout 8s "$cli" plugins:restrict off >/dev/null
  sleep 3
  initial="$(timeout 8s "$cli" eval "code=JSON.stringify({plugin:!!app.plugins.plugins[\"oks-synthetic-evidence\"],status:app.plugins.plugins[\"oks-synthetic-evidence\"]?.standalone?.status(),error:app.plugins.plugins[\"oks-synthetic-evidence\"]?.standaloneError})")"
  [[ "$initial" == *"\"status\":\"ready\""* && "$initial" == *"\"sources\":2"* ]] ||
    { printf "HOST_SMOKE_FAILURE: native plugin not indexed; result=%s\n" "$initial" >&2; exit 1; }
  searched="$(timeout 8s "$cli" eval "code=(async()=>{const p=app.plugins.plugins[\"oks-synthetic-evidence\"];const r=await p.standalone.search({protocolVersion:2,requestId:\"host\",query:\"REQ-OKS-SMOKE\",requestedMode:\"lexical\",limit:5});return JSON.stringify({status:r.status,hits:r.hits.length,line:r.hits[0]?.sourceLocators[0]?.lineStart,excerpt:r.hits[0]?.originalExcerpt})})()")"
  [[ "$searched" == *"\"status\":\"ok\""* && "$searched" == *"\"hits\":1"* &&
     "$searched" == *"\"line\":2"* && "$searched" == *"REQ-OKS-SMOKE: local only."* ]] ||
    { echo "HOST_SMOKE_FAILURE: lexical original evidence" >&2; exit 1; }
  timeout 8s "$cli" append path=first.md content="REQ-OKS-UPDATE: synthetic only." >/dev/null
  sleep 2
  updated="$(timeout 8s "$cli" eval "code=(async()=>{const p=app.plugins.plugins[\"oks-synthetic-evidence\"];await p.standalone.whenIdle();const r=await p.standalone.search({protocolVersion:2,requestId:\"update\",query:\"REQ-OKS-UPDATE\",requestedMode:\"lexical\",limit:5});return JSON.stringify({status:r.status,hits:r.hits.length})})()")"
  [[ "$updated" == *"\"hits\":1"* ]] ||
    { echo "HOST_SMOKE_FAILURE: Obsidian modify event" >&2; exit 1; }
  timeout 8s "$cli" plugin:reload id=oks-synthetic-evidence >/dev/null
  sleep 3
  restarted="$(timeout 8s "$cli" eval "code=JSON.stringify({status:app.plugins.plugins[\"oks-synthetic-evidence\"]?.standalone?.status(),error:app.plugins.plugins[\"oks-synthetic-evidence\"]?.standaloneError})")"
  [[ "$restarted" == *"\"status\":\"ready\""* ]] ||
    { echo "HOST_SMOKE_FAILURE: reload" >&2; exit 1; }
  printf "OBSIDIAN_HOST_SMOKE_PASS: version=%s native=ready sourceCount=2 originalLine=2 modify=pass reload=pass\n" "$version"
'
test "$(sha256sum "$tmp/vault/second.md" | cut -d' ' -f1)" = "$fixture_sha" ||
  { echo "HOST_SMOKE_FAILURE: read-only source mutated" >&2; exit 1; }
test ! -e "$tmp/vault/.obsidian/plugins/oks-synthetic-evidence/index" ||
  { echo "HOST_SMOKE_FAILURE: derived index inside Vault" >&2; exit 1; }
cache="$(find "$XDG_DATA_HOME/obsidian-knowledge-search" -name CURRENT -type f -print -quit)"
test -n "$cache" ||
  { echo "HOST_SMOKE_FAILURE: host-private CURRENT not found" >&2; exit 1; }
printf '%s\n' 'OBSIDIAN_HOST_STORAGE_PASS: private XDG index, no Vault-contained index; only synthetic fixtures used'
