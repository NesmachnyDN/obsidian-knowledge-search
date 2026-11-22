# Synthetic evidence probe (OKS-01A)

This is a Linux desktop development prototype, not search or an index. No work starts on load. Use only a disposable synthetic vault. It partially exercises CAP-07/09, AC-07/09 and the evidence shape of AC-06.

## Build and install

Use Node 22 and Python 3.12 (standard library only). Exact direct tooling versions: TypeScript 5.9.3, esbuild 0.28.2, Obsidian SDK 1.14.4 and @types/node 22.19.0; transitive versions are locked in package-lock.json. No interpreter or Obsidian application is bundled.

From this checkout run:

```sh
npm --cache .npm-cache ci
npm run typecheck
npm test
npm run test:python
npm run licenses
npm run build
```

Create a new empty disposable vault manually in Obsidian after reading any instructions for its destination. Copy `contracts/fixtures/evidence.md` byte-for-byte to `oks-synthetic/evidence.md` within that vault. Copy only `dist/main.js` and `dist/manifest.json` into `.obsidian/plugins/oks-synthetic-evidence/` in that disposable vault. Keep the trusted `engine/probe.py` in this checkout; do not move a real vault or change its settings. Enable the plugin in the disposable vault, configure trusted absolute interpreter and engine entry paths in its settings, then explicitly enable Synthetic fixture mode. The interpreter must support `-I -B`; the entry point must be the reviewed Python file. Configuration is local to that disposable vault and must not be published.

## Manual smoke (maintainer; outstanding)

Record Obsidian version, Linux distribution, candidate SHA and pass/fail evidence without private paths. The manifest minimum is a declared API floor, not a tested app version.

1. Load the plugin: no child, downloads, scan or network listener should appear.
2. Run **Run synthetic evidence probe**. Expect line 5, exactly `MATCH-01: The light is blue / Свет синий.`, SHA-256 `30e43a740cf91aaa7873fb97e6527e773d729ec21c5e7770decbce1695f9a360`, and a correlated request ID. The later matching line must not be chosen.
3. Modify the fixture: the displayed result closes; rerun rejects it. Restore the original fixture. Modify an unrelated synthetic note: it must not cancel a probe or close its result. Rename/delete the fixture or its containing folder: invalidate immediately and fail closed on rerun.
4. Invoke Cancel during a probe, disable/unload during a probe, then immediately re-enable and rerun while the old worker is still within its termination grace period. Use an isolated synthetic SIGTERM-resistant failure worker to exercise the full one-second grace, then restore the real entry point. Verify the new worker starts only after the old worker closes. Expect no late modal, no surviving child and successful restart. The engine is fast; automated tests use small sleeping failure workers to make these cases deterministic. Record if manual cancellation could not be exercised in time rather than claiming it passed.
5. Disable fixture mode, clear configuration, or temporarily remove the fixture: expect a clear status and no evidence.
6. Disable the plugin and remove only its directory from the disposable vault. Remove the disposable fixture/vault only after confirming it contains no other work. No source files are deleted by plugin unload/removal; the checkout and interpreter need not be removed. Verify no child remains.

## Filesystem and lifecycle limits

Vault API resolves only the known TFile. Content is read through a bounded native descriptor, **not Vault.readBinary**: that API offers no byte limit and a prior stat cannot protect its allocation from file growth/replacement. This is the deliberate safety implementation of the fixture-read contract: Vault API resolves the fixture; a native read enforces the byte limit before content allocation. Linux `/proc/self/fd`, O_NOFOLLOW and O_DIRECTORY are required; unsupported adapters/platforms fail closed. Every root/ancestor/target is checked; descriptor-relative component opens prohibit symlink following, and inode/device/size/timestamps are checked before reading. Reads allocate at most 8193 bytes, reject oversize and verify the pinned UTF-8 digest. Identity is checked again after reading and the fixture is reread before display. No arbitrary-path protocol or scan exists.

These checks are not an OS sandbox or a guarantee against a hostile process modifying the filesystem at exactly the last verification boundary. Only the pinned synthetic text can reach the worker. Obsidian events guard freshness after display; stronger arbitrary-source isolation belongs to 01B. No private source should ever be installed at the fixture path.

One request at a time; busy rejects without queueing. Protocol limits are UTF-8 bytes, including the newline for the 65536-byte frame; source 8192 bytes, query 256 bytes, stderr 4096 bytes. Stdout/stderr are incrementally bounded; stderr content is discarded. Supervisor deadline is 10 seconds including configuration preflight, followed by SIGTERM and up to 1 second before SIGKILL. Timed-out filesystem calls may finish in the background but cannot spawn a child; fixture verification is separate from the supervisor deadline. Settlement waits for child close. A symbol-keyed renderer-global lifetime slot survives plugin instances and module reloads. A re-enabled instance waits for a disposing predecessor to close before preflight/spawn; concurrent active owners reject BUSY. Cancellation/unload while waiting cannot spawn or clear the predecessor’s slot. The slot retains only a completion signal and disposal flag and is removed on completion; no plugin, view or child is stored globally. The new request’s 10-second deadline starts after admission through this gate. Cancel/unload generation guards suppress late UI results. Trusted worker creates no descendants; this is not general process-tree containment.
