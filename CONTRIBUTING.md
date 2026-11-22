# Contributing

The project is in design/pre-alpha. Read AGENTS.md and docs/ROADMAP.md; select one bounded task, link capability/acceptance IDs, and open a focused PR against develop. Follow [the SDD delivery workflow](docs/development/SDD.md). Use independent review before merge. Document a material design decision as an ADR; prefer existing dependencies over generic infrastructure.

Before opening a PR, run the applicable unit, contract, integration and security tests plus build/type checks. Include exact commands, results, unrun checks, benchmark manifests where relevant, and operational impact. Add negative tests for error paths, isolation, index freshness and recovery. Do not publish private documents, secrets, logs, private paths or copied code without redistribution rights. Initial tooling and CI are implementation work, not yet available; no claim of passing CI at bootstrap.
