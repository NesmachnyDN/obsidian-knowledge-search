# OKS-06H POLICY.3d3 — retained citation navigation

Base: 1f995afe57ba92866578fd0522b9d44f56d77e8f (POLICY.3d2). Dependencies: ADR-0018/0019, SPEC AC-11-CHAT-03, AC-06/09/10, POLICY01/03.

Bounded slice: the host resolves a citation only from its own completed-turn history by session owner, turn ID, claim index and citation index. No caller-provided evidence, path, locator or provider operation. Reuse the verified-history physical slot, scope capture, version/policy/configuration guards, deadline and retirement. Reject foreign or missing references. Reuse SourceNavigator and canonical byte/locator checks; verify the entire retained scope before native open and after the open before selection. Guard native boundaries against retirement. Native open is not transactional: once dispatched it cannot be undone; a retired operation must not select stale text or publish success. Existing ordinary search navigation retains its behavior.

Acceptance: synthetic tests for valid and foreign/stale references, invalid indices, scope drift without source event, logical retirement during native open with physical drain, no stale selection, and legacy regression. Typecheck, complete Node/Python/package tests, license and reproducibility checks, independent pinned full-diff review, CI and develop post-merge regression. No native host or actual provider admission in this slice.
