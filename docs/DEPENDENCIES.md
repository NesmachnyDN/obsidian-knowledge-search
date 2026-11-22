# Dependency and provenance review

OKS-02C adds no redistributed binary or production inference runtime. It reuses the pinned OKS-02B isolated CPU environment and an explicitly provisioned tokenizer-only BGE-M3 snapshot. Optional native-chunking experiment libraries and their exact installed version/license/notice fingerprints are listed in [the 02C dependency inventory](../benchmarks/chunking/dependency-inventory.json), with the [tokenizer artifact SHA-256 manifest](../engine/tokenizer-artifacts.json). No embedding weights are provisioned or loaded by 02C. The 02C benchmark is run offline inside a dedicated network namespace under checked cgroup resource limits.

ADR-0006 changes the **target** basic runtime requirement: the Python interpreter below is an operator-installed dependency of the historical synthetic probe **only**, never of the mandatory Standalone install. No new library, model, binary, worker or distributable is authorized or introduced in the architecture-alignment PR. Bundled Advanced requires a separate full distribution/notice/size review; an opt-in Python backend is not part of the core plugin package.

## Historical OKS-01A package inventory

All project implementation and synthetic fixtures were independently authored; no prior application code was copied. The official Obsidian SDK is used for types and externalized at runtime. All npm dependencies are development-only; the plugin bundle contains project code and host/built-in imports only. Python uses its installed standard library. Node, Python and the separately installed Obsidian app are operator-supplied runtimes, not redistributed here.

The actual lockfile and installed license texts were checked using `node scripts/licenses.mjs`. MIT, Apache-2.0 and 0BSD are compatible with this development use; retain upstream license/notice files when redistributing tooling. No tooling is packaged into dist. Platform-specific esbuild optional packages share esbuild's upstream MIT license; only the installed host binary was inspected. This is a dependency inventory, not a vulnerability audit. Exact direct and transitive versions and available notice hashes follow.

| Package | Version | License | Installed license/notice files (SHA-256) |
|---|---|---|---|
| @codemirror/state | 6.7.6 | MIT | LICENSE: 05c6130cda97e7600ca91427a41e8a065efcf82365fc0293e7de80faec494c07 |
| @codemirror/view | 6.43.13 | MIT | LICENSE: 05c6130cda97e7600ca91427a41e8a065efcf82365fc0293e7de80faec494c07 |
| @esbuild/aix-ppc64 | 0.28.2 | MIT | Optional platform binary; not installed on this host |
| @esbuild/android-arm | 0.28.2 | MIT | Optional platform binary; not installed on this host |
| @esbuild/android-arm64 | 0.28.2 | MIT | Optional platform binary; not installed on this host |
| @esbuild/android-x64 | 0.28.2 | MIT | Optional platform binary; not installed on this host |
| @esbuild/darwin-arm64 | 0.28.2 | MIT | Optional platform binary; not installed on this host |
| @esbuild/darwin-x64 | 0.28.2 | MIT | Optional platform binary; not installed on this host |
| @esbuild/freebsd-arm64 | 0.28.2 | MIT | Optional platform binary; not installed on this host |
| @esbuild/freebsd-x64 | 0.28.2 | MIT | Optional platform binary; not installed on this host |
| @esbuild/linux-arm | 0.28.2 | MIT | Optional platform binary; not installed on this host |
| @esbuild/linux-arm64 | 0.28.2 | MIT | Optional platform binary; not installed on this host |
| @esbuild/linux-ia32 | 0.28.2 | MIT | Optional platform binary; not installed on this host |
| @esbuild/linux-loong64 | 0.28.2 | MIT | Optional platform binary; not installed on this host |
| @esbuild/linux-mips64el | 0.28.2 | MIT | Optional platform binary; not installed on this host |
| @esbuild/linux-ppc64 | 0.28.2 | MIT | Optional platform binary; not installed on this host |
| @esbuild/linux-riscv64 | 0.28.2 | MIT | Optional platform binary; not installed on this host |
| @esbuild/linux-s390x | 0.28.2 | MIT | Optional platform binary; not installed on this host |
| @esbuild/linux-x64 | 0.28.2 | MIT | Same-version esbuild/LICENSE.md: b40ec5baec7bb34fa5b1c09521fa3cd52d5fad7adafed74932a2010d3612a681 |
| @esbuild/netbsd-arm64 | 0.28.2 | MIT | Optional platform binary; not installed on this host |
| @esbuild/netbsd-x64 | 0.28.2 | MIT | Optional platform binary; not installed on this host |
| @esbuild/openbsd-arm64 | 0.28.2 | MIT | Optional platform binary; not installed on this host |
| @esbuild/openbsd-x64 | 0.28.2 | MIT | Optional platform binary; not installed on this host |
| @esbuild/openharmony-arm64 | 0.28.2 | MIT | Optional platform binary; not installed on this host |
| @esbuild/sunos-x64 | 0.28.2 | MIT | Optional platform binary; not installed on this host |
| @esbuild/win32-arm64 | 0.28.2 | MIT | Optional platform binary; not installed on this host |
| @esbuild/win32-ia32 | 0.28.2 | MIT | Optional platform binary; not installed on this host |
| @esbuild/win32-x64 | 0.28.2 | MIT | Optional platform binary; not installed on this host |
| @marijn/find-cluster-break | 1.0.4 | MIT | LICENSE: 9360b00fdd091f05c783b568bdd46c679c41b72415599252de98949462ea1acb |
| @types/codemirror | 5.60.8 | MIT | LICENSE: c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383 |
| @types/estree | 1.0.10 | MIT | LICENSE: c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383 |
| @types/node | 22.19.0 | MIT | LICENSE: c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383 |
| @types/tern | 0.23.9 | MIT | LICENSE: c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383 |
| crelt | 1.0.7 | MIT | LICENSE: 23852ebf6aef7fadffc92514b3c5df163a8651f2c3ed0dbb494cb49d93bd5de5 |
| esbuild | 0.28.2 | MIT | LICENSE.md: b40ec5baec7bb34fa5b1c09521fa3cd52d5fad7adafed74932a2010d3612a681 |
| moment | 2.31.0 | MIT | LICENSE: 64419cc68debfd9b7c27e9cd926c756181e0857709d2701094874e0fb1a41d28 |
| obsidian | 1.14.4 | MIT | LICENSE.md: c7e9eeb6640ebb1c22d8888f6d2c771b1f058a54e6216d69c7e2224b3cbad394 |
| style-mod | 4.1.5 | MIT | LICENSE: cb4474e26547397169061d3586c00022cda5330a1b64fa13e872319f3b63aff1 |
| typescript | 5.9.3 | Apache-2.0 | LICENSE.txt: a7d00bfd54525bc694b6e32f64c7ebcf5e6b7ae3657be5cc12767bce74654a47 |
| undici-types | 6.21.0 | MIT | LICENSE: a6db8096b2707bc0102d256917d4d33f298ba36d8c3f25de067a2b5bb379db27 |
| w3c-keyname | 2.2.8 | MIT | LICENSE: 869c30f368eb08735e779027b9f4bc9fea2f39624351856aebe42741f0bc0884 |
