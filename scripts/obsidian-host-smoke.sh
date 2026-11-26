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
# L10N modes are independent, basic-only acceptance scenarios. Reject unsafe or
# conflicting flags before creating a profile or starting any host process.
if [[ "${OKS_06UX_L10N_SWITCH_TEST:-0}" == 1 || "${OKS_06UX_L10N_RU_TEST:-0}" == 1 ]]; then
  [[ "${OKS_HOST_NO_ROUTE:-0}" == 1 && -n "${OKS_STANDALONE_PACKAGE_DIR:-}" &&
     -z "${OKS_STANDALONE_PREVIOUS_PACKAGE_DIR:-}" && -z "${OKS_06UX_VISUAL_DIR:-}" &&
     "${OKS_AI_RERANK_TEST:-0}" == 0 && "${OKS_ADVANCED_HEALTH_TEST:-0}" == 0 &&
     "${OKS_ADVANCED_INGESTION_TEST:-0}" == 0 && "${OKS_ADVANCED_RETRIEVAL_TEST:-0}" == 0 &&
     "${OKS_06UX_TEST:-0}" == 0 ]] ||
    { echo "HOST_SMOKE_FAILURE: L10N requires isolated verified package and basic-only mode" >&2; exit 2; }
  [[ "${OKS_06UX_L10N_SWITCH_TEST:-0}" != 1 || "${OKS_06UX_L10N_RU_TEST:-0}" != 1 ]] ||
    { echo "HOST_SMOKE_FAILURE: L10N scenarios must run separately" >&2; exit 2; }
fi
# The targeted native-chat scenario is independent of cumulative host acceptance.
# Require the verified package and a fresh isolated no-route profile.
if [[ "${OKS_NATIVE_CHAT_TEST:-0}" == 1 ]]; then
  [[ "${OKS_HOST_NO_ROUTE:-0}" == 1 && -n "${OKS_STANDALONE_PACKAGE_DIR:-}" && -z "${OKS_STANDALONE_PREVIOUS_PACKAGE_DIR:-}" &&
     -z "${OKS_06UX_VISUAL_DIR:-}" && -z "${OKS_06UX_L10N_RU_VISUAL_DIR:-}" && "${OKS_AI_RERANK_TEST:-0}" == 0 && "${OKS_ADVANCED_HEALTH_TEST:-0}" == 0 &&
     "${OKS_ADVANCED_INGESTION_TEST:-0}" == 0 && "${OKS_ADVANCED_RETRIEVAL_TEST:-0}" == 0 && "${OKS_06UX_TEST:-0}" == 0 &&
     "${OKS_06UX_L10N_SWITCH_TEST:-0}" == 0 && "${OKS_06UX_L10N_RU_TEST:-0}" == 0 ]] ||
    { echo "HOST_SMOKE_FAILURE: native chat requires isolated verified package and separate mode" >&2; exit 2; }
fi
# Graph acceptance is an isolated Basic-only run against the verified package.
if [[ "${OKS_06B_GRAPH_TEST:-0}" == 1 ]]; then
  [[ "${OKS_HOST_NO_ROUTE:-0}" == 1 && -n "${OKS_STANDALONE_PACKAGE_DIR:-}" &&
     -z "${OKS_STANDALONE_PREVIOUS_PACKAGE_DIR:-}" && -z "${OKS_06UX_VISUAL_DIR:-}" &&
     -z "${OKS_06UX_L10N_RU_VISUAL_DIR:-}" && "${OKS_NATIVE_CHAT_TEST:-0}" == 0 &&
     "${OKS_AI_RERANK_TEST:-0}" == 0 && "${OKS_ADVANCED_HEALTH_TEST:-0}" == 0 &&
     "${OKS_ADVANCED_INGESTION_TEST:-0}" == 0 && "${OKS_ADVANCED_RETRIEVAL_TEST:-0}" == 0 &&
     "${OKS_06UX_TEST:-0}" == 0 && "${OKS_06UX_L10N_SWITCH_TEST:-0}" == 0 &&
     "${OKS_06UX_L10N_RU_TEST:-0}" == 0 ]] ||
    { echo "HOST_SMOKE_FAILURE: graph requires isolated verified package and separate mode" >&2; exit 2; }
