# Obsidian Knowledge Search (OKS)

**Search by meaning. Retrieve with precision. Trust the source.**

OKS is a planned local-first hybrid search and retrieval plugin for Obsidian, designed for personal knowledge bases containing notes and complex technical documents.

## Project status

Pre-alpha. Standalone Markdown lexical indexing, search UI, a release-shaped package candidate and canonical opt-in advanced ingestion have landed in `develop`; this does **not** imply final MVP acceptance or a production-ready AI API. The mandatory base is **Obsidian + OKS plugin only**, with autonomous offline text-occurrence/Properties search and without additional software, network or manual runtime setup. The revised AI-provider requirements are documented in ADR-0015; implementation and acceptance remain separately gated.

## Goals

- Search Markdown notes and linked PDF/Office documents together.
- Preserve document hierarchy, normative clauses, tables and source locations.
- Preserve autonomous text-occurrence/Properties search; optionally use API-backed multilingual embeddings, genuine hybrid rank fusion, reranking and RAG.
- Return inspectable, source-grounded evidence for users and AI agents.
- Automatically maintain a rebuildable local index, without a second knowledge base.
- Keep Markdown text/Properties indexing and retrieval offline **without** any AI provisioning; optional AI search uses configured local APIs (offline only if verified) or cloud APIs (online and with explicit data-transfer consent).

Desktop Linux is the first supported target. Other desktop platforms and Obsidian Community Plugins distribution are later work, subject to packaging and policy verification.

## Execution profiles (target architecture)

- **Standalone (default, mandatory):** Obsidian-native offline text-occurrence search, typed Properties/tags/link metadata, fresh source navigation and durable local metadata/lexical index. No Python, API key, model, cloud or vector index required.
- **Optional AI API:** embedding/dense and genuine hybrid, reranker and LLM providers independently configurable through local or cloud APIs. Cloud is disabled until explicit approved source-scoped egress. A local API may work without Internet when tested; cloud requires connectivity.
- **Optional advanced extraction:** supported PDF/DOCX/OCR via separately tested opt-in processing; not required for Standalone Markdown.

Exactly one active local dense index binds to the chosen embedding model. A model switch triggers a staged full reindex and atomic activation, not permanent storage of indexes for every candidate. Basic search remains available while the AI API is unavailable. Mandatory MVP Gate A and conditional AI/advanced-format acceptance are defined in [ADR-0015](docs/adr/0015-api-first-ai-optional-dense.md) and the [specification](docs/SPEC.md); local offline AI is not an MVP-wide release gate.

### Experimental local BGE-M3 profile (OKS-05D candidate)

The unmerged OKS-05D candidate implements a **separately opted-in, local-only** CPU BGE-M3 retrieval profile, **not** a configurable embedding/reranker/LLM API-provider adapter, the default Standalone runtime, or a mandatory Gate A prerequisite. It reuses authenticated v3 Markdown/PDF/DOCX/RU+EN OCR extraction and offers manual indexing, lexical/dense/hybrid RRF and source-verified navigation in Obsidian. It requires separately provisioned and verified local Python, BGE-M3 weights/tokenizer and OCR data, a bounded user-systemd cgroup, and no network access or automatic downloads. Initial limits are 32 sources / 256 vectors; a cold model-backed query may take approximately 10–20 seconds on the measured CPU host. Native PDF/DOCX page/cell navigation is not guaranteed. Configure trusted Advanced paths in the plugin settings and use the active-source indexing and Advanced search commands only in an authorized Vault. See the [OKS-05D retrieval contract](contracts/advanced-retrieval-v1.md), [proposed ADR-0014](docs/adr/0014-offline-advanced-retrieval-generation.md), and [author handoff](docs/reviews/OKS-05D-AUTHOR-HANDOFF.md). API-first provider capabilities remain separately gated by ADR-0015.

## Project documentation

- [Product specification](docs/SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [AI provider / model evaluation plan](docs/AI-PROVIDER-EVALUATION.md)
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
