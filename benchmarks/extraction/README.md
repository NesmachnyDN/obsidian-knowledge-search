# OKS-02B model-free native extraction and offline OCR evidence

Status: measured native and structured extraction PoC; independent review and exact-head CI required. Not production acceptance.

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

## Authorized full CPU profile provisioning

- [Pinned model artifact manifest](../../engine/extraction-model-artifacts.json).
  Heron source: https://huggingface.co/docling-project/docling-layout-heron
  (Apache-2.0). TableFormer Fast source:
  https://huggingface.co/docling-project/docling-models (CDLA-Permissive-2.0).
  Exact resolved upstream commits, sizes and weight SHA-256 values were checked
  through repository metadata; small configs were additionally verified against
  Git blob IDs. No alternate weights, pickle checkpoints or model code required.
- [CPU wheel lock](requirements-full-cpu-linux-py312.txt),
  [preflight wheel inventory](full-cpu-wheel-preflight.json) and
  [installed package inventory](full-cpu-installed-inventory.json).
  Linux x86_64 / CPython 3.12; PyTorch 2.14.1+cpu and torchvision 0.29.1+cpu,
  Docling IBM Models 4.0.4, Transformers 5.18.0, headless OpenCV 4.14.0.94.
  Resolved 75 installed distributions; no CUDA/NVIDIA packages. Additional
  wheel budget 294,039,877 bytes (including 61,960,165 bytes OpenCV, required
  by the table predictor); model artifacts 317,123,044 bytes. The full isolated
  environment occupies about 1.4 GiB. Reserve 8 GiB free disk for installation,
  cache and model artifacts. Dependency notices stay with the installed wheels;
  no binary redistribution is proposed.
- Operator provisions explicitly (outside the repository):
  `python3 -I -B scripts/provision_extraction_models.py "$MODEL_DIR"`.
  The directory must be private, canonical, and contain the exact reviewed
  artifact set. Downloads are HTTPS-only; each file is size/hash-verified
  before activation. Provisioning is separate from extraction.
- Tesseract scans use the pinned eng/rus assets above and the host's TSV config
  (SHA-256 `59d079bb75d8b3d7c839a3564580cb559e362c93a9d70f234e421c0c3e767e04`)
  copied to the experiment tessdata directory. No system-level install.
- Full pipeline evaluation uses
  `benchmarks/extraction/run_structured.py` with one fixture per process,
  explicit artifact/tessdata directories and an isolated network namespace.
  Run under cgroup v2 limits (4 GiB MemoryMax, 0 MemorySwapMax,
  200% CPUQuota, bounded TasksMax, explicit timeout), with admission and
  pressure checks. Set `HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1` and restrict
  OpenMP/BLAS threads.
- [Independent geometry/topology expectations](expected-layout.json) were
  committed before structured model execution. Previous corpus and oracle
  files remain unchanged. Before model evaluation two actual native
  extraction integration tests and 53 dependency-free Python tests passed;
  native DOCX furniture classification now matches the header/footer groups.
  These tests do not demonstrate structured PDF model accuracy.

## Measured structured extraction (CPU-only, offline)

Both pinned model sets were downloaded and their exact files verified outside Git.
Both runs used the bounded wrapper with 4 GiB memory.max, zero swap.max,
200% CPU quota, an affinity mask of two logical CPUs, pids.max=128,
one active heavyweight job, a 3 GiB host RAM reserve and loopback-only network
namespace. The wrapper rejects active provisioning or insufficient resources.
All scopes exited. No production Vault activity.

The initial runs are retained as [PDF](results-structured-policy-initial.json)
and [scan](results-structured-scan-initial.json). The first PDF run revealed
Docling list marker normalization (10/11 text fragments) and a requirement
misclassified as a heading, affecting ancestor context. The initial scan
recognized both lines but logged missing OSD data. We preserved ListItem.orig
where it differs from text, recorded its distinct representation, gave explicit
requirement identifiers precedence over conflicting native labels, and surfaced
ambiguity rather than silently guessing a heading. Added a checked copy of the
already installed Apache-2.0 tesseract-ocr-osd 1:4.1.0-2 asset (10,562,727 bytes,
SHA-256 `9cf5d576fcc47564f11265841e5ca839001e7e6f38ff7f7aacf46d15a96b00ff`).
No additional download or host-level install.

