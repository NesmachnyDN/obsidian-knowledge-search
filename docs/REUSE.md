# Reuse assessment

Status: pending OKS-00. No code has been imported.

The first task is to inspect prior implementations and maintained libraries using an explicit dependency and license gate. Public documentation must not reveal private repositories or confidential material without authorization.

| Candidate | Assessment to perform |
|---|---|
| Document adapters and block model | Isolate native hierarchy and provenance, remove application/database coupling. |
| Section classification and chunk planning | Compare against native HybridChunker, exact tokenizer and benchmark. Retain only demonstrated useful rules; no inherited table/appendix suppression without evidence. |
| Local embedding and reranking | Reuse runtime configuration/evaluation and identity validation; verify separate artifact licenses and dependencies. |
| Rank fusion and context expansion | Prefer pure functions, preserve deterministic ranking and source boundaries. |
| Evaluation | Reuse permitted metrics/harness ideas, recreate all fixtures synthetically. |
| Persistence and workflows | Prefer embedded local mechanisms; no legacy server database, application workflows, identity system or parallel knowledge truth. |

For every candidate record source revision, path/symbol, copyright/license, transitive dependencies, tests, independent reuse fit, decision (reuse/adapt/reimplement/omit), rationale and limitations. Do not publish private source code or private paths until redistribution rights are established; keep confidential provenance review records outside public Git where required. Preserve notices for legally reusable third-party material.

Freeze no model or chunking choice merely because a previous prototype used it.
