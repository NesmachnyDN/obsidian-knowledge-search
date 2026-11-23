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
ulimit -c 0
export XDG_CONFIG_HOME="$tmp/home/.config" XDG_DATA_HOME="$tmp/home/.local/share" XDG_CACHE_HOME="$tmp/home/.cache"
mkdir -p "$XDG_CONFIG_HOME/obsidian" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$tmp/electron" "$tmp/vault/.obsidian/plugins/oks-synthetic-evidence"
printf '%s\n' '# Synthetic Obsidian Host' 'REQ-OKS-SMOKE: local only.' 'See [[second]].' > "$tmp/vault/first.md"
printf '%s\n' '---' 'status: active' '---' '# Second' 'Synthetic second note.' > "$tmp/vault/second.md"
# OKS-05A clean-install mode installs the verified release-shaped directory, not dist.
# Default remains the historical dist-based host smoke to avoid changing existing callers.
package_dir="${OKS_STANDALONE_PACKAGE_DIR:-$repo/dist}"
if [[ -n "${OKS_STANDALONE_PACKAGE_DIR:-}" ]]; then
  node "$repo/scripts/standalone-package.mjs" verify "$package_dir" >/dev/null ||
    { echo "HOST_SMOKE_FAILURE: package verification failed" >&2; exit 1; }
fi
for asset in main.js manifest.json standalone-worker.js; do
  test -f "$package_dir/$asset" ||
    { echo "HOST_SMOKE_FAILURE: required package asset missing: $asset" >&2; exit 1; }
  cp "$package_dir/$asset" "$tmp/vault/.obsidian/plugins/oks-synthetic-evidence/"
done
printf '%s\n' '["oks-synthetic-evidence"]' > "$tmp/vault/.obsidian/community-plugins.json"
printf '%s\n' '{"safeMode":false}' > "$tmp/vault/.obsidian/app.json"
# Separate opt-in tests use *only* synthetic sources and existing local artifacts.
if [[ "${OKS_ADVANCED_INGESTION_TEST:-0}" == 1 ]]; then
  : "${OKS_05C_PYTHON:?set trusted offline test interpreter}"
  : "${OKS_05C_TOKENIZER_SNAPSHOT:?set pinned local tokenizer snapshot}"
  : "${OKS_05C_TESSDATA:?set preinstalled RU/EN OCR data}"
  for name in policy.pdf policy.docx scan.pdf; do
    cp "$repo/benchmarks/extraction/fixtures/$name" "$tmp/vault/$name"
  done
  export OKS_05C_ENTRY="$repo/engine/advanced_ingest.py"
fi
# Only a separate opt-in synthetic test exposes local trusted host paths to the child Obsidian.
if [[ "${OKS_ADVANCED_HEALTH_TEST:-0}" == 1 ]]; then
  export OKS_ADVANCED_PYTHON="/usr/bin/python3.12"
  export OKS_ADVANCED_ENTRY="$repo/engine/persistent.py"
fi
export tmp app cli repo
python3 - <<'PY'
import json,os,time
root=os.environ['tmp']
settings={'vaults':{'oks04a':{'path':root+'/vault','ts':int(time.time()*1000),'open':True}},'cli':True}
for target in [os.environ['XDG_CONFIG_HOME']+'/obsidian/obsidian.json',root+'/electron/obsidian.json']:
 with open(target,'w',encoding='utf-8') as stream: json.dump(settings,stream)
PY
fixture_sha="$(sha256sum "$tmp/vault/second.md" | cut -d' ' -f1)"
first_sha="$(sha256sum "$tmp/vault/first.md" | cut -d' ' -f1)"; export first_sha
assert_contains() {
  local got="$1" expected="$2"
  if [[ "$got" != *"$expected"* ]]; then
    printf 'HOST_SMOKE_FAILURE: expected %s; got %s\n' "$expected" "$got" >&2
    return 1
  fi
}
host_isolation=()
if [[ "${OKS_HOST_NO_ROUTE:-0}" == 1 ]]; then
  command -v unshare >/dev/null || { echo "HOST_SMOKE_UNAVAILABLE: unshare missing" >&2; exit 2; }
  host_isolation=(unshare -Urn --)
