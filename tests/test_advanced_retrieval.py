"""v4 model-envelope negative tests, no heavy model import or weight download."""
from __future__ import annotations

import copy
import io
import json
import unittest
from unittest.mock import patch

from engine import advanced_protocol as wire
from engine import advanced_retrieval as model_wire


class AdvancedModelWireTest(unittest.TestCase):
    def setUp(self):
        self.sample = {
            'protocolVersion': 4, 'operation': 'embed', 'requestId': 'a' * 48,
            'modelSnapshot': '/offline/snapshot', 'maxTokens': 384,
            'deadlineUnixMs': 1000, 'texts': ['REQ-X-1', 'Договор 🚀'],
        }

    def test_strict_frame_and_roundtrip(self):
        value = model_wire.request(copy.deepcopy(self.sample))
        self.assertEqual(wire.decode(wire.encode(value, limit=model_wire.MAX_REQUEST),
                                     limit=model_wire.MAX_REQUEST), value)
        self.assertEqual(model_wire.response('a' * 48, 'failed', error='MODEL_UNAVAILABLE'), {
            'protocolVersion': 4, 'requestId': 'a' * 48, 'operation': 'embed',
            'status': 'failed', 'error': 'MODEL_UNAVAILABLE', 'identity': None,
            'vectors': [], 'diagnostics': [],
        })

    def test_invalid_framing_and_requests(self):
        variants = [
            {'protocolVersion': 3}, {'operation': 'health'}, {'requestId': 'X' * 48},
            {'maxTokens': 513}, {'maxTokens': 7}, {'texts': []},
            {'texts': ['']}, {'texts': ['x' * 8193]},
            {'texts': ['a'] * 65}, {'texts': [17]}, {'texts': ['unpaired\ud800']},
            {'modelSnapshot': '/../escape'}, {'modelSnapshot': '/x/../escape'},
            {'modelSnapshot': 'relative'}, {'deadlineUnixMs': 0},
            {'deadlineUnixMs': 2**53}, {'extra': 'forbidden'},
        ]
        for changed in variants:
            with self.subTest(changed=str(changed)[:70]), self.assertRaises((ValueError, UnicodeError)):
                model_wire.request({**self.sample, **changed})
        for body in [b'{}\n\n',b'\xef\xbb\xbf{}\n',b'{"a":1,"a":2}\n',b'{ "a":1}\n',b'\xff\n']:
            with self.assertRaises(ValueError):
                wire.decode(body, limit=model_wire.MAX_REQUEST)

    def test_missing_model_fails_closed_before_any_inference(self):
        with patch.object(model_wire, 'request', wraps=model_wire.request), \
             patch('engine.advanced_ingest.resource_preflight', side_effect=RuntimeError('guard refused')):
            v=model_wire.embed({**self.sample, 'deadlineUnixMs': 1000})
            self.assertEqual(v['status'], 'failed')
            self.assertEqual(v['error'], 'MODEL_RESOURCE_REFUSED')
            self.assertEqual(v['vectors'], [])
            self.assertIsNone(v['identity'])

    def test_decoder_cross_language_binary64(self):
        sample={'protocolVersion': 4, 'requestId': 'b'*48,
                'exponents':[1e-7,1e-6,1e20,1e21], 'text':'Русский 🚀'}
        canonical=wire.encode(sample)
        self.assertEqual(wire.decode(canonical), sample)
        with self.assertRaises(ValueError):
            wire.decode(canonical.replace(b'1e-7', b'1e-07'))


if __name__ == '__main__':
    unittest.main()
