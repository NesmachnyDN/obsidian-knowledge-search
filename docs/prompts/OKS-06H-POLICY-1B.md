# OKS-06H-POLICY-1B — Shared eligibility evaluator substrate

Base: `a9b72dd582f6f1e1f4048f8cd41b2539f9920a84`.

## Bounded outcome

Add a host-side, worker-parser-backed eligibility evaluator for the proposed
`llm_processing` Property.  It returns a deterministic, immutable decision
envelope for a future existing host authority to bind.  It is not an egress
admission point, grant issuer, credential store, lifecycle manager, transport,
UI change, note writer, or attachment extractor.  No profile is admitted by
production configuration in this slice; tests use only synthetic identities.

## Inputs and proof boundary

The evaluator reads each requested Markdown original through `SourceProvider`,
checks its expected digest before and after parsing, and uses the existing browser worker through its bounded `PolicyMetadataParser`
port. The worker reuses canonical frontmatter parsing and returns a compact
source/version/root-bound metadata proof; no lexical document schema change
and no parsing on the UI thread.  Indexed documents, caller Properties, excerpts and provider
classifications are never accepted as evidence.  Abort, source mutation,
parser failure, malformed or unsupported front matter, unrecognised markers,
duplicate/quoted keys, missing lineage, or unresolved ownership deny.

`llm_processing` is externally eligible only when the complete current
original proves the Property is absent or is the exact scalar string
`external`.  Exact `private`, null/list/number/boolean/date, and any
case/whitespace variant deny external eligibility.  Internal eligibility needs
an explicit synthetic trusted-internal profile and still loses to restrictive
rules or unresolved evidence.  A denial short-circuits evaluation; a positive result requires all constituents.
Unsupported attachment ownership/extraction remains denied. Derived subjects
require trusted direct-original lineage and complete matching owner identities;
the future role integration must verify exact derivative/payload bytes.

## Profile and envelope

A trusted host-only snapshot carries the independently admitted profile, role,
exact canonical configuration digest (including endpoint/model/revision), adapter,
current scope, source versions, restrictions and policy revision. No caller API
accepts an asserted trust profile.  It is never trusted because its endpoint
is loopback/local or because credentials/configuration exist.  The envelope is deeply frozen and binds these fields plus owner/host/scope,
credential epoch, deadline, payload digest and lineage through a deterministic
digest, retaining original version/metadata reasons locally. It is not a grant.
Existing authority retirement must fence source events and the role must
re-evaluate immediately before every actual use; sequential reads are not an
atomic filesystem snapshot.  It conveys no authority and must be revalidated by a future host.

## Verification

Focused Node tests cover exact Property semantics, invalid versus absent
metadata, stale rereads, parser variants, restrictive/ownership/lineage rules,
profile mismatch/false-loopback, immutability, cancellation and no runtime
integration.  Run TypeScript, focused and full Node/Python regression, build, package/tamper,
reproducibility, licenses/audit, independent full-diff review, CI and post-merge
regression. Historical
transport/UI tests and all runtime paths remain unchanged.
