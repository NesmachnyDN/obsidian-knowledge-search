# Obsidian Knowledge Search (OKS)

**Search by meaning. Retrieve with precision. Trust the source.**

OKS is a planned local-first hybrid search and retrieval plugin for Obsidian, designed for personal knowledge bases containing notes and complex technical documents.

## Project status

Pre-alpha. The repository includes a synthetic TypeScript-to-Python evidence probe and a measured, separate Python experimental engine; **neither is a standalone installable search plugin**. The target mandatory base is **Obsidian + OKS plugin only**, without additional software, network or manual runtime setup. Real search UI, native index and clean-install acceptance are not yet delivered.

## Goals

- Search Markdown notes and linked PDF/Office documents together.
- Preserve document hierarchy, normative clauses, tables and source locations.
- Use multilingual embeddings, lexical retrieval and rank fusion; evaluate local reranking.
- Return inspectable, source-grounded evidence for users and AI agents.
- Automatically maintain a rebuildable local index, without a second knowledge base.
- Keep baseline Markdown lexical indexing and retrieval offline **without** dependency/model provisioning; advanced offline model capabilities require explicit, separately measured provisioning.

Desktop Linux is the first supported target. Other desktop platforms and Obsidian Community Plugins distribution are later work, subject to packaging and policy verification.

## Execution profiles (planned)

- **Standalone (default, mandatory):** plugin-native Markdown lexical search, typed Properties and link metadata, source navigation, local index/freshness, offline with no Python/server/Ollama/Docker.
- **Bundled Advanced (optional):** plugin-managed, licensed local processing/real embeddings, only if distribution/host/resource experiments pass.
- **External Backend (optional):** explicitly configured authenticated local processing service, never required for Standalone; no source egress by default.

Dense search and true hybrid lexical+dense retrieval remain separate capabilities. CAP-04/05 are still MVP-wide acceptance gates in a demonstrated local/offline advanced profile, not claims that Standalone already performs embeddings. See [ADR-0006](docs/adr/0006-standalone-execution-profiles.md) and the [roadmap](docs/ROADMAP.md).

## Project documentation

- [Product specification](docs/SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [Architecture decisions](docs/adr/README.md)
- [Benchmark protocol](benchmarks/README.md)
- [Reuse assessment](docs/REUSE.md)
- [Contributor guide](CONTRIBUTING.md)
- [Spec-driven development workflow](docs/development/SDD.md)
- [Security and privacy](SECURITY.md)

## Repository layout

- plugin/ — Obsidian TypeScript integration.
- engine/ — local document processing, indexing and retrieval runtime.
- contracts/ — versioned plugin/engine message contracts.
- tests/ — integration, lifecycle and end-to-end tests.
- benchmarks/ — reproducible evaluation and synthetic fixtures.
- docs/ — product and engineering decisions.
- scripts/ — reproducible provisioning and development tools.

No model weights, personal vaults, production indexes or private source documents belong in this repository.

## License

MIT for repository code; third-party libraries and model artifacts retain their own terms.