fi
if [[ "${OKS_06B4_HOST_TEST:-0}" == 1 && "${OKS_06B_GRAPH_TEST:-0}" != 1 ]]; then
  echo "HOST_SMOKE_FAILURE: graph stress requires isolated graph mode" >&2; exit 2
fi
# POLICY.2e3a evidence-only test; never combine with another host scenario.
# Direct-IP denial is a separate, test-only fallback preserving real system UIDs.
if [[ "${OKS_POLICY_2E3A_NO_IP:-0}" == 1 ]]; then
  [[ "${OKS_POLICY_2E3A_TEST:-0}" == 1 && "${OKS_HOST_NO_ROUTE:-0}" == 0 ]] ||
    { echo "HOST_SMOKE_FAILURE: no-IP mode requires separate lifecycle scenario" >&2; exit 2; }
  export OKS_POLICY_2E3A_NO_IP
  exec </dev/null
fi
if [[ "${OKS_POLICY_2E3A_TEST:-0}" == 1 ]]; then
  [[ ( "${OKS_HOST_NO_ROUTE:-0}" == 1 || "${OKS_POLICY_2E3A_NO_IP:-0}" == 1 ) && -n "${OKS_STANDALONE_PACKAGE_DIR:-}" &&
     -z "${OKS_STANDALONE_PREVIOUS_PACKAGE_DIR:-}" && -z "${OKS_06UX_VISUAL_DIR:-}" &&
     -z "${OKS_06UX_L10N_RU_VISUAL_DIR:-}" && "${OKS_NATIVE_CHAT_TEST:-0}" == 0 &&
     "${OKS_06B_GRAPH_TEST:-0}" == 0 && "${OKS_06B4_HOST_TEST:-0}" == 0 &&
     "${OKS_AI_RERANK_TEST:-0}" == 0 && "${OKS_ADVANCED_HEALTH_TEST:-0}" == 0 &&
     "${OKS_ADVANCED_INGESTION_TEST:-0}" == 0 && "${OKS_ADVANCED_RETRIEVAL_TEST:-0}" == 0 &&
     "${OKS_06UX_TEST:-0}" == 0 && "${OKS_06UX_L10N_SWITCH_TEST:-0}" == 0 &&
     "${OKS_06UX_L10N_RU_TEST:-0}" == 0 ]] ||
    { echo "HOST_SMOKE_FAILURE: lifecycle requires isolated verified package and separate mode" >&2; exit 2; }
  export OKS_POLICY_2E3A_TEST
  umask 077
fi
tmp="$(mktemp -d /tmp/oks-native-host-XXXXXXXX)"
trap 'rm -rf -- "$tmp"' EXIT
if [[ "${OKS_POLICY_2E3A_TEST:-0}" == 1 ]]; then
  "$repo/node_modules/.bin/esbuild" "$repo/scripts/obsidian-lifecycle-host-entry.ts" --bundle \
    --platform=node --format=cjs --target=es2022 --outfile="$tmp/lifecycle-probe.cjs"
fi
if [[ "${OKS_06B4_HOST_TEST:-0}" == 1 ]]; then
  cp "$repo/benchmarks/graph/v1/corpus.json" "$tmp/graph-corpus.json"
  cp "$repo/benchmarks/graph/v1/manifest.json" "$tmp/graph-manifest.json"