Final runs: [PDF](results-structured-policy.json) and
[scan](results-structured-scan.json). Frozen oracle and source hashes stayed
unchanged. Text counts are expected fragment matches, not broad accuracy scores.

| Profile | Text | Headings | Cells | Region text/page | Region kind | Region geometry | Cell topology / geometry | Status |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Structured PDF | 11/11 | 2/3 | 4/4 | 9/9 | 8/9 | 9/9 | 4/4 / 4/4 | partial |
| Structured scan | 2/2 | n/a | n/a | 2/2 | 2/2 | 2/2 | n/a | ok |

The Russian numbered heading is still labeled as a list item by Heron.
Its full original text and geometry remain available; the previous heading
context is not a verified section assignment. Both requirement IDs and both
pages' header/footer instances are recognized. PDF has 11 native page
locations (table row locations refer to the table, with separate cell bounds).
Geometry means center inside each independently authored region, not IoU.
Scan text matches exactly after whitespace normalization; no OSD errors on
the repeat run. Native DOCX furniture groups now map to page_header/page_footer
and the integration fixture status is ok. No claims for arbitrary layouts,
rotated/noisy scans, cross-page tables or larger-than-PoC documents.

| Profile | Wall seconds | Process CPU seconds | cgroup peak bytes |
|---|---:|---:|---:|
| Structured PDF | 11.186 | see JSON | 794161152 |
| Structured scan | 10.291 | see JSON | 770428928 |

The recorded cgroup CPU usage and process RSS are in each JSON, not estimates.
One run per fixture, not a latency percentile. Resource limits are verified
inside the worker before loading Torch; provisioning and conversion are separate.
The measured model-free/structured trade-off supports a provisional structured
profile for native PDF tables when explicitly enabled, retaining model-free
and OCR-text profiles as distinct partial alternatives, never silent fallbacks.

V02B-01 through V02B-04 have empirical evidence at PoC scope, including the
documented unresolved semantic classification limitation. Decision acceptance
and V02B-05 require a fresh independent full-diff review and exact-head hosted
checks. No chunking, retrieval policy, production deployment or phase closure
is asserted by these measurements.

## Review remediation and unchanged semantic results

An independent review of PR #6 at `babee8eddeec57ebd5df65c90d027772c2ace57f`
identified two status/provenance defects: an OCR pass with no recognized text
reported `failed` instead of `empty`, and a PDF text item lacking a native page
location could report `ok`. The remediation classifies successful but textless
OCR as `empty` and makes PDF source-location completeness an explicit `partial`
diagnostic. DOCX remains exempt from page coordinates it does not possess.
Regression tests also exercise ZIP expansion and PDF page-count rejection.

The post-fix independent review gate is **still required**. Local checks passed:
101 TypeScript tests, 53 Python tests, typecheck, build, licenses, and seven
isolated extraction integration tests. Both bounded structured extractions were
rerun after the fixes. All semantic result fields (including extraction status,
text, headings, cells, geometry, source/model/oracle SHA-256, diagnostic labels
and native locations) matched the original published final JSON exactly.
The new PDF run measured 11.221 s / 826761216 cgroup peak bytes; the scan
measured 10.268 s / 770297856 bytes. These are additional single observations,
not replacements for the originally published run JSON or confidence intervals.
Both 02A splits reproduced config, corpus/judgment/manifest identity, all
per-query ranks, structure and aggregate metrics with zero deterministic changes.
The unresolved Russian numbered heading remains 2/3 native heading coverage.

## Empty native PDF status correction

A fresh independent review of the previous exact HEAD found that model-free
PDF extraction returned `partial` for a genuinely blank, successfully
converted PDF because the profile's always-present structural warning took
precedence over absence of text. The canonical mapper now reports `empty`
while retaining both the profile warning and `no-extracted-text` diagnostics.
A separate generated blank PDF integration test reproduces this case.
Existing frozen corpus and benchmark result files were not changed.
This does not alter the known Russian heading classification limitation.
