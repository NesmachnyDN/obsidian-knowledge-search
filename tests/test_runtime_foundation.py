import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine.persistent import LIMIT, decode, encode, handle
from engine.supervisor import Supervisor, WORKER
from engine.resources import Budget, Job, MIB, PROPERTIES, admit, command, verify_limits


class RuntimeTests(unittest.TestCase):
    def test_sequential_cancel_restart(self):
        worker = Supervisor()
        self.addCleanup(worker.cancel)
        worker.start()
        process = worker.process
        for i in range(20):
            self.assertEqual(worker.health(str(i)), dict(version=2, id=str(i), ok=True))
        worker.cancel()
        self.assertIsNotNone(process.poll())
        worker.start()
        self.assertNotEqual(worker.process.pid, process.pid)
        self.assertTrue(worker.health('restart')['ok'])

    def test_worker_rejects_bad_frames(self):
        for data in (b'{}\n', b'{}', b'\xff\n', b'x' * (LIMIT + 1) + b'\n',
                     b'{"version":2,"version":2,"id":"a","method":"health"}\n',
                     b'{"version":1,"id":"a","method":"health"}\n',
                     b'{"version":2,"id":"a","method":"exec"}\n'):
            result = subprocess.run([sys.executable, '-I', '-B', str(WORKER)], input=data,
                                    capture_output=True, timeout=2)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, b'')
        with self.assertRaises(ValueError):
            decode(b'{}\n{}\n')

    def faulty(self, body):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        path = Path(temp.name) / 'worker.py'
        path.write_text(body)
        worker = Supervisor()
        self.addCleanup(worker.cancel)
        with patch('engine.supervisor.WORKER', path):
            worker.start()
        return worker

    def test_response_correlation_bounds_timeout_and_restart(self):
        for body, error in (
            ('print(\'{"version":2,"id":"wrong","ok":true}\',flush=True)', ValueError),
            ('print("x"*1025,flush=True)', ValueError),
            ('print("{}",flush=True)', ValueError),
            ('import time; time.sleep(10)', TimeoutError),
            ('pass', ValueError)):
            worker = self.faulty(body)
            process = worker.process
            with self.assertRaises(error):
                worker.health('test', timeout=0.15)
            self.assertIsNotNone(process.poll())
            self.assertIsNone(worker.process)
            worker.start()
            self.assertTrue(worker.health('recovered')['ok'])
            worker.cancel()

    def test_duplicate_and_unsolicited_responses(self):
        worker = self.faulty("import sys,json; r=json.loads(sys.stdin.readline()); "
                             "r.pop('method'); r['ok']=True; "
                             "print(json.dumps(r),flush=True); "
                             "sys.stdin.readline(); print(json.dumps(r),flush=True)")
        self.assertTrue(worker.health('same')['ok'])
        with self.assertRaisesRegex(ValueError, 'correlation'):
            worker.health('same')
        worker = self.faulty('print(\'{"version":2,"id":"same","ok":true}\',flush=True)')
        with self.assertRaises(ValueError):
            worker.health('same')

    def test_busy_and_inflight_cancel(self):
        worker = self.faulty('import time; time.sleep(10)')
        process = worker.process
        errors = []
        def request():
            try:
                worker.health('waiting', 1)
            except Exception as error:
                errors.append(error)
        thread = threading.Thread(target=request)
        thread.start()
        deadline = time.monotonic() + 1
        while not worker._request.locked() and time.monotonic() < deadline:
            time.sleep(0.001)
        with self.assertRaisesRegex(RuntimeError, 'busy'):
            worker.health('second')
        worker.cancel()
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertTrue(errors)
        self.assertIsNotNone(process.poll())


