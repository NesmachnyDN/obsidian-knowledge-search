# ADR-0004: Explicit native extraction profiles and structural limitations

Status: Proposed; incomplete OKS-02B experiment, not an accepted extraction strategy.

## Evidence and decision proposal

Use versioned extraction profiles with native item identity, source digest,
content layer, one-based page, coordinate origin and geometry where actually
provided. Native item character spans are not file byte spans. DOCX has no
reliable page geometry in this profile. Table row text is a derived serialization
of separately anchored cells; retain merged row/column ranges. Do not fabricate
locators or pass unresolved binary anchors into the Markdown lexical index.

Evaluate Docling Slim's DOCX conversion and model-free NativePdfPipeline, not
Markdown reconstruction. The latter recovers text and native geometry but does
not infer semantic headings, tables or reading order. DOCX conversion preserves
nested headings, clauses, five cells and a merged cell on the frozen fixture;
header and footer text are retained in the furniture layer without distinction.
Poppler and python-docx recover the expected text on the same fixtures but the
comparison does not establish equivalent structure. Tesseract 5.3.4 with local,
explicitly selected English and Russian fast language assets recovers both test
scan lines exactly with page geometry; this is a separate OCR-text profile,
not a semantic layout model or an automatic fallback. See measured evidence in
[the experiment report](../../benchmarks/extraction/README.md).

## Open gate

Do not select the model-free PDF or scan profile as sufficient for full
structural extraction. The full Docling layout/table pipeline has no verified
local model artifacts in the experiment environment. Evaluating it requires an
explicit maintainer authorization for the exact model/runtime artifact set,
followed by upstream version, license, hash and size verification and bounded
CPU-only offline measurements. Candidate families: Docling Heron layout and
TableFormer (start with fast). Candidate weight sizes are approximately 172 MB
and 145 MB respectively, not a computed full installation budget. Check official
model revisions and all runtime dependencies before provisioning. Suggested
initial execution envelope: one worker, two CPU cores, <=4 GiB cgroup RAM,
no swap, >=3 GiB available-memory reserve, enforce process-tree deadlines and
stop on pressure. These are proposed limits, not measured full-pipeline costs.
Do not enable default downloads, alter the Vault or reuse a private application's
runtime. Continue with language/furniture/complex layout coverage, independent
review and CI before acceptance. No chunking or retrieval-quality decision yet.
