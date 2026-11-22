# ADR-0001: Local-first Obsidian retrieval boundaries

Status: Accepted design baseline (2026-11-22)

## Context
The plugin serves one authoritative Obsidian vault and must retrieve technical-document evidence without maintaining another application or requiring cloud inference. A TypeScript UI thread is not a suitable host for heavyweight Python parsing and inference.

## Decision
Use a standalone desktop Obsidian adapter with a locally supervised, isolated engine and a rebuildable, vault-scoped index. Keep original files and Properties authoritative. Reuse prior engineering approaches only after provenance and license review; no operational dependency or compatibility requirement with earlier applications. Prefer structural source-aware chunking, tokenizer-aligned budgets, lexical + dense search and inspectable evidence. Model selection, storage, IPC and distribution are subject to measured ADRs. No generator in the MVP.

## Alternatives
- Existing search plugin: useful baseline but current structural extraction and embedding input controls may be insufficient.
- Whole external application: rejected due to complexity and operational coupling.
- All computation in plugin UI: rejected due to resource isolation and language/runtime constraints.

## Consequences
A local companion runtime needs packaging, lifecycle and resource testing. The index is derived and can be discarded safely. Offline local processing, provenance, controlled activation and explicit failure handling are release gates.
