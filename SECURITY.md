# Security and privacy

OKS is intended to process vault contents locally. Design goals only until validated. No telemetry, cloud inference or external document transmission by default. Explicit provisioning of reviewed model artifacts is distinct from runtime egress. Treat document contents as untrusted data, never as executable instructions. Reject traversal and symlink escape, enforce allowed roots and bounded input sizes, and avoid executing embedded document code or arbitrary commands. Authenticate any loopback interface; prefer local stdio and keep network listeners off by default. Logs and exported diagnostics are metadata-only by default and redact private paths. Do not publish private fixtures, indexes, embeddings, crash dumps, credentials or workstation details.

Report vulnerabilities privately to the repository maintainer via GitHub private vulnerability reporting if enabled. Do not include sensitive details in public issues. No guaranteed response SLA.
