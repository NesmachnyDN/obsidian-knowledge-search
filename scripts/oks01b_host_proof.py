#!/usr/bin/env python3
"""Explicit host-only transient cgroup proof. Never run by CI/discovery."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import signal
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine.resources import Job


def wait_for(predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise RuntimeError('bounded proof deadline')


def child(gate: Path):
    wait_for(gate.exists, 10)  # Service stays tiny until kernel controls are verified.
    pid = os.fork()
    if pid == 0:
        time.sleep(10)
        os._exit(0)
    def terminate(_signum, _frame):
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, terminate)
    gate.with_suffix('.pids').write_text(f'{os.getpid()} {pid}')
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass


def identity(pid: int):
    try:
        # Process start tick prevents false conclusions after PID reuse.
        return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
    except FileNotFoundError:
        return None


def proof():
    with tempfile.TemporaryDirectory(prefix='oks-proof-') as temp:
        root = Path(temp)
        job = Job()
        try:
            for cycle in range(2):
                gate = root / f'gate-{cycle}'
                group = job.start(root, Path(__file__).resolve(), gate)
                gate.touch()
                pid_file = gate.with_suffix('.pids')
                wait_for(lambda: pid_file.exists() and len(pid_file.read_text().split()) == 2)
                pids = [int(p) for p in pid_file.read_text().split()]
                members = {int(p) for p in (group / 'cgroup.procs').read_text().split()}
                if len(set(pids)) != 2 or not set(pids) <= members:
                    raise RuntimeError('process tree not contained')
                identities = {pid: identity(pid) for pid in pids}
                if None in identities.values():
                    raise RuntimeError('process exited before cancellation proof')
                job.stop()
                wait_for(lambda: all(identity(pid) != start for pid, start in identities.items()))
                if group.exists() and (group / 'cgroup.procs').read_text().strip():
                    raise RuntimeError('remaining cgroup members')
            print('PASS: verified kernel limits, two-member cancellation and explicit restart (2 cycles)')
        finally:
            job.stop()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-host-proof', action='store_true')
    parser.add_argument('--child', type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.child:
        child(args.child)
    elif args.run_host_proof:
        try:
            proof()
        except Exception as error:
            # No private paths, cgroup names or raw systemd diagnostics in public output.
            print(f'BLOCKED: host proof failed closed ({type(error).__name__}); inspect locally', file=sys.stderr)
            sys.exit(1)
    else:
        parser.error('explicit --run-host-proof required')
