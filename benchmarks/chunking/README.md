# OKS-02C structural chunking — reproducible CPU comparison

Status: **experimental**; results are not retrieval-quality evidence or an embedding runtime validation.

## Source and evaluation protocol

The exact same canonical ParsedDocument inputs are reused by every strategy and token budget. The input set consists of the immutable OKS-02A Markdown corpus (all manifest-listed sources, including partial and empty cases), the OKS-02B synthetic DOCX fixture parsed using its pinned native profile, the original measured OKS-02B structured PDF and scan blocks replayed from reviewed result JSON files, and one separately generated oversize Markdown stress source. Original 02A source files and benchmark judgments and the accepted 02B results are not altered. Source SHA-256 and input-manifest hashes are validated before comparison.

The 02B PDF replay preserves original text, headings as classified, native item refs, pages, geometry, row and cell topology, and typed extraction status and diagnostics. It **does not re-execute** the Heron/TableFormer inference pipeline or prove extraction speed. The source partially classified by Heron remains **partial**; the Russian numbered heading remains an ambiguous list item. This measures the chunking response to that actual imperfect native structure, not a corrected oracle.

Policies on the shared inputs:

1. `fixed-window`: greedy exact-token sliding window over canonical block text, without contextual heading prefix; optional original-source suffix overlap when it fits.
2. `paragraph`: paragraph/heading-aware greedy exact-token grouping and explicit long-element segmentation; contextual heading prefix.
3. `structure`: canonical heading and clause/table boundaries with exact-token greedy packing, whole-source-span tracking, and explicit long-element splitting.
4. `native-hybrid`: **upstream** Docling Core 2.108.0 `HybridChunker` applied to a canonical-to-DoclingDocument projection, configured with the *same* BGE-M3 tokenizer and budgets. Its original table serialization and heading context may not match canonical source. Only uniquely exact-aligned original spans are credited as covered, never fuzzy reconstruction; omissions and budget violations are reported. Its optional overlap is an explicitly separate canonical-tail adapter, not an undocumented native option.

Budgets: 48, 96, 192 full-input tokens. Overlap targets: 0 and 12 original-content tokens. Each policy receives the same source, extraction status, budget and overlap request. Native HybridChunker's internal tokenizer count may exclude BOS/EOS while the external validation **always counts full contextualized input including BOS/EOS**. The externally measured violation, not the native internal count, is authoritative.

## Tokenizer artifact identity and offline contract

- Model family: `BAAI/bge-m3` (MIT declared by local card); revision `5617a9f61b028005a4858fdac845db406aefb181`.
- Fast `tokenizers==0.23.3`, XLM-RoBERTa tokenizer JSON verified against `engine/tokenizer-artifacts.json`. `tokenizer.json` SHA-256 `21106b6d7dab2952c1d496fb21d5dc9db75c28ed361a05f5020bbba27810dd08`.
- `model_max_length=8192`, but this is **not** a validated runtime limit for OKS-03A. Every candidate string is counted with `add_special_tokens=True` (BOS `<s>` and EOS `</s>`), `no_truncation()`, `no_padding()`; headings are serialized as newline-joined contextual prefixes. Actual chosen budgets are intentionally much smaller.
- No embedding weights are loaded or validated. Tokenizer loading is read-only from a local pinned snapshot. `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, and a private network namespace are mandatory for the benchmark. Missing/mismatched artifact is a fatal error, not a request to download.

The optional native chunking extras were provisioned **as Python libraries, not model artifacts**, in an isolated, temporary CPython 3.12 target: `semchunk==3.2.5`, `tree-sitter==0.26.1`, `tree-sitter-python==0.25.0`, `tree-sitter-c==0.24.2`, `tree-sitter-javascript==0.25.0`, `tree-sitter-typescript==0.23.2`. `docling-core==2.108.0`, `docling-slim==2.151.1`, `transformers==5.18.0`, `tokenizers==0.23.3` are from the isolated OKS-02B runtime. These remain optional development-only dependencies; no binary redistributions or production bootstrap are included. The **eleven** optional code-only packages also include `mpire==2.10.2`, `multiprocess==0.70.19`, `dill==0.4.1`, `pygments==2.21.0`, and `tqdm==4.70.1` required by semchunk/multiprocessing. See the exact [installed dependency inventory](dependency-inventory.json) for version, declared license, installed metadata digest and available notice-file hashes. `tqdm` declares MPL-2.0 AND MIT, `dill` and `multiprocess` BSD-3-Clause, `pygments` BSD-2-Clause; `tree-sitter` provides upstream MIT notices even where the installed wheel's license metadata is absent. No third-party binary distribution is bundled. Installed package metadata hashes are **not** a substitute for verified wheel archive hashes if distributing a wheel lock.

## Execution and host gate

Use the previously provisioned synthetic extraction runtime and *already cached* tokenizer, with explicit absolute paths supplied at invocation:

```sh
python3 -I -B scripts/run_chunking_bounded.py \
  --python "$EXTRACTION_PYTHON" \
  --snapshot "$PINNED_BGE_M3_SNAPSHOT" \
  --chunk-extras "$REVIEWED_LOCAL_CHUNK_EXTRAS" \
  --output "$UNIQUE_RESULT_JSON"