fi
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
previous_package_dir="${OKS_STANDALONE_PREVIOUS_PACKAGE_DIR:-}"
install_dir="$package_dir"
if [[ -n "$previous_package_dir" ]]; then
  [[ -n "${OKS_STANDALONE_PACKAGE_DIR:-}" && "${OKS_HOST_NO_ROUTE:-0}" == 1 &&
     "${OKS_AI_RERANK_TEST:-0}" == 0 && "${OKS_ADVANCED_HEALTH_TEST:-0}" == 0 &&
     "${OKS_ADVANCED_INGESTION_TEST:-0}" == 0 && "${OKS_ADVANCED_RETRIEVAL_TEST:-0}" == 0 ]] ||
    { echo "HOST_SMOKE_FAILURE: transition requires verified packages and isolated basic-only mode" >&2; exit 2; }
  node "$repo/scripts/standalone-package.mjs" verify "$previous_package_dir" >/dev/null
  if cmp -s "$previous_package_dir/main.js" "$package_dir/main.js"; then
    echo "HOST_SMOKE_FAILURE: transition requires distinct bundles" >&2; exit 2
  fi
  install_dir="$previous_package_dir"
fi
for asset in main.js manifest.json standalone-worker.js; do
  test -f "$install_dir/$asset" ||
    { echo "HOST_SMOKE_FAILURE: required package asset missing: $asset" >&2; exit 1; }
  cp "$install_dir/$asset" "$tmp/vault/.obsidian/plugins/oks-synthetic-evidence/"
