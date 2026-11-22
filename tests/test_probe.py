"""Synthetic shared contract and actual single-shot CLI tests; standard library only."""
import copy
import importlib.util
import json
import io
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('probe', ROOT / 'engine/probe.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
CASES = json.loads((ROOT / 'contracts/fixtures/cases.json').read_text())

class ProbeTests(unittest.TestCase):
    def test_shared_contract(self):
        for case in CASES:
            with self.subTest(case=case['name']):
                validator = probe.is_request if case['kind'] == 'request' else probe.is_response
                self.assertEqual(validator(case['value']), case['valid'])

    def cli(self, data):
        result = subprocess.run([sys.executable, '-I', '-B', str(ROOT / 'engine/probe.py')],
                                input=data, capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, b'')
        self.assertLessEqual(len(result.stdout), probe.FRAME_LIMIT)
        value = json.loads(result.stdout)
        self.assertTrue(probe.is_response(value))
        return value

    def test_real_cli(self):
        request = CASES[0]['value']
        self.assertEqual(self.cli((json.dumps(request)+'\n').encode()), CASES[1]['value'])
        for case in CASES:
            if case['kind'] == 'request' and not case['valid']:
                with self.subTest(case=case['name']):
                    self.assertFalse(self.cli((json.dumps(case['value'])+'\n').encode())['ok'])

    def test_malformed_frames(self):
        for data in [b'', b'{}', b'{}\n{}\n', b'\xff\n', b'{\n', b'x'*65537+b'\n', b'NaN\n', b'['*2000+b'\n']:
            self.assertFalse(self.cli(data)['ok'])

    def test_pinned_allowlist(self):
        request = copy.deepcopy(CASES[0]['value'])
        request['source']['text'] = 'arbitrary synthetic text'
        request['source']['digest'] = probe.hashlib.sha256(request['source']['text'].encode()).hexdigest()
        self.assertEqual(probe.handle(request)['error']['code'], 'FIXTURE_REJECTED')
        request['source']['id'] = '../arbitrary'
        self.assertFalse(probe.handle(request)['ok'])

    def test_offline_audit_guard(self):
        code = """
import runpy, sys
def deny(event, args):
    if event.startswith(('socket.', 'subprocess.', 'os.system', 'os.exec', 'os.spawn')):
        raise RuntimeError('forbidden runtime operation')
sys.addaudithook(deny)
runpy.run_path(sys.argv[1], run_name='__main__')
"""
        result = subprocess.run([sys.executable, '-I', '-B', '-c', code, str(ROOT / 'engine/probe.py')],
            input=(json.dumps(CASES[0]['value'])+'\n').encode(), capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), CASES[1]['value'])

    def test_shared_wire(self):
        cases = json.loads((ROOT / 'contracts/fixtures/wire-cases.json').read_text())
        for case in cases:
            with self.subTest(case=case['name'], kind=case['kind']):
                data = case['frame'].encode('utf-8')
                try:
                    value = probe.read_frame(io.BytesIO(data))
                    valid = (probe.is_request if case['kind'] == 'request' else probe.is_response)(value)
                except (ValueError, UnicodeError):
                    valid = False
                self.assertEqual(valid, case['valid'])
                if case['kind'] == 'request':
                    response = self.cli(data)
                    if case['name'] == 'embedded BOM preserved':
                        self.assertEqual(response['error']['code'], 'FIXTURE_REJECTED')
                    else:
                        self.assertEqual(response['ok'], case['valid'])

    def test_exact_shapes(self):
        for case in CASES:
            if not case['valid']:
                continue
            validator = probe.is_request if case['kind'] == 'request' else probe.is_response
            for key in case['value']:
                value = copy.deepcopy(case['value'])
                del value[key]
                self.assertFalse(validator(value))
            self.assertFalse(validator(dict(case['value'], extra=None)))