fi
env HOME="$tmp/home" timeout 180s "${host_isolation[@]}" xvfb-run -a -e "$tmp/display.log" -s '-screen 0 1280x800x24' bash -c '
  set -euo pipefail
  "$app" --no-sandbox --disable-gpu --user-data-dir="$tmp/electron" > "$tmp/host.log" 2>&1 &
  p=$!
  trap '\''kill "$p" 2>/dev/null || :; wait "$p" 2>/dev/null || :'\'' EXIT
  sleep 13
  version="$(timeout 8s "$cli" version)" || { echo "HOST_SMOKE_FAILURE: CLI unavailable after isolated host startup" >&2; exit 1; }
  [[ "$version" == *"1.15"* ]] || { echo "HOST_SMOKE_FAILURE: wrong version $version" >&2; exit 1; }
  echo "BROWSER_CAPABILITIES:"
  timeout 8s "$cli" eval "code=JSON.stringify({worker:typeof Worker,blob:typeof Blob,url:typeof URL.createObjectURL,crypto:typeof crypto,nodeBuffer:typeof Buffer})"
  timeout 8s "$cli" plugins:restrict off >/dev/null
  sleep 3
  initial="$(timeout 8s "$cli" eval "code=JSON.stringify({plugin:!!app.plugins.plugins[\"oks-synthetic-evidence\"],status:app.plugins.plugins[\"oks-synthetic-evidence\"]?.standalone?.status(),error:app.plugins.plugins[\"oks-synthetic-evidence\"]?.standaloneError})")"
  [[ "$initial" == *"\"status\":\"ready\""* && "$initial" == *"\"sources\":2"* ]] ||
    { printf "HOST_SMOKE_FAILURE: native plugin not indexed; result=%s\n" "$initial" >&2; exit 1; }
  searched="$(timeout 8s "$cli" eval "code=(async()=>{const p=app.plugins.plugins[\"oks-synthetic-evidence\"];const r=await p.standalone.search({protocolVersion:2,requestId:\"host\",query:\"REQ-OKS-SMOKE\",requestedMode:\"lexical\",limit:5});return JSON.stringify({status:r.status,hits:r.hits.length,line:r.hits[0]?.sourceLocators[0]?.lineStart,byteStart:r.hits[0]?.sourceLocators[0]?.byteStart,sha:r.hits[0]?.sourceSha256,excerpt:r.hits[0]?.originalExcerpt})})()")"
  [[ "$searched" == *"\"status\":\"ok\""* && "$searched" == *"\"hits\":1"* &&
     "$searched" == *"\"line\":2"* && "$searched" == *"\"sha\":\"$first_sha\""* &&
     "$searched" == *"\"byteStart\":"* && "$searched" == *"REQ-OKS-SMOKE: local only."* ]] ||
    { echo "HOST_SMOKE_FAILURE: lexical original evidence" >&2; exit 1; }
  timeout 8s "$cli" append path=first.md content="REQ-OKS-UPDATE: synthetic only." >/dev/null
  sleep 2
  updated="$(timeout 8s "$cli" eval "code=(async()=>{const p=app.plugins.plugins[\"oks-synthetic-evidence\"];await p.standalone.whenIdle();const r=await p.standalone.search({protocolVersion:2,requestId:\"update\",query:\"REQ-OKS-UPDATE\",requestedMode:\"lexical\",limit:5});return JSON.stringify({status:r.status,hits:r.hits.length})})()")"
  [[ "$updated" == *"\"hits\":1"* ]] ||
    { echo "HOST_SMOKE_FAILURE: Obsidian modify event" >&2; exit 1; }
  # Create through the actual Obsidian Vault API (not through a filesystem mock).
  timeout 8s "$cli" eval "code=(async()=>{await app.vault.create(\"third.md\",\"# Third\\nREQ-OKS-CREATE-19: synthetic only.\\n\");return \"created\"})()" >/dev/null
  sleep 2
  created="$(timeout 8s "$cli" eval "code=(async()=>{const p=app.plugins.plugins[\"oks-synthetic-evidence\"];await p.standalone.whenIdle();const r=await p.standalone.search({protocolVersion:2,requestId:\"create\",query:\"REQ-OKS-CREATE-19\",requestedMode:\"lexical\",limit:5});return JSON.stringify({status:r.status,sources:p.standalone.status().sources,hits:r.hits.length,line:r.hits[0]?.sourceLocators[0]?.lineStart,sha:r.hits[0]?.sourceSha256})})()")"
  created_sha="$(sha256sum "$tmp/vault/third.md" | cut -d" " -f1)"
  [[ "$created" == *"\"status\":\"ok\""* && "$created" == *"\"sources\":3"* &&
     "$created" == *"\"hits\":1"* && "$created" == *"\"line\":2"* &&
     "$created" == *"\"sha\":\"$created_sha\""* ]] ||
    { echo "HOST_SMOKE_FAILURE: Obsidian create + raw source hash ($created)" >&2; exit 1; }
  timeout 8s "$cli" command id=oks-synthetic-evidence:open-standalone-search >/dev/null
  ui="$(timeout 45s "$cli" eval "code=$(cat "$repo/scripts/obsidian-ui-smoke.js")")"
  [[ "$ui" == *"OBSIDIAN_UI_SMOKE_PASS:"* ]] ||
    { echo "HOST_SMOKE_FAILURE: extended UI scenarios ($ui)" >&2; exit 1; }
  printf "%s\n" "$ui"
  if [[ "${OKS_ADVANCED_HEALTH_TEST:-0}" == 1 ]]; then
    advanced="$(timeout 25s "$cli" eval "code=$(cat "$repo/scripts/obsidian-advanced-smoke.js")")"
    [[ "$advanced" == *"OBSIDIAN_ADVANCED_HEALTH_PASS:"* ]] ||
      { echo "HOST_SMOKE_FAILURE: advanced explicit health scenario ($advanced)" >&2; exit 1; }
    printf "%s\n" "$advanced"
  fi
  timeout 8s "$cli" command id=oks-synthetic-evidence:open-first-search-source >/dev/null
  sleep 1
  navigation="$(timeout 8s "$cli" eval "code=JSON.stringify({path:app.workspace.getMostRecentLeaf()?.view?.file?.path,selected:app.workspace.getMostRecentLeaf()?.view?.editor?.getSelection()})")"
  [[ "$navigation" == *"first.md"* && "$navigation" == *"REQ-OKS-SMOKE: local only."* ]] ||
    { echo "HOST_SMOKE_FAILURE: source command selection" >&2; exit 1; }
  if [[ "${OKS_ADVANCED_INGESTION_TEST:-0}" == 1 ]]; then
    ingest="$(timeout 130s "$cli" eval "code=$(cat "$repo/scripts/obsidian-ingestion-smoke.js")")"
    [[ "$ingest" == *"OBSIDIAN_ADVANCED_INGESTION_PASS:"* ]] ||
      { echo "HOST_SMOKE_FAILURE: real opt-in extraction ($ingest)" >&2; exit 1; }
    printf "%s\n" "$ingest"
  fi
  before_reload="$(timeout 8s "$cli" eval "code=(globalThis.__oksPreviousParser=app.plugins.plugins[\"oks-synthetic-evidence\"].standalone.parser,app.plugins.plugins[\"oks-synthetic-evidence\"].standalone.status().generationId)")"
  before_id="$(printf "%s" "$before_reload" | grep -oE "[0-9a-f]{64}" | head -1)"
  test -n "$before_id" || { echo "HOST_SMOKE_FAILURE: missing before-reload generation" >&2; exit 1; }
  timeout 8s "$cli" plugin:reload id=oks-synthetic-evidence >/dev/null
  sleep 3
  restarted="$(timeout 8s "$cli" eval "code=JSON.stringify({status:app.plugins.plugins[\"oks-synthetic-evidence\"]?.standalone?.status(),error:app.plugins.plugins[\"oks-synthetic-evidence\"]?.standaloneError})")"
  [[ "$restarted" == *"\"status\":\"ready\""* && "$restarted" == *"\"sources\":3"* ]] ||
    { echo "HOST_SMOKE_FAILURE: reload" >&2; exit 1; }
  after_reload="$(timeout 8s "$cli" eval "code=JSON.stringify({generationId:app.plugins.plugins[\"oks-synthetic-evidence\"].standalone.status().generationId,oldWorkerStopped:globalThis.__oksPreviousParser?.stopped})")"
  [[ "$after_reload" == *"$before_id"* && "$after_reload" == *"\"oldWorkerStopped\":true"* ]] ||
    { echo "HOST_SMOKE_FAILURE: durable generation or worker unload ($before_reload, $after_reload)" >&2; exit 1; }
  printf "OBSIDIAN_HOST_SMOKE_PASS: version=%s native=ready sourceCount=3 originalLine=2 sha256=pass modify=pass create=pass reload=pass oldWorkerStopped=true ui=pass commandNavigation=pass\n" "$version"
' || {
  if test -f "$tmp/display.log" && grep -qE 'Cannot establish any listening sockets|failed to bind listener' "$tmp/display.log"; then
    echo 'HOST_SMOKE_UNAVAILABLE: isolated display cannot bind local sockets (sandbox restriction)' >&2
  else
    echo 'HOST_SMOKE_FAILURE: isolated Obsidian scenario failed or timed out; no host pass claimed' >&2
  fi
  exit 1
}
test "$(sha256sum "$tmp/vault/second.md" | cut -d' ' -f1)" = "$fixture_sha" ||
  { echo "HOST_SMOKE_FAILURE: read-only source mutated" >&2; exit 1; }
test ! -e "$tmp/vault/.obsidian/plugins/oks-synthetic-evidence/index" ||
  { echo "HOST_SMOKE_FAILURE: derived index inside Vault" >&2; exit 1; }
cache="$(find "$XDG_DATA_HOME/obsidian-knowledge-search" -name CURRENT -type f -print -quit)"
test -n "$cache" ||
  { echo "HOST_SMOKE_FAILURE: host-private CURRENT not found" >&2; exit 1; }
printf '%s\n' 'OBSIDIAN_HOST_STORAGE_PASS: private XDG index, no Vault-contained index; only synthetic fixtures used'
# Package uninstallation from an explicitly disposable fixture must not remove source notes.
if [[ -n "${OKS_STANDALONE_PACKAGE_DIR:-}" ]]; then
  rm -rf -- "$tmp/vault/.obsidian/plugins/oks-synthetic-evidence"
  test -f "$tmp/vault/first.md" && test -f "$tmp/vault/second.md" ||
    { echo "HOST_SMOKE_FAILURE: uninstall removed original sources" >&2; exit 1; }
  test "$(sha256sum "$tmp/vault/second.md" | cut -d' ' -f1)" = "$fixture_sha" ||
    { echo "HOST_SMOKE_FAILURE: uninstall changed original bytes" >&2; exit 1; }
  printf '%s\n' 'OBSIDIAN_HOST_CLEAN_REMOVAL_PASS: packaged plugin files removed; source Markdown preserved'
fi
