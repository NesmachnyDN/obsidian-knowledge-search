# Obsidian Knowledge Search (OKS)

**Search by meaning. Retrieve with precision. Trust the source.**

OKS is a planned local-first hybrid search and retrieval plugin for Obsidian, designed for personal knowledge bases containing notes and complex technical documents.

## Project status

**Pre-release implementation, subject to independent SDD acceptance.** OKS-04A/04B and OKS-05A provide an operational package-only, model-free, offline Standalone lexical search, typed Properties, wiki-link metadata, source navigation and durable private index in Obsidian Desktop. OKS-05B/05C provide explicit local process supervision and verified Markdown/PDF/DOCX/RU+EN OCR ingestion. **OKS-05D is an unmerged candidate** for offline model-backed Advanced lexical/dense/hybrid retrieval with pinned BGE-M3; no feature of that candidate should be treated as a released capability until an independent full-diff SDD review, CI and merge. The default installation never requires Python, embeddings or network access.

## Goals

- Search Markdown notes and linked PDF/Office documents together.
- Preserve document hierarchy, normative clauses, tables and source locations.
- Use multilingual embeddings, lexical retrieval and rank fusion; evaluate local reranking.
- Return inspectable, source-grounded evidence for users and AI agents.
- Automatically maintain a rebuildable local index, without a second knowledge base.
- Keep baseline Markdown lexical indexing and retrieval offline **without** dependency/model provisioning; advanced offline model capabilities require explicit, separately measured provisioning.

Desktop Linux is the first supported target. Other desktop platforms and Obsidian Community Plugins distribution are later work, subject to packaging and policy verification.

## Execution profiles

- **Standalone (default, mandatory):** plugin-native Markdown lexical search, typed Properties and link metadata, source navigation, local index/freshness, offline with no Python/server/Ollama/Docker.
- **Local Advanced (optional, 05D candidate):** operator-provisioned pinned Python CPU runtime, local BGE-M3 model/tokenizer and OCR/parser assets; manual TFile ingestion and indexing, lexical/dense/hybrid RRF, verified provenance and private generation storage. Never automatically starts or downloads models in default Standalone. See [advanced retrieval contract](contracts/advanced-retrieval-v1.md).
- **Bundled Advanced (future option):** shipping a licensed model/runtime in an installer remains separately gated; 05D does **not** distribute Python or model weights.
- **External Backend (optional):** explicitly configured authenticated local processing service, never required for Standalone; no source egress by default.

Dense and hybrid remain **unavailable in Standalone**. The unmerged 05D local-Advanced candidate implements them for explicitly indexed sources, with a model-bound manifest; successful ingestion alone never means model readiness. CAP-04/05 still require independent review and realistic quality/stability validation. See [ADR-0006](docs/adr/0006-standalone-execution-profiles.md) and the [roadmap](docs/ROADMAP.md).

### Local Advanced (05D candidate) quick start

On a supported Linux Desktop with cgroup v2 and user systemd, install a *previously verified* local CPU Python runtime with Docling/OCR dependencies, BGE-M3 model snapshot and tokenizer. No automatic model download is performed. In the plugin's settings, enable **Advanced document ingestion** and supply the trusted absolute interpreter path, ingestion script (`engine/advanced_ingest.py`), pinned BGE-M3 snapshot and RU/EN Tesseract directory. Select an extraction profile, open the specific Vault file, then use **Ingest active Vault document** or **Build BGE-M3 index for active Vault document** (which will ingest if necessary). The **Rebuild** action resets an incompatible model index; repeat indexing for all intended documents. Use **Open Advanced lexical/dense/hybrid search** to select a mode, optional scope and typed Property predicates, then open a verified result. The cancel command stops the bounded model worker; disabling Advanced leaves Standalone functional.

**Limitations:** initial 05D restricts model indexing to 32 sources / 256 chunks, starts a cold BGE-M3 model worker for each dense/hybrid query (roughly 10–20 seconds on measured CPU host), and never promises native PDF/DOCX page/cell selection through unsupported Obsidian APIs. Excerpts are original-source evidence; OCR/native location fidelity may be `partial`. Real production Vault ingestion requires separate authorization. See [ADR-0014](docs/adr/0014-offline-advanced-retrieval-generation.md) and [OKS-05D SDD contract](docs/prompts/OKS-05D.md).

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
