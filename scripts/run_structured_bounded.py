"""Run a single synthetic structured-PDF experiment with cgroup admission."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine.resources import Budget, admit, available

GIB = 1024**3
BUDGET = Budget(memory=4*GIB, memory_reserve=3*GIB, disk=GIB, disk_reserve=GIB)
ROOT = Path(__file__).resolve().parents[1]


def scope_active(unit):
    state = subprocess.run(['systemctl', '--user', 'show', unit, '-p', 'ActiveState', '--value'],
                           capture_output=True, text=True, timeout=5)
    value = state.stdout.strip()
    if value not in ('inactive', 'failed', 'active', 'activating', 'deactivating', 'reloading'):
        raise RuntimeError('cannot determine managed scope state')
    return value not in ('inactive', 'failed')


def run(interpreter, fixture, artifacts, tessdata):
    admit(*available(artifacts), BUDGET)
    # One scope across orchestrators. Do not start another if a previous scope
    # still exists. All resource-heavy execution is in the managed scope.
    unit = 'oks-02b-structured.scope'
    if any(scope_active(name) for name in (
            unit, 'oks-02b-full-runtime.scope', 'oks-02b-opencv.scope',
            'oks-02b-model-download.scope')):
        raise RuntimeError('another heavy extraction experiment is active')
    cpus = sorted(os.sched_getaffinity(0))[:2]
    if len(cpus) != 2:
        raise RuntimeError('two logical CPUs required')
    command = [
        'systemd-run', '--user', '--scope', '--unit='+unit,
        '-p', 'MemoryMax=4G', '-p', 'MemorySwapMax=0', '-p', 'CPUQuota=200%',
        '-p', 'TasksMax=128', 'timeout', '-k', '5s', '180s',
        'taskset', '-c', ','.join(map(str, cpus)), 'unshare', '-Urn',
        'env', 'OMP_NUM_THREADS=2', 'OPENBLAS_NUM_THREADS=1',
        'MKL_NUM_THREADS=2', 'OMP_THREAD_LIMIT=2', 'HF_HUB_OFFLINE=1',
        'TRANSFORMERS_OFFLINE=1', 'HF_HUB_DISABLE_TELEMETRY=1',
        'CUDA_VISIBLE_DEVICES=', str(interpreter), '-I', '-B',
        str(ROOT/'benchmarks/extraction/run_structured.py'), fixture,
        '--artifacts', str(artifacts), '--tessdata', str(tessdata),
    ]
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL)
    try:
        while process.poll() is None:
            memory, disk, _ = available(artifacts)
            if memory < BUDGET.memory_reserve or disk < BUDGET.disk_reserve:
                raise RuntimeError('resource pressure; structured experiment cancelled')
            time.sleep(0.5)
        if process.returncode:
            raise subprocess.CalledProcessError(process.returncode, command)
    finally:
        if process.poll() is None or scope_active(unit):
            # Stop only the named experimental scope, including descendants.
            subprocess.run(['systemctl', '--user', 'stop', unit], timeout=15, check=True)
            process.wait(timeout=10)
        if scope_active(unit):
            raise RuntimeError('structured scope still active')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('fixture', choices=['policy.pdf','scan.pdf'])
    parser.add_argument('--python', type=Path, required=True)
    parser.add_argument('--artifacts', type=Path, required=True)
    parser.add_argument('--tessdata', type=Path, required=True)
    args = parser.parse_args()
    run(args.python, args.fixture, args.artifacts, args.tessdata)
