# OKS-01A — Bounded execution contract: synthetic evidence probe

Status: candidate execution prompt; execute only after OKS-00 is reviewed and merged into develop. This file is the single contract for 01A. At execution record the actual develop SHA; if dependencies or governing decisions changed, stop for reconciliation.

## Authority and scope

Read AGENTS.md, applicable component instructions/readmes, SPEC, ARCHITECTURE, ROADMAP, SECURITY, ADR-0001/0002 and this contract. Check develop, worktree, open PRs and applicable decisions. One short-lived branch and one draft PR to develop. CAP-07/09, partial AC-07/09, plus a limited AC-06 evidence-shape check; do not claim full acceptance of these capabilities.

Implement the smallest complete actual desktop plugin -> local process -> typed evidence response. No prior application imports. All public artifacts in English. Source and test data must be independently authored and synthetic.

## Required implementation

1. Create the TypeScript SDK scaffold (manifest, minimal plugin, build/typecheck/test scripts, locked npm dependencies, desktop-only). Use the official Obsidian API, externalize the host SDK and built-ins, preserve applicable upstream notices and record actual dependency/license checks. Keep development tooling small and reproducible. Do not bundle an interpreter or install Obsidian in automation.
2. Add a Python standard-library-only entry point, invoked using explicitly configured, trusted absolute interpreter and engine entry paths, with argument-array spawn and no shell. No subprocess from the engine; no server/listener, internet access, telemetry or automatic dependency/model download. Fail clearly when not configured or missing. No work on plugin load.
3. Add a versioned protocol v1 and common fixtures under contracts/. UTF-8 JSON Lines (one request, one response, newline framed), with request ID, protocol version, method and typed success/error fields. Define exact field types and allowed shapes in schemas; validate both ends at runtime, reject unknown versions/methods, malformed/oversized payload and unmatched IDs. Add shared positive/negative contract cases; do not create a protocol framework.
4. Provide an explicitly invoked "Run synthetic evidence probe" command and a documented isolated synthetic vault with a small independently authored RU/EN Markdown note and a fixed exact query. Use Obsidian Vault API for the note, never scan. Require explicit fixture-mode opt-in; restrict to the known fixture path inside the selected root, reject traversal/symlink escape (including root/ancestor/target checks as applicable), verify known fixture UTF-8 SHA-256 before passing text. If unsupported filesystem behavior prevents verification, fail closed. No arbitrary vault text accepted; use no real vault. The worker receives fixture text, an opaque fixture ID, expected digest and literal query, not a filesystem path; independently verify the fixture identity against its own pinned allowlist of synthetic source ID and digest, not merely the caller's supplied hash. Exact case-sensitive literal line match, deterministic first matching line; typed empty/no-match response. Return exact source line without line delimiter, 1-based line locator and digest of the exact UTF-8 source text, plus request ID. Verify response excerpt, locator, digest and request identity before showing it; discard if the fixture changes before display.
5. Implement a narrow supervisor, one in-flight request (reject busy, no unbounded queue), bounded incremental stdout/stderr collection, no raw content/path logging, reject extra output/non-zero exit/malformed response. Proposed prototype limits: 64 KiB UTF-8 per request/response line (including delimiter), 8 KiB source, 256-byte query, 4 KiB stderr cap; 10s total deadline, 1s graceful termination before forced termination on Linux. Enforce bounds at both ends before allocation/processing beyond limits; validate and document byte-vs-character behavior. Cancel command and plugin unload terminate the child and guard against late results; ensure actual child exit, no orphan processes, clean restart and no stale process state. No heavyweight work even after success. This is not a security sandbox; process-level resource enforcement for heavy work is 01B onward.
6. Display a simple in-app result or status including exact evidence, location and source digest (or a clear no-match/error), not a search panel. Use DOM text, not HTML injection. Add a local CLI test invocation of the same Python entrypoint for automation only; external agent/Obsidian CLI integration is deferred.
7. Add minimal CI for Node install/typecheck/build/tests and Python standard-library tests on a Linux hosted runner; include no network-dependent runtime or host-specific paths. Package only the required plugin development outputs. Document lightweight setup, exact dependency versions, install into a disposable synthetic vault, manual smoke, unload/reload and removal. Do not alter the existing personal vault, incumbent plugins or host settings. No publishing to community store.

## Acceptance / required evidence

| ID | Expected proof |
|---|---|
| V01A-01 | Reproducible TypeScript build and Python stdlib entry point; actual manifest and desktop command; no ML/server/index dependencies. |
| V01A-02 | Shared protocol success/error fixtures exercised by both implementations; positive real child process integration yields exact RU/EN line, digest, locator and correlated request. No-match stays empty. |
| V01A-03 | With a missing fixture, wrong digest, out-of-scope/symlink path or unsupported version, fail closed. No arbitrary file paths in engine protocol; no source writes; no logging of source/query/private paths. |
| V01A-04 | Bounded byte framing, malformed/extra output, wrong request ID, engine crash, timeout and busy rejection tests. Cancellation/unload tests exercise real process termination where possible, followed by successful restart; no late UI results. |
| V01A-05 | Verify no model downloads/listener/network calls in the runtime path; run an offline integration test if supported and report enforcement method or remaining gap. Build provisioning may need network; runtime must not. |
| V01A-06 | CI checks on exact PR head; commands/results and unrun checks recorded. A maintainer-approved disposable Obsidian vault manual smoke verifies command, evidence, cancel/unload/reload and removal; identify app/platform version. A mocked adapter test is not actual Obsidian smoke. |

Automated tests use synthetic fixtures and small injected failure workers only. Production code must not import test fixtures/helpers. Tests should include real subprocess execution beyond mocks. No heavy or mass workload, and no real-vault access. If the actual Obsidian smoke cannot be run safely, mark V01A-06 outstanding and do not declare the vertical complete. Report prototype timing and resource observations if cheaply measured, not invented capacity claims.

## Explicit exclusions

No Docling, OCR, learned embeddings, fake/hash vectors, tokenizer downloads, lexical index/BM25, vector DB, hybrid/RRF, reranker, source expansion, persistent index, folder scan, bulk events, MCP/network API or production installer. No unrelated ADR, scope expansion, legacy code transfer or bypass of required merge gates.

## Delivery

Commit only bounded implementation/tests/docs on a short-lived branch; push without force and open draft PR to develop, report base/head SHA, changed paths, requirement mapping, dependency/license review, actual checks, failures and unrun manual smoke, privacy/resource impact and readiness. Independent review is separate; the orchestrator follows the SDD workflow and completes the authorized slice through verified merge into develop only after all gates pass.
