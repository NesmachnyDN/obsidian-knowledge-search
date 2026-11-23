"""OKS-05C production v3 canonical contract + local trust boundary regressions."""
import base64
from dataclasses import replace
from hashlib import sha256
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from engine import advanced_protocol as wire
from engine.advanced_ingest import ingest, resource_preflight
from engine.markdown import parse_markdown
from engine.scope import ScopedReader

FIXTURES=json.loads((ROOT/'contracts/fixtures/advanced-ingestion-v1.json').read_text())['cases']


class CanonicalWireTests(unittest.TestCase):
    def test_cross_language_pinned_request_and_reply(self):
        self.assertEqual(len(FIXTURES),3)
        for case in FIXTURES:
            with self.subTest(case['name']):
                req,reply=case['request'],case['response']
                raw=base64.b64decode(case['rawBase64'],validate=True)
                self.assertEqual(sha256(raw).hexdigest(),req['expectedSha256'])
                self.assertEqual(wire.request(wire.decode(wire.encode(req,wire.MAX_REQUEST))),req)
                self.assertEqual(wire.decode(wire.encode(reply),wire.MAX_RESPONSE),reply)
                self.assertEqual(reply['protocolVersion'],3)
                self.assertEqual(reply['requestId'],req['requestId'])
                self.assertEqual(reply['source']['sha256'],req['expectedSha256'])
                self.assertEqual(wire.generation_id(reply['source'],reply['chunks']),
                                 reply['generationId'])

    def test_frozen_markdown_unicode_crlf_bytes_properties_and_wikilinks(self):
        case=FIXTURES[0]
        raw=base64.b64decode(case['rawBase64'])
        doc=parse_markdown('unicode-crlf.md',raw)
        self.assertEqual(doc.status,'ok')
        source=wire.project_document(doc,raw,case['request']['scopeId'],case['request']['profileId'])
        self.assertEqual(source,case['response']['source'])
        typed={p['key']:(p['valueType'],p['value']) for p in source['properties']}
        self.assertEqual(typed['version'],('number',1))
        self.assertEqual(typed['active'],('boolean',True))
        self.assertEqual(typed['tags'],('list',['1',1,True,None]))
        self.assertEqual(typed['created'],('date','2026-11-23'))
        self.assertIn('linked|Alias',source['wikiLinks'])
        for block in source['blocks']:
            loc=block['locator']
            self.assertEqual(loc['locatorKind'],'markdown')
            self.assertEqual(raw[loc['byteStart']:loc['byteEnd']].decode(),block['originalText'])
            self.assertEqual(len(raw[:loc['byteStart']].decode()),loc['charStart'])
            self.assertEqual(len(raw[:loc['byteEnd']].decode()),loc['charEnd'])
        for chunk in case['response']['chunks']:
            self.assertNotEqual(chunk['contextualText'],'')
            self.assertEqual(chunk['sourceSha256'],sha256(raw).hexdigest())

    def test_native_no_fabricated_binary_byte_offsets_and_cell_structure(self):
        for case in FIXTURES[1:]:
            blocks=case['response']['source']['blocks']
            for block in blocks:
                self.assertIsNone(block['locator']['byteStart'])
                self.assertIsNone(block['locator']['byteEnd'])
                self.assertEqual(block['locator']['locatorKind'],'native')
                for cell in block['cells']:
                    self.assertEqual(cell['locator']['nativeItemRef'],block['locator']['nativeItemRef'])
            if case['name']=='table.docx':
                self.assertEqual(blocks[0]['textNature'],'table-cell-serialization')
                self.assertEqual([c['originalText'] for c in blocks[0]['cells']],['A','Б'])

    def test_duplicate_unknown_bad_utf8_bom_oversize_and_wrong_version(self):
        valid=FIXTURES[0]['request']
        req=wire.encode(valid,wire.MAX_REQUEST)
        samples=[
            req.replace(b'"protocolVersion":3',b'"protocolVersion":3,"protocolVersion":3'),
            b'\xef\xbb\xbf'+req, b'\xff\n',req+b'\n',
            b'{"protocolVersion":3',b'{ "a": 1}\n', b'x'*(wire.MAX_REQUEST+1)+b'\n',
        ]
        for sample in samples:
            with self.subTest(sample=sample[:60]),self.assertRaises(ValueError):
                wire.decode(sample)
        for change in (
            {'protocolVersion':2}, {'requestId':'client-forged'},
            {'sourcePath':'../secret.docx'}, {'sourcePath':'a/../../b.pdf'},
            {'profileId':'unknown'}, {'tokenizerSnapshot':'../../tmp'},
        ):
            with self.subTest(change=change),self.assertRaises(ValueError):
                wire.request({**valid,**change})
        with self.assertRaises(ValueError):
            wire.decode(b'{"a":1,"a":2}\n')
        with self.assertRaises(ValueError):
            wire.encode({'nan':float('nan')})

    def test_yaml_frontmatter_typed_not_silently_stringified(self):
        cases=[
            (b'---\nx: true\ny: 2\nz: ["a",2]\n---\n# hi', ['boolean','number','list'],[]),
            (b'---\nx: 1\nx: 2\n---\n',[],['invalid-front-matter']),
            (b'---\nx: {nested: bad}\n---\n',[],['invalid-front-matter']),
            (b'---\nx: 0\nnever-closed',[],['unterminated-front-matter']),
        ]
        for raw,kinds,errors in cases:
            with self.subTest(raw=raw):
                props,issues=wire.markdown_properties(raw)
                self.assertEqual([p['valueType'] for p in props],kinds)
                self.assertEqual(issues,errors)

    def test_root_identity_compatibility_from_canonical_device_inode(self):
        with tempfile.TemporaryDirectory(prefix='oks05c-root-') as folder:
            root=Path(folder).resolve()
            info=root.stat()
            from engine.advanced_protocol import source_root_id
            self.assertEqual(source_root_id(str(root),info.st_dev,info.st_ino),
                sha256(json.dumps([str(root),info.st_dev,info.st_ino],
                    separators=(',',':'),ensure_ascii=False).encode()).hexdigest())


