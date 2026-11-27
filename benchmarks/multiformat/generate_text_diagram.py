"""Generate the frozen synthetic text/diagram subset; never run an extractor.

No third-party packages, network, real source data or Office/diagram rendering.
The raw-DEFLATE stored block is intentionally deterministic across zlib versions.
"""
from __future__ import annotations

import argparse
import base64
from hashlib import sha256
import json
from pathlib import Path
import struct
from urllib.parse import quote
from xml.sax.saxutils import quoteattr


def _text(value: str, encoding: str = "utf-8") -> bytes:
    return value.encode(encoding, errors="strict")


def _page(prefix: str, suffix: str) -> str:
    """Known authored graph, not reconstructed from a candidate."""
    return (
        '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>'
        f'<mxCell id="n1" value={quoteattr(prefix + "-START")} vertex="1" parent="1">'
        '<mxGeometry x="10" y="10" width="100" height="50" as="geometry"/></mxCell>'
        f'<object id="n2" label={quoteattr(suffix)}><mxCell vertex="1" parent="1">'
        '<mxGeometry x="200" y="10" width="100" height="50" as="geometry"/></mxCell></object>'
        f'<mxCell id="e1" value={quoteattr(prefix + "-EDGE")} edge="1" parent="1" source="n1" target="n2">'
        '<mxGeometry relative="1" as="geometry"/></mxCell></root></mxGraphModel>'
    )


def _compressed(model: str) -> str:
    data = quote(model, safe="~!*'()-._").encode("ascii")
    if len(data) > 65535:
        raise ValueError("fixture exceeds one DEFLATE block")
    # RFC 1951 final stored block, little-endian LEN/NLEN.
    block = b"\x01" + struct.pack("<HH", len(data), len(data) ^ 0xFFFF) + data
    return base64.b64encode(block).decode("ascii")


def _drawio(a: str, b: str, ru: str, compressed: bool) -> bytes:
    first = _page(a, "Synthetic control")
    second = _page(b, ru)
    if compressed:
        first, second = _compressed(first), _compressed(second)
    return _text(
        f'<mxfile compressed="{str(compressed).lower()}">'
        f'<diagram id="p1" name="Page 1">{first}</diagram>'
        f'<diagram id="p2" name="Page 2">{second}</diagram></mxfile>'
    )


