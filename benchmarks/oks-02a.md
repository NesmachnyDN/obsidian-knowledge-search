# OKS-02A lexical baseline evidence
Measured on the frozen implementation commit `c4591b8310f47d8cb7ffc367611c122ae24f2584` and the separately frozen corpus commit `8057b759718ff43928018c9fa81e2abe67c6659c`. No post-evaluation label changes. Python 3.12.3, SQLite 3.45.1 on Linux, 16 GiB-class CPU host. No model, network dependency, external document or prior application code.

Reproduce with:
```sh
python3 -I -B benchmarks/oks02a.py --split tuning
python3 -I -B benchmarks/oks02a.py --split held_out
```
[Full tuning run](oks-02a-tuning.json) and [held-out run](oks-02a-held_out.json) include corpus, judgment and implementation hashes, per-query ranks, configuration, measurements and metrics. Latencies are small-sample warm observations, not performance guarantees. Document scores are computed by unique paths in the bounded top-50 span result, not from a separate document-index algorithm.

| Split/unit | Recall@5 | Precision@5 | nDCG@5 | MRR@5 | Recall@10 | Precision@10 | nDCG@10 | MRR@10 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Tuning span | 1.000 | 0.329 | 0.990 | 1.000 | 1.000 | 0.164 | 0.990 | 1.000 |
| Held-out span | 0.900 | 0.267 | 0.917 | 0.933 | 0.967 | 0.147 | 0.941 | 0.944 |
| Tuning document | 1.000 | 0.243 | 1.000 | 1.000 | 1.000 | 0.121 | 1.000 | 1.000 |
| Held-out document | 1.000 | 0.213 | 1.000 | 1.000 | 1.000 | 0.107 | 1.000 | 1.000 |

Tuning: 15 queries, 14 answerable, 3 exact-ID/technical queries; held-out: 16, 15 answerable, 9 exact. Span exact direct-hit @5/@10: tuning 3/3 and 3/3, held-out 8/9 and 9/9. Negative control: tuning 0/1 query had hits; held-out 1/1 had hits (four at K=10). This is an observed limitation of OR matching on generic terms; the system does not claim answerability or semantic negation. Do not retune against this held-out result.

21 documents (18 ok, 2 partial, 1 empty); 105 line blocks, 90 searchable blocks; 105/105 match the authored line/type oracle, zero observed invalid line or cell byte locators. This is coverage of the declared physical-line subset, not a claim of full Markdown/YAML semantics. Malformed and unsupported structures are preserved as literal lines with diagnostics; properties are scalar strings and not yet searchable metadata.

| Observation | Tuning | Held-out |
|---|---:|---:|
| Parse ms | 2.197 | 2.034 |
| Build in-memory index ms | 2.946 | 2.697 |
| Query median ms | 0.141 | 0.105 |
| Query nearest-rank p95 ms | 0.266 | 0.330 |
| SQLite allocated page bytes | 49152 | 49152 |
| Process peak RSS KiB | 22016 | 22144 |

The small authored synthetic sample has no independent human annotation or
representative production distribution. High document recall must not be
interpreted as demonstrated production search quality. No PDF/DOCX, OCR,
embedding, chunking, hybrid, incumbent comparison or real-vault acceptance
is claimed. Independent code review and exact-head CI remain delivery gates.
