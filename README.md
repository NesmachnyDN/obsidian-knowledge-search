# Obsidian Knowledge Search (OKS)

**Search by meaning. Retrieve with precision. Trust the source.**

OKS is a planned local-first hybrid search and retrieval plugin for Obsidian, designed for personal knowledge bases containing notes and complex technical documents.

## Project status

Architecture / pre-alpha. No installable plugin or production search engine exists yet. The capabilities below are goals, not claims of implemented functionality.

## Goals

- Search Markdown notes and linked PDF/Office documents together.
- Preserve document hierarchy, normative clauses, tables and source locations.
- Use multilingual embeddings, lexical retrieval and rank fusion; evaluate local reranking.
- Return inspectable, source-grounded evidence for users and AI agents.
- Automatically maintain a rebuildable local index, without a second knowledge base.
- Keep indexing and retrieval offline after explicit dependency/model provisioning.

Desktop Linux is the first supported target. Other desktop platforms and Obsidian Community Plugins distribution are later work, subject to packaging and policy verification.

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