class FailClosedWorkerTests(unittest.TestCase):
    def test_unadmitted_worker_rejects_before_parser_or_source_read(self):
        with self.assertRaises(RuntimeError):
            resource_preflight()
        req=dict(FIXTURES[0]['request'])
        # This source and tokenizer intentionally do not exist. Cgroup denial must
        # precede them and cannot trigger any parser/model download.
        req['rootPath']='/does-not-exist'
        req['tokenizerSnapshot']='/does-not-exist'
        req['deadlineUnixMs']=123456789
        response=ingest(req)
        self.assertEqual(response['status'],'failed')
        self.assertEqual(response['error'],'ADVANCED_RESOURCE_REFUSED')
        self.assertEqual(response['source'],None)
        self.assertEqual(response['chunks'],[])

    def test_malformed_stdio_frame_terminates_without_resynchronization(self):
        worker=ROOT/'engine/advanced_ingest.py'
        with subprocess.Popen([sys.executable,'-I','-B',str(worker)],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE) as proc:
            out,err=proc.communicate(b'{"protocolVersion":3,"protocolVersion":3}\n',timeout=5)
        self.assertEqual(proc.returncode,2)
        self.assertEqual(out,b'')

    def test_scoped_reader_rejects_symlink_and_external_content(self):
        with tempfile.TemporaryDirectory(prefix='oks05c-adversarial-') as folder:
            root=Path(folder)/'root';root.mkdir()
            outside=Path(folder)/'outside.md';outside.write_text('private content')
            (root/'escape.md').symlink_to(outside)
            (root/'valid.md').write_text('safe')
            reader=ScopedReader(root)
            try:
                with self.assertRaises((ValueError,OSError)):
                    reader.read('escape.md',65536)
                with self.assertRaises((ValueError,OSError)):
                    reader.read('../outside.md',65536)
                self.assertEqual(reader.read('valid.md',65536).data,b'safe')
            finally:
                reader.close()

if __name__=='__main__':
    unittest.main()
