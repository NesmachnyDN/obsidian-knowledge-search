"""Explicit Linux transient-unit proof helper, never invoked on import."""
from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import uuid

MIB = 1024 * 1024
PROPERTIES = ('MemoryMax=64M', 'MemorySwapMax=0', 'CPUQuota=25%', 'TasksMax=8',
              'KillMode=control-group', 'RuntimeMaxSec=15s', 'TimeoutStopSec=1s')


@dataclass(frozen=True)
class Budget:
    memory: int = 64 * MIB
    memory_reserve: int = 128 * MIB
    disk: int = MIB
    disk_reserve: int = 16 * MIB


def admit(memory_free: int, disk_free: int, controllers: set[str], budget: Budget) -> None:
    values = (budget.memory, budget.memory_reserve, budget.disk, budget.disk_reserve)
    if any(type(v) is not int or v <= 0 for v in values):
        raise ValueError('invalid budget')
    if not {'memory', 'cpu', 'pids'} <= controllers:
        raise RuntimeError('required cgroup controllers unavailable')
    if memory_free < budget.memory + budget.memory_reserve or disk_free < budget.disk + budget.disk_reserve:
        raise RuntimeError('resource pressure; explicit retry required')


def available(cache_directory: Path) -> tuple[int, int, set[str]]:
    if sys.platform != 'linux':
        raise RuntimeError('Linux required')
    values = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
    memory = int(values['MemAvailable'].split()[0]) * 1024
    controllers = set(Path('/sys/fs/cgroup/cgroup.controllers').read_text().split())
    return memory, shutil.disk_usage(cache_directory).free, controllers


def command(unit: str, helper: Path, gate: Path) -> list[str]:
    if not unit.startswith('oks-proof-') or not unit.endswith('.service') or any(
            c not in 'abcdefghijklmnopqrstuvwxyz0123456789-.' for c in unit):
        raise ValueError('unit')
    return ['systemd-run', '--user', '--quiet', '--collect', '--service-type=exec',
            '--unit=' + unit, *['--property=' + p for p in PROPERTIES],
            '--', sys.executable, '-I', '-B', str(helper), '--child', str(gate)]


def run(args: list[str]) -> str:
    return subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=3, check=True, text=True).stdout.strip()


def verify_limits(directory: Path) -> None:
    for name, maximum in (('memory.max', 64 * MIB), ('memory.swap.max', 0), ('pids.max', 8)):
        value = int((directory / name).read_text().strip())
        if value < 0 or value > maximum or (name != 'memory.swap.max' and value == 0):
            raise RuntimeError('ineffective ' + name)
    quota, period = (directory / 'cpu.max').read_text().split()
    if int(period) <= 0 or not 0 < int(quota) / int(period) <= 0.25:
        raise RuntimeError('ineffective cpu.max')


class Job:
    """Single process-local owner. Production cross-process arbitration is deferred."""
    _slot = threading.Lock()

    def __init__(self):
        self.unit: str | None = None

    def start(self, cache_directory: Path, helper: Path, gate: Path) -> Path:
        if not self._slot.acquire(blocking=False):
            raise RuntimeError('busy')
        try:
            admit(*available(cache_directory), Budget())
            run(['systemctl', '--user', 'show-environment'])
        except BaseException:
            self._slot.release()
            raise
        self.unit = 'oks-proof-' + uuid.uuid4().hex + '.service'
        try:
            run(command(self.unit, helper, gate))
            group = run(['systemctl', '--user', 'show', self.unit, '--property=ControlGroup', '--value'])
            if not group.startswith('/') or '..' in group.split('/'):
                raise RuntimeError('missing cgroup')
            directory = Path('/sys/fs/cgroup') / group.lstrip('/')
            verify_limits(directory)
            for key, expected in (('KillMode', 'control-group'), ('RuntimeMaxUSec', '15s'),
                                  ('TimeoutStopUSec', '1s')):
                if run(['systemctl', '--user', 'show', self.unit, '--property=' + key, '--value']) != expected:
                    raise RuntimeError('ineffective unit property')
            return directory
        except BaseException:
            self.stop()
            raise

    def stop(self) -> None:
        if self.unit is not None:
            # A failed stop retains ownership; never admit a competing workload.
            try:
                run(['systemctl', '--user', 'stop', self.unit])
            except Exception:
                # Query failure is not evidence of absence. Keep ownership.
                state = run(['systemctl', '--user', 'show', self.unit,
                             '--property=LoadState', '--value'])
                if state != 'not-found':
                    raise
            self.unit = None
            self._slot.release()

    def check_pressure(self, cache_directory: Path) -> None:
        try:
            admit(*available(cache_directory), Budget())
        except BaseException:
            self.stop()
            raise
