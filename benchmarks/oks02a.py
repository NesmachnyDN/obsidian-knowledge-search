"""Reproducible corpus-based lexical baseline; no private inputs."""
import argparse
import json
import platform
import resource
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from benchmarks.corpus_v1 import ROOT, read_json, sha, validate
from benchmarks.lexical_metrics import score, summarize
from engine.lexical import LexicalIndex, MAX_RESULTS
from engine.markdown import read_markdown
from engine.scope import ScopedReader


def run(split):
    manifest, oracle = validate()
    reader = ScopedReader(ROOT / 'sources')
    index = None
    try:
        start = time.perf_counter()
        documents = tuple(read_markdown(reader, row['path']) for row in manifest['sources'])
        parsed = time.perf_counter() - start
        sources = {doc.path: reader.read(doc.path).data for doc in documents}
        count = locator_errors = 0
        statuses = {}
        for doc in documents:
            statuses[doc.status] = statuses.get(doc.status, 0) + 1
            actual = [(b.span.line_start, b.kind, b.text) for b in doc.blocks]
            expected = [(r['line'], r['kind'], r['text']) for r in oracle[doc.path]]
            if actual != expected:
                raise ValueError('source oracle mismatch: ' + doc.path)
            for b in doc.blocks:
                count += 1
                raw = sources[doc.path]
                if (raw[b.span.start:b.span.end] != b.text.encode()
                        or raw[:b.span.start].count(b'\n') + 1 != b.span.line_start):
                    locator_errors += 1
                for cell in b.cells:
                    if raw[cell.span.start:cell.span.end] != cell.text.encode():
                        locator_errors += 1
        start = time.perf_counter()
        index = LexicalIndex(reader, documents)
        indexing = time.perf_counter() - start
        queries = read_json(ROOT / (split + '.json'))
        rows, timings = [], []
        for q in queries:
            start = time.perf_counter()
            hits = index.search(q['query'], MAX_RESULTS)
            timings.append((time.perf_counter() - start) * 1000)
            ranked = [(b.path, b.span.line_start) for b in hits]
            if len(set(ranked)) != len(ranked):
                raise ValueError('duplicate span')
            for b in hits:
                if sources[b.path][b.span.start:b.span.end] != b.text.encode():
                    locator_errors += 1
            labels = {(r['path'], r['line']): r['grade'] for r in q['labels']}
            rows.append({'id': q['id'], 'exact': q['exact'], 'unanswerable': q['unanswerable'],
                         'ranked': ranked, 'metrics': score(ranked, labels)})
        if locator_errors:
            raise ValueError('invalid locator')
        # All document ranks are derived from the same bounded top-50 span list.
        from statistics import median
        return {'split': split, 'corpus_version': manifest['version'],
                'manifest_sha256': sha((ROOT / 'manifest.json').read_bytes()),
                'judgment_sha256': manifest['judgments'][split+'.json'],
                'runtime': {'python': platform.python_version(), 'sqlite': sqlite3.sqlite_version},
                'implementation_sha256': {p: sha((ROOT.parents[2] / p).read_bytes())
                                          for p in ('engine/document.py', 'engine/markdown.py',
                                                    'engine/lexical.py', 'benchmarks/lexical_metrics.py',
                                                    'benchmarks/oks02a.py', 'benchmarks/corpus_v1.py')},
                'config': {'candidate_limit': MAX_RESULTS, 'unit': 'physical-line',
                           'order': 'fts5-bm25-rowid', 'query': 'casefolded-exact-terms-or'},
                'structure': {'sources': len(documents), 'statuses': statuses, 'lines': count,
                              'indexed_blocks': len(index.blocks), 'locator_errors': locator_errors,
                              'oracle_coverage': 1.0},
                'summary': summarize(rows), 'per_query': rows,
                'observed': {'parse_ms': parsed*1000, 'index_ms': indexing*1000,
                             'query_p50_ms': median(timings),
                             'query_p95_ms': sorted(timings)[max(0, (95*len(timings)+99)//100-1)],
                             'sqlite_page_bytes': index.size_bytes(),
                             'process_peak_rss_kib': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}}
    finally:
        if index is not None:
            index.close()
        reader.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--split', choices=['tuning', 'held_out'], required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.split), indent=2, sort_keys=True))