class ResourceTests(unittest.TestCase):
    def test_admission_denials_and_recovery(self):
        admit(192 * MIB, 17 * MIB, {'memory', 'cpu', 'pids'}, Budget())
        for memory, disk, controls in ((191 * MIB, 17 * MIB, {'memory', 'cpu', 'pids'}),
                                      (192 * MIB, 16 * MIB, {'memory', 'cpu', 'pids'}),
                                      (192 * MIB, 17 * MIB, {'cpu'})):
            with self.assertRaises(RuntimeError):
                admit(memory, disk, controls, Budget())
        with self.assertRaises(ValueError):
            admit(1000, 1000, set(), Budget(memory=-1))

    def test_unavailable_manager_releases_admission(self):
        with patch('engine.resources.available', return_value=(300*MIB, 100*MIB, {'memory', 'cpu', 'pids'})), \
                patch('engine.resources.run', side_effect=FileNotFoundError):
            job = Job()
            with self.assertRaises(FileNotFoundError):
                job.start(Path('.'), Path('helper'), Path('gate'))
            self.assertIsNone(job.unit)
            self.assertFalse(Job._slot.locked())

    def test_collected_unit_and_failed_launch(self):
        job = Job()
        with patch('engine.resources.available', return_value=(300*MIB, 100*MIB, {'memory', 'cpu', 'pids'})), \
                patch('engine.resources.run', side_effect=['', RuntimeError('launch'),
                                                          RuntimeError('stop'), 'not-found']):
            with self.assertRaisesRegex(RuntimeError, 'launch'):
                job.start(Path('.'), Path('helper'), Path('gate'))
        self.assertIsNone(job.unit)
        self.assertFalse(Job._slot.locked())

    def test_command_no_shell_and_all_limits(self):
        args = command('oks-proof-test.service', Path('/synthetic/helper.py'), Path('/synthetic/gate'))
        self.assertEqual(args[0], 'systemd-run')
        self.assertIn('--user', args)
        for value in PROPERTIES:
            self.assertIn('--property=' + value, args)
        with self.assertRaises(ValueError):
            command('bad;unit', Path('x'), Path('x'))

    def test_kernel_limits(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            valid = {'memory.max': str(64 * MIB), 'memory.swap.max': '0',
                     'pids.max': '8', 'cpu.max': '25000 100000'}
            for name, value in valid.items():
                (root / name).write_text(value)
            verify_limits(root)
            for name, value in valid.items():
                (root / name).write_text('max' if name != 'cpu.max' else 'max 100000')
                with self.assertRaises((ValueError, RuntimeError)):
                    verify_limits(root)
                (root / name).write_text(value)

    def test_lifecycle_pressure_and_single_owner(self):
        calls = []
        def fake_run(args):
            calls.append(args)
            if '--property=ControlGroup' in args:
                return '/synthetic'
            for key, value in (('KillMode', 'control-group'), ('RuntimeMaxUSec', '15s'),
                               ('TimeoutStopUSec', '1s')):
                if '--property=' + key in args:
                    return value
            return ''
        with patch('engine.resources.run', side_effect=fake_run), \
                patch('engine.resources.verify_limits'), \
                patch('engine.resources.available', return_value=(300 * MIB, 100 * MIB, {'memory', 'cpu', 'pids'})):
            job = Job()
            try:
                job.start(Path('.'), Path('helper'), Path('gate'))
                with self.assertRaisesRegex(RuntimeError, 'busy'):
                    Job().start(Path('.'), Path('helper'), Path('gate'))
                with patch('engine.resources.available', return_value=(0, 0, set())):
                    with self.assertRaises(RuntimeError):
                        job.check_pressure(Path('.'))
                self.assertIsNone(job.unit)
                job.start(Path('.'), Path('helper'), Path('gate'))
            finally:
                job.stop()
            self.assertEqual(sum(args[0] == 'systemd-run' for args in calls), 2)
            self.assertEqual(sum('stop' in args for args in calls), 2)

    def test_denied_before_start_and_retry(self):
        for resources in ((0, 0, set()), (300 * MIB, 100 * MIB, {'memory'})):
            job = Job()
            with patch('engine.resources.available', return_value=resources), \
                    patch('engine.resources.run') as run:
                with self.assertRaises(RuntimeError):
                    job.start(Path('.'), Path('helper'), Path('gate'))
                run.assert_not_called()
                self.assertIsNone(job.unit)
        # Both denied jobs released ownership: a fresh denied admission is not BUSY.
        self.assertFalse(Job._slot.locked())

    def test_ineffective_controls_stop_and_stop_failure_holds_slot(self):
        with patch('engine.resources.available', return_value=(300 * MIB, 100 * MIB, {'memory', 'cpu', 'pids'})), \
                patch('engine.resources.run', return_value='/synthetic') as run, \
                patch('engine.resources.verify_limits', side_effect=RuntimeError('limits')):
            job = Job()
            with self.assertRaisesRegex(RuntimeError, 'limits'):
                job.start(Path('.'), Path('helper'), Path('gate'))
            self.assertIsNone(job.unit)
            self.assertEqual(run.call_args.args[0][:3], ['systemctl', '--user', 'stop'])
            job.unit = 'oks-proof-test.service'
            self.assertTrue(Job._slot.acquire(blocking=False))
            run.side_effect = RuntimeError('stop failed')
            try:
                with self.assertRaisesRegex(RuntimeError, 'stop failed'):
                    job.stop()
                self.assertTrue(Job._slot.locked())
                self.assertIsNotNone(job.unit)
            finally:
                run.side_effect = None
                job.stop()
