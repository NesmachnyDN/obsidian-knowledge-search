"""Run one structured extraction case in a bounded, offline process."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import socket
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from engine.extraction import STRUCTURED_PDF, STRUCTURED_SCAN, extract
from engine.model_artifacts import MANIFEST
from engine.scope import ScopedReader
from benchmarks.extraction.run import evaluate
from benchmarks.extraction.structural_oracle import ORACLE, score_layout

ROOT = Path(__file__).resolve().parent


def runtime_cgroup():
    line = next(s for s in Path('/proc/self/cgroup').read_text().splitlines() if s.startswith('0::'))
    cgroup = Path('/sys/fs/cgroup') / line.split(':',2)[2].lstrip('/')
    for field, limit in (('memory.max', 4*1024**3), ('memory.swap.max', 0), ('pids.max', 128)):
        if int((cgroup/field).read_text()) > limit:
            raise ValueError('ineffective cgroup bound: '+field)
    quota, period = (cgroup/'cpu.max').read_text().split()
    if int(quota) / int(period) > 2 or len(os.sched_getaffinity(0)) > 2:
        raise ValueError('ineffective CPU bound')
    return cgroup


def run(name, artifacts, tessdata):
    if {n for _,n in socket.if_nameindex()} - {'lo'}:
        raise ValueError('offline namespace required')
    cgroup = runtime_cgroup()
    import torch
    if torch.version.cuda is not None or torch.cuda.is_available():
        raise ValueError('CPU-only torch required')
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    oracle_path = ROOT / 'expected.json'
    assert hashlib.sha256(oracle_path.read_bytes()).hexdigest() == manifest['expectations_sha256']
    oracle = json.loads(oracle_path.read_text())['documents'][name]
    reader = ScopedReader(ROOT / 'fixtures')
    start, cpu = time.perf_counter(), time.process_time()
    try:
        profile = STRUCTURED_SCAN if name == 'scan.pdf' else STRUCTURED_PDF
        doc = extract(reader, name, profile, artifacts=artifacts, tessdata=tessdata)
        assert doc.digest == manifest['sources'][name]['sha256']
        result = evaluate(doc, oracle)
        result['layout_oracle_sha256'] = hashlib.sha256(ORACLE.read_bytes()).hexdigest()
        result['layout_oracle'] = score_layout(doc, name, oracle['page_dimensions'][1])
        result['blocks_detail'] = [
            {'kind': b.kind, 'text': b.text, 'headings': b.headings, 'page': b.page,
             'clause': b.clause, 'ref': b.native.item_ref, 'layer': b.native.content_layer,
             'representation': b.native.representation,
             'locations': [{'page': loc.page, 'bbox': loc.bbox, 'origin': loc.coordinate_origin,
                            'char_span': loc.char_span} for loc in b.native.locations],
             'cells': [{'text': c.text, 'row_range': c.native.row_range,
                        'col_range': c.native.col_range, 'bbox': c.native.cell_bbox,
                        'origin': c.native.cell_coordinate_origin} for c in b.cells]}
            for b in doc.blocks]
        result['source_digest'] = doc.digest
        result['extraction_profile'] = profile
        result['model_manifest_sha256'] = hashlib.sha256(MANIFEST.read_bytes()).hexdigest()
        result['seconds'] = time.perf_counter() - start
        result['process_cpu_seconds'] = time.process_time() - cpu
        result['network_interfaces'] = ['lo']
        result['torch'] = torch.__version__
        result['peak_rss_kib'] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        result['peak_child_rss_kib'] = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
        result['cgroup_memory_peak_bytes'] = int((cgroup / 'memory.peak').read_text())
        result['cgroup_cpu_stat'] = dict(s.split() for s in (cgroup / 'cpu.stat').read_text().splitlines())
        return result
    finally:
        reader.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('fixture', choices=['policy.pdf', 'scan.pdf'])
    parser.add_argument('--artifacts', type=Path, required=True)
    parser.add_argument('--tessdata', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.fixture, args.artifacts, args.tessdata),
                     ensure_ascii=False, indent=2, sort_keys=True))
