"""Frozen oracle integrity checks, not extractor or runtime tests."""
from hashlib import sha256
from pathlib import Path
import base64
import json
import sys
import tempfile
import unittest
from urllib.parse import unquote
from xml.etree import ElementTree as ET
import zlib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from benchmarks.multiformat.generate_text_diagram import (
    canonical_json, fixtures, manifest, materialize,
)

FROZEN = ROOT / "benchmarks" / "multiformat"


class TextDiagramFixtureFreeze(unittest.TestCase):
    def setUp(self):
        self.sources = fixtures()
        self.oracle_bytes = (FROZEN / "oracle-text-diagram.json").read_bytes()
        self.oracle = json.loads(self.oracle_bytes)

    def test_exact_frozen_manifest_and_two_materializations(self):
        frozen = (FROZEN / "manifest-text-diagram.json").read_bytes()
        self.assertEqual(canonical_json(manifest(self.sources, self.oracle_bytes)), frozen)
        self.assertEqual(fixtures(), self.sources)
        with tempfile.TemporaryDirectory() as directory:
            a, b = Path(directory) / "a", Path(directory) / "b"
            materialize(a, self.sources)
            materialize(b, fixtures())
            for path, data in self.sources.items():
                self.assertEqual((a / path).read_bytes(), data)
                self.assertEqual((b / path).read_bytes(), data)
                self.assertEqual(sha256(data).hexdigest(), json.loads(frozen)["sources"][path]["sha256"])
            with self.assertRaises(FileExistsError):
                materialize(a, {"m01.md": b"overwrite"})
            self.assertEqual((a / "m01.md").read_bytes(), self.sources["m01.md"])

    def test_expected_text_lines_and_original_byte_spans(self):
        text = [r for r in self.oracle["positive"] if r["format"] != "drawio"]
        self.assertEqual(len(text), 16)
        for row in text:
            raw = self.sources[row["source"]]
            lines = raw.decode(row["encoding"], errors="strict").splitlines(keepends=True)
            for hit in row["judgments"]:
                line = lines[hit["line"] - 1]
                self.assertEqual(line.count(hit["query"]), 1)
                start = len("".join(lines[:hit["line"] - 1]).encode(row["encoding"]))
                start += len(line[:line.index(hit["query"])].encode(row["encoding"]))
                expected = hit["query"].encode(row["encoding"])
                self.assertEqual((start, start + len(expected)), (hit["byteStart"], hit["byteEnd"]))
                self.assertEqual(raw[hit["byteStart"]:hit["byteEnd"]], expected)
                self.assertEqual(sum(expected in other for other in self.sources.values()), 1)
        self.assertIn(b"\r\n", self.sources["m01.md"])
        self.assertIn("🧩".encode(), self.sources["m02.md"])
        self.assertNotEqual(self.sources["t03.txt"], self.sources["t03.txt"].decode("cp1251").encode())

    def test_drawio_authored_native_labels_and_exact_edges(self):
        all_labels = {}
        for row in self.oracle["positive"]:
            if row["format"] != "drawio":
                continue
            root = ET.fromstring(self.sources[row["source"]])
            self.assertEqual(root.attrib["compressed"], str(row["compressed"]).lower())
            pages = {}
            for page in root.findall("diagram"):
                if row["compressed"]:
                    model = ET.fromstring(unquote(zlib.decompress(
                        base64.b64decode(page.text, validate=True), wbits=-15).decode("ascii")))
                else:
                    model = page.find("mxGraphModel")
                self.assertIsNotNone(model)
                pages[page.attrib["id"]] = {cell.attrib["id"]: cell for cell in model.find("root")}
            self.assertEqual(set(pages), {"p1", "p2"})
            all_labels[row["source"]] = [item.get("label") if item.tag == "object" else item.get("value") for cells in pages.values() for item in cells.values()]
            for hit in row["judgments"]:
                cells = pages[hit["page"]]
                item = cells[hit["cell"]]
                label = item.get("label") if item.tag == "object" else item.get("value")
                self.assertEqual(label, hit["query"])
                if "target" in hit:
                    self.assertEqual(item.get("source"), hit["source"])
                    self.assertEqual(item.get("target"), hit["target"])
                    self.assertIn(hit["source"], cells)
                    self.assertIn(hit["target"], cells)
        for row in self.oracle["positive"]:
            if row["format"] == "drawio":
                for hit in row["judgments"]:
                    self.assertEqual(sum(labels.count(hit["query"]) for labels in all_labels.values()), 1)

    def test_oracle_partition_and_negative_intent(self):
        expected = {r["source"] for r in self.oracle["positive"] + self.oracle["negative"]}
        self.assertEqual(len(expected), 29)
        self.assertEqual(set(self.sources), expected | set(self.oracle["ownershipScenarios"]["sources"]))
        self.assertEqual(len(self.oracle["positive"]), 20)
        counts = {}
        for r in self.oracle["positive"]:
            key = (r["format"], r.get("encoding"), r.get("compressed"))
            counts[key] = counts.get(key, 0) + 1
        self.assertTrue(all(n == 2 for n in counts.values()))
        with self.assertRaises(UnicodeDecodeError):
            self.sources["n01.txt"].decode("utf-8")
        with self.assertRaises(UnicodeDecodeError):
            self.sources["n02.txt"].decode("cp1251")
        with self.assertRaises(UnicodeDecodeError):
            self.sources["n03.txt"].decode("utf-8")
        self.assertIn(b"!includeurl https://example.invalid/", self.sources["n04.puml"])
        broken = ET.fromstring(self.sources["n05.drawio"])
        self.assertEqual(broken.attrib["compressed"], "true")
        payload = broken.find("diagram")
        self.assertIsNotNone(payload)
        self.assertEqual(len(payload), 0)
        with self.assertRaises(ValueError):
            base64.b64decode(payload.text, validate=True)
        with self.assertRaises(ET.ParseError):
            ET.fromstring(self.sources["n06.drawio"])
        self.assertIn(b"target=\"missing\"", self.sources["n07.drawio"])
        self.assertIn(b"<!DOCTYPE", self.sources["n09.drawio"])
        self.assertEqual(self.sources["x01.drawio"], self.sources["copy.drawio"])
        self.assertIn(b"ai_indexing: full", self.sources["owner-a.md"])
        self.assertIn(b"ai_indexing: none", self.sources["owner-b.md"])
        for query in self.oracle["absentQueries"]:
            self.assertFalse(any(query.encode() in raw for raw in self.sources.values()))
        self.assertEqual(self.oracle["ownershipScenarios"]["status"], "declarative-unadmitted")
        self.assertTrue(self.oracle["noCapabilityClaim"])


if __name__ == "__main__":
    unittest.main()
