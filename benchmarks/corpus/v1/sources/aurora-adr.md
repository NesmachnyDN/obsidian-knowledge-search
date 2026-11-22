---
status: accepted
component: Aurora
---
# ADR-101: Aurora transport
## Decision
Aurora uses mutual TLS for service traffic; plain HTTP is prohibited.
See [[aurora-rotation]] for certificate lifecycle.
## Rationale
Service identity is verified before any request is transmitted.