done
printf '%s\n' '["oks-synthetic-evidence"]' > "$tmp/vault/.obsidian/community-plugins.json"
printf '%s\n' '{"safeMode":false}' > "$tmp/vault/.obsidian/app.json"
# Separate opt-in tests use *only* synthetic sources and existing local artifacts.
if [[ "${OKS_ADVANCED_INGESTION_TEST:-0}" == 1 || "${OKS_ADVANCED_RETRIEVAL_TEST:-0}" == 1 ]]; then
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
# Xvfb is an X11 display; do not inherit a Wayland/DBus desktop session.
export XDG_RUNTIME_DIR="$tmp/runtime" XDG_SESSION_TYPE=x11 ELECTRON_OZONE_PLATFORM_HINT=x11
mkdir -m 700 "$XDG_RUNTIME_DIR"
unset WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS
ru_visual_dir="${OKS_06UX_L10N_RU_VISUAL_DIR:-}"
if [[ -n "$ru_visual_dir" ]]; then
  [[ "$ru_visual_dir" = /* && ! -e "$ru_visual_dir" && ! -L "$ru_visual_dir" &&
    "${OKS_06UX_L10N_RU_TEST:-0}" == 1 && "${OKS_HOST_NO_ROUTE:-0}" == 1 &&
    -n "${OKS_STANDALONE_PACKAGE_DIR:-}" ]] ||
    { echo "HOST_SMOKE_FAILURE: RU screenshots require a fresh absolute output directory and isolated packaged test" >&2; exit 2; }
  mkdir -m 700 "$ru_visual_dir"
  export OKS_06UX_L10N_RU_VISUAL=1
fi
visual_dir="${OKS_06UX_VISUAL_DIR:-}"
if [[ -n "$visual_dir" ]]; then
  [[ "$visual_dir" = /* && ! -e "$visual_dir" && ! -L "$visual_dir" &&
     "${OKS_06UX_TEST:-0}" == 1 && "${OKS_HOST_NO_ROUTE:-0}" == 1 &&
     -n "${OKS_STANDALONE_PACKAGE_DIR:-}" && -z "$previous_package_dir" ]] ||
    { echo "HOST_SMOKE_FAILURE: visual acceptance requires new absolute evidence directory, verified package and no-route UX test" >&2; exit 2; }
  mkdir -m 700 "$visual_dir" "$tmp/visual"
  export OKS_06UX_VISUAL=1
fi
export tmp app cli repo package_dir previous_package_dir
python3 - <<'PY'
import json,os,time
root=os.environ['tmp']
settings={'vaults':{'oks04a':{'path':root+'/vault','ts':int(time.time()*1000),'open':True}},'cli':True}
for target in [os.environ['XDG_CONFIG_HOME']+'/obsidian/obsidian.json',root+'/electron/obsidian.json']:
 with open(target,'w',encoding='utf-8') as stream: json.dump(settings,stream)
PY
fixture_sha="$(sha256sum "$tmp/vault/second.md" | cut -d' ' -f1)"
first_sha="$(sha256sum "$tmp/vault/first.md" | cut -d' ' -f1)"; export first_sha fixture_sha
assert_contains() {
  local got="$1" expected="$2"
  if [[ "$got" != *"$expected"* ]]; then
    printf 'HOST_SMOKE_FAILURE: expected %s; got %s\n' "$expected" "$got" >&2
    return 1
  fi
}
host_isolation=()
if [[ "${OKS_AI_RERANK_TEST:-0}" == 1 && "${OKS_HOST_NO_ROUTE:-0}" != 1 ]]; then
  echo 'HOST_SMOKE_FAILURE: rerank fixture requires isolated no-route namespace' >&2; exit 2
fi
if [[ "${OKS_HOST_NO_ROUTE:-0}" == 1 ]]; then
  command -v unshare >/dev/null || { echo "HOST_SMOKE_UNAVAILABLE: unshare missing" >&2; exit 2; }
  host_isolation=(unshare -Urn --)
elif [[ "${OKS_POLICY_2E3A_NO_IP:-0}" == 1 ]]; then
  host_isolation=(python3 -I -B "$repo/scripts/obsidian-lifecycle-no-ip.py" --)
fi
env HOME="$tmp/home" timeout "${OKS_HOST_TIMEOUT_SECONDS:-180}"s "${host_isolation[@]}" xvfb-run -a -e "$tmp/display.log" -s '-screen 0 1280x800x24' bash -c '
  set -euo pipefail
  p=""
  mock_pid=""
  cleanup() {
    local status=$?
    trap - EXIT
    if [[ -n "$p" ]]; then kill "$p" 2>/dev/null || :; fi
    if [[ -n "$mock_pid" ]]; then kill "$mock_pid" 2>/dev/null || :; fi
    if [[ -n "$p" ]]; then wait "$p" 2>/dev/null || :; fi
    if [[ -n "$mock_pid" ]]; then
      wait "$mock_pid" 2>/dev/null || :
      if kill -0 "$mock_pid" 2>/dev/null; then
        echo "HOST_SMOKE_FAILURE: fixture not reaped" >&2; status=1
      else
        echo "OBSIDIAN_RERANK_FIXTURE_CLEANUP_PASS"
      fi
    fi
    exit "$status"
  }
  trap cleanup EXIT
  trap "exit 130" INT
  trap "exit 143" TERM
  # Settings checks exercise only a synthetic API on the isolated loopback.
  if [[ "${OKS_HOST_NO_ROUTE:-0}" == 1 && ( "${OKS_06UX_TEST:-0}" == 1 || "${OKS_06UX_L10N_RU_TEST:-0}" == 1 ) ]]; then
    ip link set lo up
    test "$(ip -o link show | wc -l)" -eq 1
    test -z "$(ip route show default)"
  fi
  if [[ "${OKS_AI_RERANK_TEST:-0}" == 1 || "${OKS_NATIVE_CHAT_TEST:-0}" == 1 ]]; then
    ip link set lo up
    test "$(ip -o link show | wc -l)" -eq 1
    test -z "$(ip route show default)"
    fixture_args=()
    if [[ "${OKS_NATIVE_CHAT_TEST:-0}" == 1 ]]; then fixture_args+=(--native-chat); fi
    python3 "$repo/scripts/obsidian-rerank-fixture.py" "$tmp/rerank-ready" "${fixture_args[@]}" &
    mock_pid=$!
    for _ in {1..50}; do test ! -f "$tmp/rerank-ready" || break; sleep .1; done
    test -f "$tmp/rerank-ready"
  fi
  "$app" --no-sandbox --disable-gpu --ozone-platform=x11 --user-data-dir="$tmp/electron" > "$tmp/host.log" 2>&1 &
  p=$!
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
  if [[ "${OKS_POLICY_2E3A_TEST:-0}" == 1 ]]; then
    if [[ "${OKS_HOST_NO_ROUTE:-0}" == 1 ]]; then
      test "$(ip -o link show | wc -l)" -eq 1
      test -z "$(ip route show default)"
    else
      python3 -I -B "$repo/scripts/obsidian-lifecycle-no-ip.py" --verify-inherited
    fi
    lifecycle="$(timeout 40s "$cli" eval "code=$(cat "$repo/scripts/obsidian-lifecycle-host-smoke.js")")"
    [[ "$lifecycle" == *"OBSIDIAN_POLICY_2E3A_PASS:"* ]] ||
      { echo "HOST_SMOKE_FAILURE: lifecycle capability ($lifecycle)" >&2; exit 1; }
    printf "%s\n" "$lifecycle"
    exit 0
  fi
  if [[ "${OKS_NATIVE_CHAT_TEST:-0}" == 1 ]]; then
    chat="$(timeout 65s "$cli" eval "code=$(cat "$repo/scripts/obsidian-native-chat-smoke.js")")"
    [[ "$chat" == *"OBSIDIAN_NATIVE_CHAT_PASS:"* ]] ||
      { echo "HOST_SMOKE_FAILURE: native chat ($chat)" >&2; exit 1; }
    printf "%s\n" "$chat"
    test "$(cat "$tmp/rerank-ready.generation-count")" = 2 ||
      { echo "HOST_SMOKE_FAILURE: expected exactly two authorized native chat requests" >&2; exit 1; }
    echo "OBSIDIAN_NATIVE_CHAT_WIRE_PASS: exactly two authorized fixture requests; first alpha+beta, second alpha only"
    exit 0
  fi
  if [[ "${OKS_06UX_L10N_SWITCH_TEST:-0}" == 1 ]]; then
    language_phase() {
      local action="$1" result
      timeout 8s "$cli" eval "code=(globalThis.__oksNativeLanguageAction=\"$action\",true)" >/dev/null
      result="$(timeout 25s "$cli" eval "code=$(cat "$repo/scripts/obsidian-settings-native-language-smoke.js")")"
      [[ "$result" == *"OBSIDIAN_NATIVE_LANGUAGE_PASS:"* ]] ||
        { echo "HOST_SMOKE_FAILURE: native language $action ($result)" >&2; exit 1; }
      printf "%s\n" "$result"
    }
    native_restart() {
      # First allow Obsidian native visible Relaunch action to apply the locale
      # and persist it in its isolated application profile.
      sleep 3
      local old_p="$p"
      # Then test durability across a full host process restart using that
      # same disposable profile. The test controls only the process it launched.
      if kill -0 "$p" 2>/dev/null; then
        [[ "$(ps -p "$p" -o args=)" == *"--user-data-dir=$tmp/electron"* ]] ||
          { echo "HOST_SMOKE_FAILURE: isolated host process identity mismatch" >&2; exit 1; }
        kill "$p" 2>/dev/null || :
      fi
      wait "$p" 2>/dev/null || :
      if kill -0 "$old_p" 2>/dev/null; then
        echo "HOST_SMOKE_FAILURE: previous isolated host still alive" >&2; exit 1
      fi
      "$app" --no-sandbox --disable-gpu --ozone-platform=x11 --user-data-dir="$tmp/electron" > "$tmp/host-restarted.log" 2>&1 &
      p=$!
      sleep 13
      [[ "$p" != "$old_p" && "$(ps -p "$p" -o args=)" == *"--user-data-dir=$tmp/electron"* ]] ||
        { echo "HOST_SMOKE_FAILURE: restarted isolated host identity mismatch" >&2; exit 1; }
      timeout 8s "$cli" version >/dev/null
      timeout 8s "$cli" plugins:restrict off >/dev/null
      sleep 3
    }
    language_phase seed
    language_phase verify-en
    language_phase set-ru
    sleep 3
    language_phase verify-ru
    native_restart
    language_phase verify-ru
    language_phase set-en
    sleep 3
    language_phase verify-en
    native_restart
    language_phase verify-en
    echo "OBSIDIAN_NATIVE_LANGUAGE_SWITCH_PASS: EN to RU to EN via actual General selector and host restarts"
    exit 0
  fi
  if [[ "${OKS_06UX_L10N_RU_TEST:-0}" == 1 ]]; then
    # Native host locale must be Russian for this isolated-synthetic test.
    locale_test="$(timeout 30s "$cli" eval "code=$(cat "$repo/scripts/obsidian-settings-ru-smoke.js")")"
    [[ "$locale_test" == *"OBSIDIAN_SETTINGS_RU_PASS:"* ]] ||
      { echo "HOST_SMOKE_FAILURE: Russian Settings locale ($locale_test)" >&2; exit 1; }
    printf "%s\n" "$locale_test"
    exit 0
  fi
  if [[ "${OKS_06UX_VISUAL:-0}" == 1 ]]; then
    visual="$(timeout 85s "$cli" eval "code=$(cat "$repo/scripts/obsidian-settings-visual-smoke.js")")"
    [[ "$visual" == *"OBSIDIAN_SETTINGS_VISUAL_PASS:"* ]] ||
      { echo "HOST_SMOKE_FAILURE: real Settings visual acceptance ($visual)" >&2; exit 1; }
    printf "%s\n" "$visual"
  fi
  if [[ -n "$previous_package_dir" ]]; then
    # Test only the disposable profile: D7 -> D8 -> D7 -> D8.
    transition_state() {
      timeout 8s "$cli" eval "code=(async()=>{const p=app.plugins.plugins[\"oks-synthetic-evidence\"];await p.standalone.whenIdle();const r=await p.standalone.search({protocolVersion:2,requestId:\"transition\",query:\"REQ-OKS-SMOKE\",requestedMode:\"lexical\",limit:5});return JSON.stringify({ready:p.standalone.status().status===\"ready\",generation:p.standalone.status().generationId,denseApi:!!p.denseApi,oldWorkerStopped:globalThis.__oksTransitionParser?.stopped===true,basic:r.status===\"ok\"&&r.hits.length===1&&r.hits[0].sourceSha256===\"$first_sha\",disabled:Object.values(p.settings.ai).every(x=>x.state===\"disabled\")&&!p.settings.ingestion.enabled})})()"
    }
    # R1 and R2 both retain the D8 API; the older D7/D8 test stays unchanged.
    previous_dense=false
    if [[ "${OKS_R1_R2_TRANSITION_TEST:-0}" == 1 ]]; then previous_dense=true; fi
    old_state="$(transition_state)"
    generation="$(printf "%s" "$old_state" | grep -oE "[0-9a-f]{64}" | head -1)"
    test -n "$generation"
    [[ "$old_state" == *"\"denseApi\":$previous_dense"* && "$old_state" == *"\"basic\":true"* && "$old_state" == *"\"disabled\":true"* ]]
    transition() {
      local dir="$1" expected="$2" state asset
      timeout 8s "$cli" eval "code=(globalThis.__oksTransitionParser=app.plugins.plugins[\"oks-synthetic-evidence\"].standalone.parser,true)" >/dev/null
      for asset in main.js manifest.json standalone-worker.js; do
        cp "$dir/$asset" "$tmp/vault/.obsidian/plugins/oks-synthetic-evidence/$asset"
        cmp -s "$dir/$asset" "$tmp/vault/.obsidian/plugins/oks-synthetic-evidence/$asset"
      done
      timeout 8s "$cli" plugin:reload id=oks-synthetic-evidence >/dev/null
      sleep 3
      state="$(transition_state)"
      [[ "$state" == *"\"denseApi\":$expected"* && "$state" == *"\"ready\":true"* &&
         "$state" == *"\"oldWorkerStopped\":true"* && "$state" == *"\"basic\":true"* &&
         "$state" == *"\"disabled\":true"* && "$state" == *"\"generation\":\"$generation\""* ]] ||
        { echo "HOST_SMOKE_FAILURE: package transition ($state)" >&2; exit 1; }
      test "$(sha256sum "$tmp/vault/first.md" | cut -d" " -f1)" = "$first_sha"
      test "$(sha256sum "$tmp/vault/second.md" | cut -d" " -f1)" = "$fixture_sha"
    }
    transition "$package_dir" true
    transition "$previous_package_dir" "$previous_dense"
    transition "$package_dir" true
    echo "OBSIDIAN_PACKAGE_TRANSITION_PASS: update rollback re-update; generation, original hashes, basic search, default-off AI and prior-worker shutdown verified"
  fi
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
  if [[ "${OKS_06B_GRAPH_TEST:-0}" == 1 ]]; then
    graph="$(timeout 50s "$cli" eval "code=$(cat "$repo/scripts/obsidian-graph-smoke.js")")"
    [[ "$graph" == *"OBSIDIAN_GRAPH_HOST_BEFORE_RELOAD_PASS:"* ]] ||
      { echo "HOST_SMOKE_FAILURE: graph before reload ($graph)" >&2; exit 1; }
    printf "%s\n" "$graph"
    timeout 8s "$cli" plugin:reload id=oks-synthetic-evidence >/dev/null
    sleep 3
    graph="$(timeout 50s "$cli" eval "code=$(cat "$repo/scripts/obsidian-graph-smoke.js")")"
    [[ "$graph" == *"OBSIDIAN_GRAPH_HOST_PASS:"* ]] ||
      { echo "HOST_SMOKE_FAILURE: graph after reload ($graph)" >&2; exit 1; }
    printf "%s\n" "$graph"
  fi
  if [[ "${OKS_06B4_HOST_TEST:-0}" == 1 ]]; then
    stress="$(timeout 120s "$cli" eval "code=$(cat "$repo/scripts/obsidian-graph-stress-smoke.js")")"
    [[ "$stress" == *"OBSIDIAN_GRAPH_STRESS_PASS:"* ]] ||
      { echo "HOST_SMOKE_FAILURE: graph stress ($stress)" >&2; exit 1; }
    printf "%s\n" "$stress"
  fi
  if [[ "${OKS_06UX_TEST:-0}" == 1 ]]; then
    settings_ux="$(timeout 45s "$cli" eval "code=$(cat "$repo/scripts/obsidian-settings-ux-smoke.js")")"
    [[ "$settings_ux" == *"OBSIDIAN_SETTINGS_UX_PASS:"* ]] || {
      echo "HOST_SMOKE_FAILURE: OKS-06UX actual Settings acceptance ($settings_ux)" >&2; exit 1; }
    printf "%s\n" "$settings_ux"
  fi
  if [[ "${OKS_AI_RERANK_TEST:-0}" == 1 ]]; then
    rerank="$(timeout 30s "$cli" eval "code=$(cat "$repo/scripts/obsidian-rerank-smoke.js")")"
    [[ "$rerank" == *"OBSIDIAN_RERANK_FIXTURE_PASS:"* ]] || {
      echo "HOST_SMOKE_FAILURE: isolated rerank UI fixture ($rerank)" >&2; exit 1; }
    printf "%s\n" "$rerank"
    generation="$(timeout 40s "$cli" eval "code=$(cat "$repo/scripts/obsidian-generation-smoke.js")")"
    [[ "$generation" == *"OBSIDIAN_GENERATION_FIXTURE_PASS:"* ]] || {
      echo "HOST_SMOKE_FAILURE: isolated generation UI fixture ($generation)" >&2; exit 1; }
    printf "%s\n" "$generation"
    dense="$(timeout 65s "$cli" eval "code=$(cat "$repo/scripts/obsidian-dense-smoke.js")")"
    [[ "$dense" == *"OBSIDIAN_DENSE_FIXTURE_PASS:"* ]] || {
      echo "HOST_SMOKE_FAILURE: isolated API-dense UI fixture ($dense)" >&2; exit 1; }
    printf "%s\n" "$dense"
  fi
  if [[ "${OKS_ADVANCED_HEALTH_TEST:-0}" == 1 ]]; then
    advanced="$(timeout 25s "$cli" eval "code=$(cat "$repo/scripts/obsidian-advanced-smoke.js")")"
    [[ "$advanced" == *"OBSIDIAN_ADVANCED_HEALTH_PASS:"* ]] ||
      { echo "HOST_SMOKE_FAILURE: advanced explicit health scenario ($advanced)" >&2; exit 1; }
    printf "%s\n" "$advanced"
  fi
  # Settings tests legitimately invalidate the prior UI response; establish a fresh
  # real search result before checking the command exact source navigation.
  command_source="$(timeout 20s "$cli" eval "code=$(cat "$repo/scripts/obsidian-host-command-source.js")")"
  [[ "$command_source" == *"OBSIDIAN_HOST_COMMAND_SOURCE_READY:"* ]] ||
    { echo "HOST_SMOKE_FAILURE: source-command search precondition ($command_source)" >&2; exit 1; }
  printf "%s\n" "$command_source"
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
  if [[ "${OKS_ADVANCED_RETRIEVAL_TEST:-0}" == 1 ]]; then
    retrieval="$(timeout 250s "$cli" eval "code=$(cat "$repo/scripts/obsidian-retrieval-smoke.js")")"
    [[ "$retrieval" == *"OBSIDIAN_ADVANCED_RETRIEVAL_PASS:"* ]] ||
      { echo "HOST_SMOKE_FAILURE: Advanced model-backed UI integration ($retrieval)" >&2; exit 1; }
    printf "%s\n" "$retrieval"
  fi
  before_reload="$(timeout 8s "$cli" eval "code=(globalThis.__oksPreviousParser=app.plugins.plugins[\"oks-synthetic-evidence\"].standalone.parser,app.plugins.plugins[\"oks-synthetic-evidence\"].standalone.status().generationId)")"
  before_id="$(printf "%s" "$before_reload" | grep -oE "[0-9a-f]{64}" | head -1)"
  test -n "$before_id" || { echo "HOST_SMOKE_FAILURE: missing before-reload generation" >&2; exit 1; }
  if [[ "${OKS_06UX_TEST:-0}" == 1 && "${OKS_HOST_NO_ROUTE:-0}" == 1 ]]; then
    unload_ready="$(timeout 20s "$cli" eval "code=$(cat "$repo/scripts/obsidian-settings-check-unload-smoke.js")")"
    [[ "$unload_ready" == *"OBSIDIAN_SETTINGS_CHECK_UNLOAD_READY:"* ]] ||
      { echo "HOST_SMOKE_FAILURE: active connection check before reload ($unload_ready)" >&2; exit 1; }
    printf "%s\n" "$unload_ready"
  fi
  timeout 8s "$cli" plugin:reload id=oks-synthetic-evidence >/dev/null
  sleep 3
  if [[ "${OKS_06UX_TEST:-0}" == 1 && "${OKS_HOST_NO_ROUTE:-0}" == 1 ]]; then
    unload_result="$(timeout 20s "$cli" eval "code=$(cat "$repo/scripts/obsidian-settings-check-unload-smoke.js")")"
    [[ "$unload_result" == *"OBSIDIAN_SETTINGS_CHECK_UNLOAD_PASS:"* ]] ||
      { echo "HOST_SMOKE_FAILURE: active check unload ($unload_result)" >&2; exit 1; }
    printf "%s\n" "$unload_result"
  fi
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
  if [[ -n "$visual_dir" && -d "$tmp/visual" ]]; then
    cp -a "$tmp/visual/." "$visual_dir/"
  fi
  exit 1
}
if [[ -n "$ru_visual_dir" ]]; then
  cp -a "$tmp/l10n-visual/." "$ru_visual_dir/"
  (cd "$ru_visual_dir" && sha256sum ./*.png > SHA256SUMS)
fi
if [[ -n "$visual_dir" ]]; then
  test -s "$tmp/visual/results.json"
  cp -a "$tmp/visual/." "$visual_dir/"
  (cd "$visual_dir" && sha256sum ./*.png results.json > SHA256SUMS)
fi
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

if [[ "${OKS_NATIVE_CHAT_TEST:-0}" == 1 ]]; then
  echo "OBSIDIAN_NATIVE_CHAT_TARGETED_HOST_DONE: no cumulative host pass claimed"
fi
