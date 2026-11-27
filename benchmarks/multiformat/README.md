# OKS-06G.1b.1 — Frozen text and diagram experiment subset

See [06G.1a](../../docs/prompts/OKS-06G1A.md) and [fixture contract](../../docs/prompts/OKS-06G1B1.md). This is a generated synthetic corpus, not evidence that an extractor or plugin supports a format. The oracle is authored independently of any candidate parser output. The committed manifest freezes SHA-256 and length of every regenerated file and binds the exact oracle bytes.

Run from repository root with Python 3 (standard library only):

```sh
python3 -B benchmarks/multiformat/generate_text_diagram.py --output /path/to/new-disposable-directory
python3 -B -m unittest discover -s tests -p test_multiformat_fixture_freeze.py
```

The output path must not exist; no source is overwritten. The generator is deterministic and does not execute or render any document. The test only checks known authored fixture integrity, not parser safety. Do not use the deliberately invalid files as production documents. The oracle includes 20 positive and nine negative examples, plus four related ownership/duplicate files. Ownership entries are scenario expectations, not admitted owner evidence. No external URL is contacted. Raw-deflate stored blocks avoid compression-version drift. Binary document/image families remain unfrozen and candidate comparisons unrun. No acceptance or dependency selection follows from these checks.