def fixtures() -> dict[str, bytes]:
    result = {
        "m01.md": _text("# Synthetic control\r\nREQ-MA-101: СХЕМА-МА-101\r\n"),
        "m02.md": _text("# Synthetic control\nREQ-MA-102: СХЕМА-МА-102 🧩\n"),
        "t01.txt": _text("Control\r\nREQ-TA-101: СХЕМА-ТА-101\r\n"),
        "t02.txt": _text("Control\nREQ-TA-102: СХЕМА-ТА-102 🧩\n"),
        "t03.txt": _text("Control\r\nREQ-TA-103: СХЕМА-ТА-103\r\n", "cp1251"),
        "t04.txt": _text("Control\nREQ-TA-104: СХЕМА-ТА-104\n", "cp1251"),
        "d01.mermaid": _text('flowchart LR\n A["REQ-DA-101"] --> B["СХЕМА-ДА-101"]\n'),
        "d02.mermaid": _text('flowchart LR\r\n A["REQ-DA-102"] --> B["СХЕМА-ДА-102"]\r\n'),
        "d03.mmd": _text('flowchart TD\n A["REQ-DA-103"] --> B["СХЕМА-ДА-103"]\n'),
        "d04.mmd": _text('flowchart TD\r\n A["REQ-DA-104"] --> B["СХЕМА-ДА-104"]\r\n'),
        "d05.uml": _text('@startuml\n component "REQ-DA-105" as A\n component "СХЕМА-ДА-105" as B\n A --> B\n@enduml\n'),
        "d06.uml": _text('@startuml\r\n component "REQ-DA-106" as A\r\n component "СХЕМА-ДА-106" as B\r\n A --> B\r\n@enduml\r\n'),
        "d07.puml": _text('@startuml\n component "REQ-DA-107" as A\n component "СХЕМА-ДА-107" as B\n A --> B\n@enduml\n'),
        "d08.puml": _text('@startuml\r\n component "REQ-DA-108" as A\r\n component "СХЕМА-ДА-108" as B\r\n A --> B\r\n@enduml\r\n'),
        "d09.plantuml": _text('@startuml\n component "REQ-DA-109" as A\n component "СХЕМА-ДА-109" as B\n A --> B\n@enduml\n'),
        "d10.plantuml": _text('@startuml\r\n component "REQ-DA-110" as A\r\n component "СХЕМА-ДА-110" as B\r\n A --> B\r\n@enduml\r\n'),
        "x01.drawio": _drawio("REQ-XA-101", "REQ-XA-102", "СХЕМА-ХА-102", False),
        "x02.drawio": _drawio("REQ-XA-103", "REQ-XA-104", "СХЕМА-ХА-104", False),
        "x03.drawio": _drawio("REQ-XA-105", "REQ-XA-106", "СХЕМА-ХА-106", True),
        "x04.drawio": _drawio("REQ-XA-107", "REQ-XA-108", "СХЕМА-ХА-108", True),
        # All deliberately invalid/limited cases are explicitly labeled in the oracle.
        "n01.txt": b"invalid \xff\x00\n",
        "n02.txt": b"\x98\n",  # undefined CP1251 byte
        "n03.txt": _text("Неоднозначная кодировка\n", "cp1251"),
        "n04.puml": _text('@startuml\n!includeurl https://example.invalid/synthetic.puml\ncomponent "LOCAL-ONLY-401"\n@enduml\n'),
        "n05.drawio": b'<mxfile compressed="true"><diagram id="bad">not-valid-base64!</diagram></mxfile>',
        "n06.drawio": b'<mxfile><diagram><mxGraphModel><root></mxGraphModel></diagram></mxfile>',
        "n07.drawio": _text('<mxfile compressed="false"><diagram id="p1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="n1" vertex="1" parent="1" value="LOCAL-ONLY-402"/><mxCell id="e1" edge="1" source="n1" target="missing" parent="1" value="LOCAL-EDGE-402"/></root></mxGraphModel></diagram></mxfile>'),
        "n08.drawio": _text("not a diagram\n"),
        "n09.drawio": b'<!DOCTYPE mxfile [<!ENTITY x SYSTEM "https://example.invalid/synthetic.dtd">]><mxfile><diagram>&x;</diagram></mxfile>',
        "owner-a.md": _text("---\nai_indexing: full\nllm_processing: external\n---\n# Synthetic card A\n[[x01.drawio]]\n"),
        "owner-b.md": _text("---\nai_indexing: none\nllm_processing: private\n---\n# Synthetic card B\n[[x01.drawio]]\n"),
        "backlink.md": _text("# Synthetic unrelated backlink\n[[x01.drawio]]\n"),
    }
    # Ownership and identity are test scenario expectations, not inferred from links.
    result["copy.drawio"] = result["x01.drawio"]
    return result


def canonical_json(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def manifest(sources: dict[str, bytes], oracle_bytes: bytes) -> dict:
    return {
        "schema": "oks-06g1b-text-diagram-v1",
        "oracle_sha256": sha256(oracle_bytes).hexdigest(),
        "sources": {name: {"sha256": sha256(data).hexdigest(), "bytes": len(data)}
                    for name, data in sorted(sources.items())},
    }


def materialize(output: Path, sources: dict[str, bytes]) -> None:
    """Create a fresh disposable directory; never replace any existing file."""
    if not sources or len(sources) > 64:
        raise ValueError("fixture count")
    if any(not isinstance(name,str) or not name or Path(name).name != name or name in (".","..")
           or "\\" in name or "\0" in name or not isinstance(data,bytes) or len(data)>65536
           for name,data in sources.items()):
        raise ValueError("fixture identity/bound")
    output.mkdir(exist_ok=False)
    for name, data in sorted(sources.items()):
        with (output / name).open("xb") as handle:
            handle.write(data)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="new disposable fixture directory")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    sources = fixtures()
    expected = manifest(sources, (root / "oracle-text-diagram.json").read_bytes())
    if canonical_json(expected) != (root / "manifest-text-diagram.json").read_bytes():
        raise SystemExit("frozen fixture/oracle mismatch")
    materialize(args.output, sources)
    print(f"Generated {len(sources)} frozen synthetic files; no extraction executed.")


if __name__ == "__main__":
    main()
