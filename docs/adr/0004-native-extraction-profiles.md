# ADR-0004: Explicit native extraction profiles and structural limitations

Status: Proposed; measured OKS-02B experiment, pending independent review and merge.

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

## Initial open gate (historical)

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

## Controlled structured profile

Explicit provisioning is now authorized within the CPU-only resource envelope.
[Artifact manifest](../../engine/extraction-model-artifacts.json) pins Heron
(Apache-2.0) and TableFormer Fast (CDLA-Permissive-2.0) to immutable upstream
revisions and exact SHA-256/size for each required SafeTensors/config file.
Separate the operator provisioning command from conversion. The structured
profile must fail if the local artifact set is absent, altered or unexpected;
no implicit transition to an earlier model-free profile. Full structural quality
and resource measurements remain open until the actual experiments finish.

## Measured outcome and provisional decision

Select native structured PDF as the *candidate* layout/table profile, not a
production default. The frozen two-page fixture recovered 11/11 text
fragments, 4/4 cell texts and topology/geometry matches, 9/9 region text/page
and geometry matches, but only 2/3 headings and 8/9 region labels. The
Russian numbered heading remains misclassified; preserve original list text
and report partial rather than invent a hierarchy. The explicit clause-label
conflict repair avoids treating a requirement as a section ancestor. Native
DOCX furniture classification now uses group ancestry. The scan recovered
both bilingual lines and both authored source geometry regions; local OSD,
English and Russian assets and configuration are hash-checked. No remote
interfaces beyond loopback, no implicit fallback, and no new Vault writes.

Peak charged cgroup memory was 794161152 and 770428928 bytes for the final
PDF and scan runs, respectively, below the 4 GiB admitted limit. Wall times
were 11.186 and 10.291 seconds. See the linked measured report for full
reproducibility, source/weight hashes, dependencies and exact limitations.
Model classification and reading order remain fallible. Keep native source
anchors distinct from derived context; do not use this small synthetic
experiment as proof of production quality. Section classification and
chunk-policy comparison belong to 02C after this slice passes independent
review. No retrieval-quality choice until 03B. Do not distribute model or
runtime binaries without a separate distribution/license review.
