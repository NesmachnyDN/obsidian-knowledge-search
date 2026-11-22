"""Benchmark-only validation of the frozen source and judgment manifest."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent / 'corpus' / 'v1'


def read_json(path):
    return json.loads(path.read_bytes())


def sha(data):
    return hashlib.sha256(data).hexdigest()


def validate(root=ROOT):
    manifest = read_json(root / 'manifest.json')
    if manifest['version'] != 'v1':
        raise ValueError('unsupported corpus version')
    names = [item['path'] for item in manifest['sources']]
    if (len(names) < 18 or len(set(names)) != len(names)
            or any(Path(name).name != name or not name.endswith('.md') for name in names)
            or set(names) != {p.name for p in (root / 'sources').iterdir()}):
        raise ValueError('manifest source set')
    for item in manifest['sources']:
        if sha((root / 'sources' / item['path']).read_bytes()) != item['sha256']:
            raise ValueError('source digest mismatch')
    if set(manifest['judgments']) != {'oracle.json', 'tuning.json', 'held_out.json'}:
        raise ValueError('judgment set')
    for name, digest in manifest['judgments'].items():
        if sha((root / name).read_bytes()) != digest:
            raise ValueError('judgment digest mismatch')
    oracle = read_json(root / 'oracle.json')
    if set(oracle) != set(names):
        raise ValueError('oracle source set')
    for name, rows in oracle.items():
        lines = (root / 'sources' / name).read_text(encoding='utf-8').splitlines()
        if [(r['line'], r['text']) for r in rows] != list(enumerate(lines, 1)):
            raise ValueError('oracle text/line mismatch')
    ids, queries = set(), set()
    for split in ('tuning', 'held_out'):
        rows = read_json(root / (split + '.json'))
        if len(rows) < 15:
            raise ValueError('split too small')
        for item in rows:
            if (item['id'] in ids or item['query'] in queries
                    or item['unanswerable'] != (not item['labels'])):
                raise ValueError('invalid query/split')
            ids.add(item['id'])
            queries.add(item['query'])
            seen = set()
            for label in item['labels']:
                path, line, grade = label['path'], label['line'], label['grade']
                key = (path, line)
                if (path not in oracle or type(line) is not int
                        or not 1 <= line <= len(oracle[path]) or grade not in (1, 2)
                        or key in seen):
                    raise ValueError('invalid relevance judgment')
                seen.add(key)
    return manifest, oracle
