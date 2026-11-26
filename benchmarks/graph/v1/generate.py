"""Deterministic synthetic graph acceptance corpus; no runtime or real sources."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).parent
FILES = {}
EDGES = []
QUERIES = []
MAPPING = {
    "schemaVersion": "oks-06b-mapping-v1", "businessIdKey": "id", "aliasKeys": ["alias"],
    "rules": [
        {"relationId": "depends", "propertyKey": "depends", "direction": "author-to-target", "targetEncoding": "business-id"},
        {"relationId": "provides", "propertyKey": "provides", "direction": "target-to-author", "targetEncoding": "business-id"},
    ],
}

def note(path, ident, body, props=()):
    assert path not in FILES
    FILES[path] = "\n".join(["---", "id: " + ident, *props, "---", body, ""])

def edge(author, target, relation, anchor, reverse=False):
    EDGES.append({"author": author, "from": target if reverse else author,
                  "to": author if reverse else target, "relationId": relation,
                  "kind": "navigation" if relation is None else "relation",
                  "anchors": [anchor]})

for i in range(40):
    lang = "ru" if i % 2 == 0 else "en"
    required = i < 20
    prefix = f"case-{i:02d}"
    a, b, c = [f"{prefix}-{x}.md" for x in "abc"]
    ids = [f"ID-{i:02d}-{x}" for x in "ABC"]
    key = f"REQ-GRAPH-{i:03d}"
    body = key + (": Требование к интеграционному контракту." if lang == "ru" else ": Integration contract requirement.")
    context = "Подтверждающий проектный контекст." if lang == "ru" else "Supporting architecture context."
    other = "Независимый эксплуатационный контекст." if lang == "ru" else "Unrelated operational context."
    labels = {a: 2}
    expected = []
    direction = "outgoing"
    relation = "depends"
    depth = 1
    if required and i % 4 == 1:
        direction = "incoming"
        note(a, ids[0], body)
        note(b, ids[1], context, [f"depends: {ids[0]}"])
        edge(b, a, "depends", f"depends: {ids[0]}")
        expected.append({"source": b, "steps": [{"author": b, "from": b, "to": a, "relationId": "depends", "traversal": "reverse"}]})
        note(c, ids[2], other)
        labels[b] = 1
    elif required and i % 4 == 2:
        depth = 2
        note(a, ids[0], body, [f"depends: {ids[1]}"])
        note(b, ids[1], context, [f"depends: {ids[2]}"])
        note(c, ids[2], context + " 2.")
        edge(a, b, "depends", f"depends: {ids[1]}")
        edge(b, c, "depends", f"depends: {ids[2]}")
        first = {"author": a, "from": a, "to": b, "relationId": "depends", "traversal": "forward"}
        second = {"author": b, "from": b, "to": c, "relationId": "depends", "traversal": "forward"}
        expected.extend([{"source": b, "steps": [first]}, {"source": c, "steps": [first, second]}])
        labels.update({b: 1, c: 1})
    elif required and i % 4 == 3:
        relation = "provides"
        alias = f"ALIAS-{i:02d}-A"
        note(a, ids[0], body, [f"alias: {alias}"])
        note(b, ids[1], context, [f"provides: {alias}"])
        edge(b, a, "provides", f"provides: {alias}", True)
        expected.append({"source": b, "steps": [{"author": b, "from": a, "to": b, "relationId": "provides", "traversal": "forward"}]})
        note(c, ids[2], other)
        labels[b] = 1
    else:
        note(a, ids[0], body, [f"depends: {ids[1]}"])
        note(b, ids[1], context if required else other)
        note(c, ids[2], other)
        edge(a, b, "depends", f"depends: {ids[1]}")
        expected.append({"source": b, "steps": [{"author": a, "from": a, "to": b, "relationId": "depends", "traversal": "forward"}]})
        if required:
            labels[b] = 1
    QUERIES.append({"id": f"held-{i:02d}", "language": lang, "category": "graph-required" if required else "ordinary",
                    "query": key, "labels": labels, "seed": a, "expectedPaths": expected,
                    "expansion": {"depth": depth, "direction": direction, "relationIds": [relation], "fanOut": 16, "maxExpanded": 32}})

# Explicit negative/ambiguity/cycle/privacy fixtures outside held-out queries.
note("neg-duplicate-a.md", "DUP-ID", "Synthetic duplicate A.", ["alias: DUP-ALIAS"])
note("neg-duplicate-b.md", "DUP-ID", "Synthetic duplicate B.", ["alias: DUP-ALIAS"])
note("neg-ambiguous.md", "AMB-ID", "Synthetic ambiguous.", ['depends: ["DUP-ID","DUP-ALIAS"]'])
note("neg-missing.md", "MISS-ID", "Synthetic missing. [[unresolved]]", ["depends: MISSING-ID"])
note("neg-cycle-a.md", "CYCLE-A", "Synthetic cycle A. [[neg-cycle-b]]", ["depends: CYCLE-B"])
note("neg-cycle-b.md", "CYCLE-B", "Synthetic cycle B.", ["depends: CYCLE-A"])
edge("neg-cycle-a.md", "neg-cycle-b.md", "depends", "depends: CYCLE-B")
edge("neg-cycle-b.md", "neg-cycle-a.md", "depends", "depends: CYCLE-A")
edge("neg-cycle-a.md", "neg-cycle-b.md", None, "Synthetic cycle A. [[neg-cycle-b]]")
note("neg-private.md", "PRIVATE-ID", "Synthetic private only.", ["llm_processing: private"])
note("neg-local.md", "LOCAL-ID", "Synthetic local only.", ["depends: PRIVATE-ID"])
edge("neg-local.md", "neg-private.md", "depends", "depends: PRIVATE-ID")
assert len(FILES) == 128
base = sorted(FILES)
base_edges = len(EDGES)
for i in range(384):
    path = f"stress-{i:03d}.md"
    props = [f"depends: STRESS-{i-1:03d}"] if i else []
    note(path, f"STRESS-{i:03d}", "Дополнительная синтетическая заметка." if i % 2 == 0 else "Additional synthetic note.", props)
    if i:
        edge(path, f"stress-{i-1:03d}.md", "depends", props[0])
assert len(FILES) == 512 and len(QUERIES) == 40
payload = {
    "schema": "oks-06b-acceptance-v1", "mapping": MAPPING, "heldOut": QUERIES,
    "basePaths": base, "baseEdgeCount": base_edges, "expectedEdges": EDGES, "files": FILES,
    "expectedCoverage": {"ambiguous-target": 2, "unresolved-target": 2},
}
raw = (json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()
(ROOT / "corpus.json").write_bytes(raw)
manifest = {"schema": "oks-06b-frozen-v1", "corpusSha256": hashlib.sha256(raw).hexdigest(),
            "heldOut": [q["id"] for q in QUERIES], "baseSources": 128, "stressSources": 512,
            "sourceSha256": {k: hashlib.sha256(v.encode()).hexdigest() for k,v in sorted(FILES.items())}}
(ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf8")
