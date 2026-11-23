# AI API providers and model evaluation plan

**Status:** Candidate inventory and measurement plan (2026-11-23); not a model-selection or provider-approval record. Governed by [ADR-0011](adr/0011-api-first-ai-optional-dense.md) and [SECURITY.md](../SECURITY.md). Catalogs, availability, quotas, latency and prices are mutable and must be verified against the actual account and API before procurement or production activation.

## Candidate shortlist

| Role | Candidate | Why evaluate | Status |
|---|---|---|---|
| Embedding | BAAI/bge-m3 | Existing OKS-03A/B reference baseline and known tokenization/index compatibility assumptions | Baseline candidate only |
| Embedding | Qwen/Qwen3-Embedding-0.6B | Mixed Russian/English technical search and code/identifier retrieval | Test candidate |
| Embedding | Giga-Embeddings-instruct-480M | Russian-language retrieval hypothesis, compact model | Verify actual API model ID/availability |
| Embedding | Giga-Embeddings-instruct-3B | Russian-language retrieval quality hypothesis; compare incremental benefit and cost | Verify actual API model ID/availability |
| Rerank | Qwen/Qwen3-Reranker-0.6B | Prioritized cross-encoder evaluation for multilingual technical passages | Preferred trial, not accepted winner |
| Rerank | BAAI/bge-reranker-v2-m3 | Lower-cost alternative and comparative baseline | Test candidate |
| Generation | Model/API TBD | Optional answer synthesis grounded in returned EvidenceHits | No selected model |

Published model scores from different versions or test protocols are **not** directly comparable, and no Russian-corpus superiority is asserted until an OKS-controlled evaluation. The specific Giga model identities/availability must not be inferred from a marketing page when the live API catalog differs.

**Potential first provider:** Cloud.ru Evolution Foundation Models, using separately authorized, scoped AI credentials (never S3 access keys). This is an integration candidate, not a decision to transmit a Vault or to purchase any service. Other configurable, compatible local or remote APIs remain possible. Consolidating billing with existing Cloud.ru services is an operational preference, not an architectural requirement.

Official references checked during planning:
- [Cloud.ru Foundation Models available models](https://cloud.ru/docs/foundation-models/ug/topics/overview__available__models) — query exact IDs and placement (internal vs externally routed).
- [Cloud.ru Foundation Models API](https://cloud.ru/docs/foundation-models/ug/topics/api-ref) — confirm methods, limits and authentication.
- [Cloud.ru Foundation Models product catalog](https://cloud.ru/products/evolution-ai-factory/catalog-foundation-models) — candidate discovery; not proof of API entitlement.
- [Cloud.ru contractual service terms](https://cloud.ru/documents/contracts/terms-of-service/evolution/foundation-models/description-foundation-models) — verify routing and applicable data-processing conditions.
- [Qwen3 embedding and reranker model cards](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) and [reranker](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B) — input/instruction contract and model-specific limitations.

## Controlled benchmark and selection gate

1. Freeze a synthetic or explicitly approved corpus representative of Russian architecture notes, RU/EN mixed specifications, ArchiMate/TOGAF terms, API/REST names, Kafka/S3 references, YAML/JSON and long PDF/DOCX excerpts. **Never publish private project documents** as fixtures or send them to cloud providers without explicit per-source authorization.
2. Prepare 100–150 labeled queries where feasible: exact identifiers, natural-language paraphrases, cross-language queries, negative/ambiguous queries and property-filter intersections. Record source versions and expected document/chunk relevance.
3. Hold parsing, chunk boundaries, query filters and relevance labels constant while comparing embeddings. Use each model's correct document/query instruction and tokenization; reject silent truncation. Compare Recall@20/50, nDCG@10, MRR@10, exact-ID coverage and source-locator correctness.
4. Repeat with reranking of a fixed top-20/top-50 candidate set; measure nDCG@10/MRR@10, p50/p95 latency, token use, failure rate and billed cost. Isolate embedding retrieval effects from reranker effects. Compare local and cloud API profiles only under documented identical conditions.
5. Test API outage, timeouts, 429/quota, cancellation, unsupported models, changed dimension/instruction, index migration and source edits/deletion. Basic search must remain available and a failed AI request cannot be labeled successful hybrid execution.
6. Verify API egress and privacy gates on synthetic data: explicit disabled-by-default consent, source classifications/deny rules, scoped sends, TLS endpoint allowlist, secret redaction, network-cut recovery and no raw-content diagnostic export.
7. Document selected provider/model version, measured quality uplift, latency/cost ceilings, deployment conditions and fallback behavior in a subsequent measured ADR before enabling AI by default.

## Index strategy

Exactly one active local dense index per Vault, tied to the embedding model identity and source/chunk pipeline. Changing embedding model triggers full compatible reindex into a temporary staging generation followed by verified atomic activation and retirement of the former generation. Never combine candidate-model vectors in a shared search space. The local basic text/Properties index is separate and never requires the AI service. A reranker does not own a vector index.

## Non-goals / unresolved items

No Cloud.ru credential provisioning, charge commitment, model downloads, changes to live Vaults or activation of AI service is authorized by this plan. Endpoint compatibility, service region, contractual confidentiality approval, model availability/versions, effective per-token prices and measurable outcomes remain **OPEN** until tested.
