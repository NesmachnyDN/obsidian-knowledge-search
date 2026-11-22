# OKS-02B model-free native extraction and offline OCR evidence

Status: partial experiment; NOT a full extraction acceptance or a merge approval.

The synthetic four-file corpus and labels were frozen at `f86d0ba` before
executing extraction. A second generation matched the manifest byte-for-byte.
No Vault data, private documents or embeddings are included. The fixed font is
DejaVu Sans from the host, fingerprinted in the manifest. The manifest, generator
and pinned dependencies permit the same generation on a matching host.

## Reproduction

Linux x86_64, Python 3.12.3. Use a dedicated virtual environment and reviewed
wheel lock (`uv pip install --require-hashes --no-deps --no-build -r
benchmarks/extraction/requirements-linux-py312.txt` with the explicit isolated
interpreter). Do not install the packages into the base system. See the
[dependency inventory](dependency-inventory.json); 49 distributions, about
330 MiB environment including packages; preliminary Linux wheel size envelope
about 111 MB. Local Tesseract 5.3.4 (`5.3.4-1build5`) and Poppler
`24.02.0-1ubuntu9.11` are external local CLI tools. English and Russian
`tesseract-ocr-{eng,rus}` version `1:4.1.0-2` are Apache-2.0 tessdata_fast assets.
The Russian package is 1,454,226 bytes, extracted into a private experiment
folder without root installation. Package SHA-256:
`a41091fb50a4f24e6f56119218c8688443b69e4bca6f3e4c6be82568eb436e53`.
Asset SHA-256:

- eng: `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2`
- rus: `e16e5e036cce1d9ec2b00063cf8b54472625b9e14d893a169e2b0dedeb4df225`

Only package metadata and license-related paths are included here; installed
binary notices (e.g. PDFium and NumPy bundled components) remain in the wheels.
MPL-2.0 components are unmodified and not redistributed. latex2mathml declares
MIT but had no license file in the installed wheel; verify upstream notices
before packaging. Full model and runtime distribution review is pending.

Run with the isolated interpreter and an explicit absolute local tessdata path.
The experiment runner requires only loopback network interfaces. Example:

```sh
systemd-run --user --scope -p MemoryMax=2G -p MemorySwapMax=0 \
  -p CPUQuota=200% -p TasksMax=128 timeout -k 5s 120s \
  unshare -Urn env OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 \
  HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  "$PYTHON" -I -B benchmarks/extraction/run.py --tessdata "$TESSDATA"
```

Use the Foundation pre-admission checks, stop on pressure, and run one job at a
time. The 64 KiB scoped binary input bound is a PoC bound only, unrelated to
production document-size requirements. No heavyweight weights downloaded.

## Observations

See [actual run JSON](results-model-free.json). Counts are matches of distinct
frozen expected fragments after whitespace normalization, not character coverage
or an estimate of corpus-wide extraction accuracy. The model-free PDF profile
and OCR-text profile always expose the missing semantic-structure diagnostic.

| Profile | Text fragments | Headings | Cells | Page locations | Status |
|---|---:|---:|---:|---:|---|
| Docling DOCX | 12/12 | 3/3 | 5/5 | unavailable | partial |
| Docling native PDF | 11/11 | 0/3 | 0/4 | 13 | partial |
| Docling native scan | 0/2 | n/a | n/a | 0 | partial |
| Tesseract scan | 2/2 | n/a | n/a | 2 | partial |
| Malformed PDF | n/a | n/a | n/a | n/a | failed |

DOCX merged-cell range matched; both furniture texts were retained but not
classified separately. Native PDF page-specific expected fragments matched 4/4;
OCR page-specific fragments matched 2/2. OCR CER/WER = 0/0 on two generated lines.
Page count, native item identity and in-page geometry were checked, not exact
pixel-level localization accuracy. Python-docx and Poppler matched 12/12 and
11/11 expected fragments respectively; Poppler scan text 0/2. Alternative timings
are text-only extraction, not directly comparable full native conversion.
The recorded native DOCX, PDF and OCR wall times are approximately 2.71 s,
0.21 s and 0.21 s; process RSS high-water mark 215636 KiB, cgroup charged peak
175538176 bytes (shared/file-backed accounting differs). OCR subprocess CPU is
not included in the profile process CPU metric. Single run, not latency percentiles.
No comprehensive multi-column, rotated, cross-page table or noisy scan proof.

## Integration / remaining gates

101/101 TypeScript, 51/51 Python tests, typecheck, license and build passed.
Re-running both 02A splits reproduced config, corpus/judgment/manifest hashes,
runtime, per-query rankings, structure and summary exactly; implementation hash
and observed performance fields differ. No frozen Markdown file changed.

V02B-01 and V02B-03 have initial empirical evidence; V02B-02 is incomplete
because model-free PDF lacks required native headings/table structure and DOCX
furniture classification is incomplete. V02B-04 remains incomplete for the
full pipeline's artifact license/size/runtime review. V02B-05 needs independent
exact-head review and CI, and the preceding gates; a local test pass is not
approval. Continue with the reviewed artifact budget and full offline layout
experiment after explicit permission, then broaden negative/structural tests.
No production indexing, automatic fallback or changes to 02A metrics.