```

The wrapper performs Foundation memory/disk admission, verifies pinned tokenizer bytes, denies another named extraction/chunking scope, creates one `systemd-run --user --scope` with enforced cgroup v2 `MemoryMax=4G`, `MemorySwapMax=0`, `CPUQuota=200%`, `TasksMax=128`, `taskset` two logical CPUs, an offline `unshare -Urn` namespace and `timeout`. The worker checks actual cgroup kernel values before loading the comparison pipeline. It records peak cgroup charge, process RSS, task bound, network interfaces and CPU pressure; wrapper verifies scope termination and publishes the result JSON only on successful completion. Do not run the worker directly without this boundary for full experiments.

Unit tests use a deliberately marked fake scalar counter to check pure planning, failures and provenance; they **do not** stand in for actual benchmark token counts. The measured runner uses only the verified BGE-M3 tokenizer.

## Metrics and interpretation

Per source/policy/budget/overlap: source character coverage and exact missing block/character spans, duplicated original characters, ratio of *all contextualized chunk tokens* to tokenized unchunked original document, full-input token budget and oversize violations, count/min/max/mean tokens, contextual prefix cost, cross-section/heading mixing, table-cell preservation, locator missing/incomplete/incorrect, hash/identity stability, wall time, and cumulative process high-water RSS. The run also records actual cgroup peak memory and CPU statistics, failed cases and deterministic repeated-ID tests.

**Do not treat derived table text, heading serialization, partial table-row spans or extracted native geometry as file byte offsets.** Sources with non-body layers, missing page locations or incomplete heading classification remain identified with explicit diagnostics. Native projection is a fairness experiment, not a claim of native HybridChunker fidelity to arbitrary external documents.

The comparative shortlist remains provisional pending paired quality trials in **OKS-03B**, not OKS-03A. An incomplete or failed case must remain in results; policies with token violations, missing source spans or unverifiable source mapping are not approved as production defaults.

## Observed runs

The final reproducible, successful [result summary](results.json) and **all 600 original cases** in [newline-delimited JSON](cases.ndjson) were generated from the checked guarded-run JSON by [the lossless summarizer](summarize.py), preserving every source span and per-case metric. Full raw run SHA-256: `573507ba316f4083913f1428bbd29c3bbf6574e587188962ecdd7524aa17d02f`; compact case stream SHA-256: `0f85ff0cf2625bdaa83570e6f89d62e8a8cd57a3d8e7fcf10c74abb3e32a0a53`. A second full run after binding chunk IDs to tokenizer identity reproduced **all 600 semantic case metrics exactly** (wall times and RSS naturally vary). To reproduce the committed format, redirect the guarded runner's JSON to a unique local file and run:

```sh
python3 -I -B benchmarks/chunking/summarize.py \
  --input "$UNIQUE_RESULT_JSON" \
  --summary "$REGENERATED_SUMMARY_JSON" \
  --cases "$REGENERATED_CASES_NDJSON"
```

The case stream is deliberately one JSON object per line to keep the 600-result audit diff navigable without dropping observations.

| Policy | No lost spans / 150 | Full budget violations | Section-mixed chunks | Total chunks | Mean contextual-token duplication ratio | Cells preserved / 150 |
|---|---:|---:|---:|---:|---:|---:|
| Fixed-window | 150 | 0 | 84 | 278 | 0.988 | 150 |
| Paragraph-aware | 150 | 0 | 0 | 904 | 1.784 | 150 |
| Independent structure-aware | 150 | 0 | 0 | 502 | 1.275 | 150 |
| Native HybridChunker on canonical projection | 114 | 6 | 108 | 224 | 0.951* | 114 |

*The native comparison conservatively fails closed on source alignment. It has 272 unaligned item/segment observations and only 87.1% mean **verified** canonical source coverage; its low duplication ratio is distorted by these uncredited spans, **not** evidence of better retrieval/chunk quality. Six native full-input cases exceed the requested budget by 1–2 tokens. All methods have 0 measured wrong/missing locators among their credited spans and deterministic repeated chunk IDs, but this does not validate the uncredited native item fragments. The incomplete Russian PDF heading remains a `partial` source with the original text and geometry, not a corrected heading.*

For the structured PDF at budget 96 and overlap 0, independent structure-aware gives 100% verified coverage, 0 mixed sections, 0 token violations, and retained table cell anchors; it does not improve the source classifier.

The final guarded run took 14.47 s end-to-end, with `memory.max=4,294,967,296` bytes, actual `memory.peak=1,710,829,568` bytes, `memory.swap.max=0`, `cpu.max=200000 100000`, affinity 2 CPUs, `pids.max=128`, network interfaces `["lo"]`, and zero recorded memory high/max/OOM/OOM-kill events. A prior run was manually canceled via the user service scope to avoid an unbounded repeated tokenizer initialisation and left a nonpublished `.partial` result; a fresh independent scope then completed successfully. Another earlier trial detected a missing `mpire` runtime dependency on the late native repeat test; installing the declared code-only transitive packages corrected this. Neither incomplete attempt was published as a successful result.

Four actual-tokenizer integration tests passed **inside a separately verified CPU/memory-limited network namespace**, checking parity with HuggingFace fast tokenizer, a deliberately >8192-token untruncated input, exact-token long-clause segmentation, and conservative native provenance mapping. Existing dependency-free unit suites continue to work without the tokenizer artifacts. Overall interpretation and the provisional selection are recorded in [ADR-0005](../../docs/adr/0005-provisional-structural-chunking.md).

There are no claims of production chunking acceptance, complete native table cell-local offsets, representative large-document throughput or retrieval quality. The shortlist decision remains conditional on 03B paired retrieval-quality validation and 03A embedding runtime parity.
