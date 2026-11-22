"""OKS-03B pure retrieval/fail-closed tests; no fake model accepted by a live index."""
from __future__ import annotations

from dataclasses import replace
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.markdown import read_markdown
from engine.retrieval import (
    Predicate, RetrievalError, RetrievalIndex, PropertyValue,
    matches_predicates, parse_typed_properties, rrf_fusion,
)
from engine.scope import ScopedReader


class RetrievalUnitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root / "one.md").write_text(
            "---\nstatus: accepted\npriority: 7\nflag: true\nreviewed: 2026-11-22\n"
            'tags: ["infra","architecture"]\noptional: null\n---\n'
            "# Глава 🚀\nREQ-A-42: Архитектура [[target|alias]]\n", encoding="utf-8")
        (self.root / "two.md").write_text(
            "---\nstatus: proposed\npriority: 2\n---\n"
            "# Header\nREQ-A-420: unrelated\n", encoding="utf-8")
        self.reader = ScopedReader(self.root)
        self.addCleanup(self.reader.close)
        self.docs = tuple(read_markdown(self.reader, p) for p in ("one.md", "two.md"))
        self.index = RetrievalIndex(self.reader, self.docs, None)
        self.addCleanup(self.index.close)

    def test_standalone_experiment_lexical_not_hybrid(self):
        response = self.index.search("REQ-A-42", "lexical")
        self.assertEqual(response.status, "ok")
        self.assertEqual(response.executed_mode, "lexical")
        self.assertEqual([e.path for e in response.hits], ["one.md"])
        self.assertEqual(response.hits[0].wiki_links, ("target|alias",))
        self.assertEqual(response.hits[0].rank, 1)
        self.assertEqual(response.hits[0].generation_id, response.generation_id)
        self.assertEqual(response.hits[0].requested_mode, "lexical")

    def test_missing_dense_is_typed_failure_not_lexical_fallback(self):
        for mode in ("dense", "hybrid"):
            result = self.index.search("REQ-A-42", mode)
            self.assertEqual(result.status, "failed")
            self.assertEqual(result.error, "CAPABILITY_UNAVAILABLE")
            self.assertEqual(result.executed_mode, "none")
            self.assertEqual(result.hits, ())

    def test_source_bytes_unicode_and_anchors(self):
        result = self.index.search("REQ-A-42", "lexical")
        evidence = result.hits[0]
        raw = (self.root / evidence.path).read_bytes()
        self.assertEqual(raw[evidence.byte_start:evidence.byte_end].decode("utf-8"), evidence.excerpt)
        self.assertEqual(evidence.line_start, 10)
        self.assertIn("Архитектура", evidence.excerpt)

    def test_typed_property_filtering(self):
        accepted = self.index.search("REQ-A-42", "lexical", predicates=(Predicate(
            "status", "string", "accepted"),))
        self.assertEqual([e.path for e in accepted.hits], ["one.md"])
        for pred in (
            Predicate("priority", "number", 7),
            Predicate("flag", "boolean", True),
            Predicate("reviewed", "date", "2026-11-22"),
            Predicate("tags", "list", "architecture", "contains"),
            Predicate("optional", "null", None),
        ):
            result = self.index.search("REQ-A-42", "lexical", predicates=(pred,))
            self.assertEqual([e.path for e in result.hits], ["one.md"])
        mismatch = self.index.search("REQ-A-42", "lexical", predicates=(
            Predicate("priority", "string", "7"),))
        self.assertEqual(mismatch.hits, ())

    def test_property_types_are_not_lossily_coerced(self):
        data = {x.key: x for x in parse_typed_properties(self.docs[0])}
        self.assertEqual(data["priority"], PropertyValue("priority", "number", 7))
        self.assertEqual(data["flag"], PropertyValue("flag", "boolean", True))
        self.assertEqual(data["reviewed"], PropertyValue("reviewed", "date", "2026-11-22"))
        self.assertEqual(data["tags"], PropertyValue("tags", "list", ("infra", "architecture")))
        self.assertEqual(data["optional"], PropertyValue("optional", "null", None))
        self.assertFalse(matches_predicates(tuple(data.values()), (
            Predicate("priority", "boolean", True),)))
        # Python's True == 1 must not collapse typed YAML/JSON list members.
        typed = (PropertyValue("mixed", "list", (1, True, "1")),)
        self.assertTrue(matches_predicates(typed, (
            Predicate("mixed", "list", True, "contains"),)))
        self.assertFalse(matches_predicates(
            (PropertyValue("mixed", "list", (1,)),),
            (Predicate("mixed", "list", True, "contains"),)))

    def test_list_equality_and_membership_preserve_scalar_types(self):
        (self.root / "mixed.md").write_text(
            '---\nflags: [1, true, 1.0, null, "1"]\n---\n# Mixed\nneedle\n',
            encoding="utf-8")
        doc = read_markdown(self.reader, "mixed.md")
        index = RetrievalIndex(self.reader, (doc,), None)
        self.addCleanup(index.close)
        actual = (1, True, 1.0, None, "1")
        correct = index.search("needle", "lexical", predicates=(
            Predicate("flags", "list", actual),))
        self.assertEqual([h.path for h in correct.hits], ["mixed.md"])
        for unequal in (
            (True, True, 1.0, None, "1"),
            (1, 1, 1.0, None, "1"),
            (1, True, True, None, "1"),
            (1, True, 1, None, "1"),
            (1, True, 1.0, "null", "1"),
        ):
            with self.subTest(unequal=unequal):
                self.assertEqual(index.search("needle", "lexical", predicates=(
                    Predicate("flags", "list", unequal),)).hits, ())
        for item in actual:
            self.assertEqual(
                len(index.search("needle", "lexical", predicates=(
                    Predicate("flags", "list", item, "contains"),)).hits), 1)
        self.assertEqual(index.search("needle", "lexical", predicates=(
            Predicate("flags", "list", False, "contains"),)).hits, ())
        for invalid in (
            ([], "eq"), ((float("nan"),), "eq"), ((float("inf"),), "eq"),
            (({"nested": 1},), "eq"), (((1,),), "eq"),
            (float("inf"), "contains"), ({"nested": 1}, "contains"),
        ):
            with self.subTest(invalid=invalid), self.assertRaises(RetrievalError):
                index.search("needle", "lexical", predicates=(
                    Predicate("flags", "list", invalid[0], invalid[1]),))

    def test_filters_applied_before_candidate_top_k_for_all_modes(self):
        # 70 matching sources > MAX_RESULTS=50; the only admissible file
        # ranks strictly beyond the truncated unfiltered lexical candidates.
        for i in range(70):
            (self.root / f"bulk-{i:03d}.md").write_text(
                "---\nstatus: " + ("target" if i == 69 else "other") +
                "\n---\n# Header\nneedle alpha\n", encoding="utf-8")
        docs = tuple(read_markdown(self.reader, f"bulk-{i:03d}.md")
                     for i in range(70))
        index = RetrievalIndex(self.reader, docs, None)
        self.addCleanup(index.close)
        target = "bulk-069.md"
        self.assertEqual(len(index.lexical.search("needle", 50)), 50)
        # Only the ranking logic is unit-tested with injected artificial
        # vectors. This does NOT establish genuine model readiness, and the
        # constructor still rejects fabricated embedding implementations.
        class TestOnlyVector:
            def embed(self, _text):
                return (1.0,) + (0.0,) * 1023
        index._model = TestOnlyVector()
        index._vectors = {key: TestOnlyVector().embed("")
                          for key in index._blocks}
        variants = (
            {"predicates": (Predicate("status", "string", "target"),)},
            {"allowed_paths": frozenset({target})},
            {"predicates": (Predicate("status", "string", "target"),),
             "allowed_paths": frozenset({target})},
        )
        for mode in ("lexical", "dense", "hybrid"):
            for filters in variants:
                with self.subTest(mode=mode, filters=filters):
                    result = index.search("needle", mode, limit=10, **filters)
                    self.assertEqual(result.status, "ok")
                    self.assertEqual(result.executed_mode, mode)
                    self.assertTrue(result.hits)
                    self.assertEqual({hit.path for hit in result.hits}, {target})
                    self.assertEqual(result.hits[0].rank, 1)

    def test_typed_filter_malformed_rejected_even_when_no_candidates(self):
        bad = (
            Predicate("status", "nonsense", "accepted"),
            Predicate("priority", "number", "7"),
            Predicate("flag", "boolean", 1),
            Predicate("reviewed", "date", "2026-99-99"),
            Predicate("tags", "list", ["architecture"]),
            Predicate("status", "string", "accepted", "contains"),
            Predicate("", "string", "accepted"),
        )
        for pred in bad:
            with self.subTest(pred=pred), self.assertRaises(RetrievalError):
                self.index.search("zzzzunavailable", "lexical", predicates=(pred,))

    def test_source_mutation_rename_delete_suppressed_immediately(self):
        (self.root / "one.md").write_text("# changed\nREQ-A-42: no longer current", encoding="utf-8")
        self.assertEqual(self.index.search("REQ-A-42", "lexical").hits, ())
        (self.root / "two.md").rename(self.root / "two-renamed.md")
        self.assertEqual(self.index.search("REQ-A-420", "lexical").hits, ())
        (self.root / "one.md").unlink()
        self.assertEqual(self.index.search("REQ-A-42", "lexical").hits, ())

    def test_scope_denies_unselected_paths(self):
        result = self.index.search("REQ-A-42", "lexical", allowed_paths=frozenset({"two.md"}))
        self.assertEqual(result.hits, ())
        with self.assertRaises(RetrievalError):
            self.index.search("REQ-A-42", "lexical", allowed_paths={"one.md"})

    def test_invalid_queries_modes_and_limits(self):
        for mode in ("lexical", "hybridx", "dense"):
            for query in ("", "x" * 513, chr(0xD800)):
                with self.subTest(mode=mode, query=repr(query)), self.assertRaises(RetrievalError):
                    self.index.search(query, mode)
        for limit in (0, 51, True):
            with self.assertRaises(RetrievalError):
                self.index.search("REQ-A", "lexical", limit=limit)

    def test_consistent_generation_and_rebuild(self):
        other = RetrievalIndex(self.reader, tuple(reversed(self.docs)), None)
        self.addCleanup(other.close)
        self.assertEqual(self.index.generation_id, other.generation_id)
        (self.root / "one.md").write_text("# changed", encoding="utf-8")
        with self.assertRaises((ValueError, RetrievalError)):
            RetrievalIndex(self.reader, self.docs, None)

    def test_reject_forged_source_before_generation_commit(self):
        forged = replace(self.docs[0], blocks=(replace(
            self.docs[0].blocks[-1], text="INVENTED EVIDENCE"), *self.docs[0].blocks[:-1]))
        with self.assertRaises((ValueError, RetrievalError)):
            RetrievalIndex(self.reader, (forged,), None)

    def test_test_double_not_accepted_as_live_dense_model(self):
        # This stub does NOT produce a production index or count toward CAP-04/05.
        class Fake:
            identity = object()
            def embed(self, text):
                return [0.0] * 1024
        with self.assertRaises(RetrievalError) as raised:
            RetrievalIndex(self.reader, self.docs, Fake())
        self.assertEqual(raised.exception.code, "MODEL_INCOMPATIBLE")


class FusionTests(unittest.TestCase):
    def test_rrf_two_independent_legs_and_deterministic_tie_breaks(self):
        ranked = rrf_fusion(("a", "b"), ("b", "c"))
        self.assertEqual(ranked[0][0], "b")
        self.assertEqual(ranked[0][1:3], (2, 1))
        self.assertGreater(ranked[0][3], ranked[1][3])
        self.assertEqual(rrf_fusion(("x",), ("y",))[0][0], "x")
        self.assertEqual(rrf_fusion(("x",), ("y",)), rrf_fusion(("x",), ("y",)))

    def test_rrf_reject_duplicate_inputs(self):
        with self.assertRaises(RetrievalError):
            rrf_fusion(("a", "a"), ("b",))
        with self.assertRaises(RetrievalError):
            rrf_fusion(("a",), ("b", "b"))


if __name__ == "__main__":
    unittest.main()
