"""Synthetic model-free extraction experiment; labels never enter extract()."""
import argparse
import hashlib
import json
from pathlib import Path
import resource
import socket
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from engine.extraction import DOCX, OCR, PDF, extract
from engine.scope import ScopedReader

ROOT = Path(__file__).resolve().parent


def normalize(text):
    return ' '.join(text.split())


def coverage(expected, text):
    return {'total': len(expected), 'matched': sum(normalize(t) in normalize(text) for t in expected),
            'missing': [t for t in expected if normalize(t) not in normalize(text)]}


def distance(a, b):
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        row = [i]
        for j, y in enumerate(b, 1):
            row.append(min(row[-1] + 1, prev[j] + 1, prev[j-1] + (x != y)))
        prev = row
    return prev[-1]


def alternatives(name, data):
    if name.endswith('.docx'):
        from docx import Document
        from io import BytesIO
        d = Document(BytesIO(data))
        parts = [p.text for p in d.paragraphs]
        for s in d.sections:
            parts.extend(p.text for p in s.header.paragraphs + s.footer.paragraphs)
        parts.extend(c.text for t in d.tables for row in t.rows for c in row.cells)
        return '\n'.join(parts)
    return subprocess.run(['/usr/bin/pdftotext','-layout','-','-'],input=data,
                          stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                          timeout=10,check=True).stdout.decode('utf-8')


def evaluate(doc, oracle):
    text = '\n'.join(b.text for b in doc.blocks)
    headings = [b.text for b in doc.blocks if b.kind == 'heading']
    table_cells = [c for b in doc.blocks for c in b.cells]
    locations = []
    for offset, b in enumerate(doc.blocks):
        assert b.order == offset and b.path == doc.path and b.digest == doc.digest
        assert b.span is None and b.native and b.native.item_ref
        for c in b.cells:
            assert c.span is None and c.native and c.native.row_range and c.native.col_range
        for loc in b.native.locations:
            assert doc.page_count and 1 <= loc.page <= doc.page_count
            w,h = oracle['page_dimensions']
            l,t,r,bottom = loc.bbox
            assert 0 <= l <= r <= w+0.1 and 0 <= min(t,bottom) <= max(t,bottom) <= h+0.1
            locations.append(loc)
    result = {'status':doc.status,'diagnostics':doc.diagnostics,'blocks':len(doc.blocks),
              'text':coverage(oracle['expected_text'],text),
              'headings':coverage(oracle.get('headings',[]),'\n'.join(headings)),
              'table_cells':coverage(oracle.get('table_cells',[]),'\n'.join(c.text for c in table_cells)),
              'native_anchors':sum(b.native is not None for b in doc.blocks),
              'native_page_locations':len(locations), 'page_count':doc.page_count}
    if 'page_text' in oracle:
        result['page_anchors'] = {
            page:coverage(values,'\n'.join(b.text for b in doc.blocks
                                           if any(p.page == int(page) for p in b.native.locations)))
            for page,values in oracle['page_text'].items()}
    if 'merged_cell' in oracle:
        expected=oracle['merged_cell']
        result['merged_cell_correct'] = any(
            c.text==expected['text'] and c.native.row_range==(expected['row_start'],expected['row_end'])
            and c.native.col_range==(expected['col_start'],expected['col_end']) for c in table_cells)
    if doc.extraction_profile==OCR:
        expected=normalize(' '.join(oracle['expected_text']))
        actual=normalize(text)
        result['cer']=distance(expected,actual)/len(expected)
        result['wer']=distance(expected.split(),actual.split())/len(expected.split())
        result['expected_lines']=len(oracle['expected_text'])
        result['recognized_lines']=[b.text for b in doc.blocks]
    return result


def run(tessdata):
    assert {name for _, name in socket.if_nameindex()} <= {'lo'}, 'requires isolated network namespace'
    manifest=json.loads((ROOT/'manifest.json').read_text())
    oracle_path=ROOT/'expected.json'
    assert hashlib.sha256(oracle_path.read_bytes()).hexdigest()==manifest['expectations_sha256']
    oracle=json.loads(oracle_path.read_text())['documents']
    reader=ScopedReader(ROOT/'fixtures')
    output={}
    try:
        for name,profile in [('policy.docx',DOCX),('policy.pdf',PDF),('scan.pdf',PDF),
                             ('scan.pdf',OCR),('malformed.pdf',PDF)]:
            source=reader.read(name,65536)
            assert source.digest==manifest['sources'][name]['sha256']
            start,time_cpu=time.perf_counter(),time.process_time()
            doc=extract(reader,name,profile,tessdata=tessdata)
            elapsed,cpu=time.perf_counter()-start,time.process_time()-time_cpu
            key=name+'::'+profile
            if name in oracle:
                row=evaluate(doc,oracle[name])
                alt_start=time.perf_counter()
                alt=alternatives(name,source.data)
                row['alternative_text']=coverage(oracle[name]['expected_text'],alt)
                row['alternative_seconds']=time.perf_counter()-alt_start
            else:
                row={'status':doc.status,'diagnostics':doc.diagnostics}
            row.update(seconds=elapsed, process_cpu_seconds=cpu, source_digest=doc.digest)
            output[key]=row
        cgroup = next((line.split(':', 2)[2] for line in Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::')), None)
        peak_path = Path('/sys/fs/cgroup') / cgroup.lstrip('/') / 'memory.peak' if cgroup is not None else None
        cgroup_peak = int(peak_path.read_text()) if peak_path is not None and peak_path.is_file() else None
        return {'version':1,'network_interfaces':['lo'],'profiles':output,
                'cgroup_memory_peak_bytes':cgroup_peak,
                'peak_rss_kib':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                'peak_child_rss_kib':resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss}
    finally:
        reader.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--tessdata',type=Path,required=True)
    args=parser.parse_args()
    print(json.dumps(run(args.tessdata),ensure_ascii=False,indent=2,sort_keys=True))
