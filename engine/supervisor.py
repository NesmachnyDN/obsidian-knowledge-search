"""One in-flight health request, bounded I/O and explicit process restart."""
from __future__ import annotations

import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import threading
import time
import secrets

from engine.persistent import LIMIT, decode, encode, handle
from engine.probe import exact

WORKER = Path(__file__).with_name('persistent.py')


class Supervisor:
    def __init__(self):
        self.process: subprocess.Popen | None = None
        self._request = threading.Lock()
        self._lifecycle = threading.Lock()

    def start(self) -> None:
        if not self._request.acquire(blocking=False):
            raise RuntimeError('request still draining')
        try:
            with self._lifecycle:
                if self.process is not None:
                    raise RuntimeError('already started; cancel before restart')
                self.process = subprocess.Popen(
                    [sys.executable, '-I', '-B', str(WORKER)], stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True,
                    bufsize=0)
                os.set_blocking(self.process.stdout.fileno(), False)
                os.set_blocking(self.process.stdin.fileno(), False)
        finally:
            self._request.release()

    def cancel(self) -> None:
        with self._lifecycle:
            process = self.process
            if process is None:
                return
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=0.2)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=1)
            process.stdin.close()
            process.stdout.close()
            self.process = None

    def health(self, identity: str, timeout: float = 1.0) -> dict:
        if not 0 < timeout <= 5:
            raise ValueError('deadline')
        request = {'version': 2, 'id': identity, 'method': 'health'}
        handle(request)
        if not self._request.acquire(blocking=False):
            raise RuntimeError('busy')
        try:
            process = self.process
            if process is None or process.poll() is not None:
                raise RuntimeError('not running')
            correlation = secrets.token_hex(24)
            request['id'] = correlation
            deadline = time.monotonic() + timeout
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdin, selectors.EVENT_WRITE)
                data = encode(request)
                while data:
                    if not selector.select(max(0, deadline - time.monotonic())):
                        raise TimeoutError('request deadline')
                    count = os.write(process.stdin.fileno(), data)
                    data = data[count:]
                selector.unregister(process.stdin)
                selector.register(process.stdout, selectors.EVENT_READ)
                result = bytearray()
                while b'\n' not in result:
                    if not selector.select(max(0, deadline - time.monotonic())):
                        raise TimeoutError('response deadline')
                    block = os.read(process.stdout.fileno(), LIMIT + 1 - len(result))
                    if not block:
                        raise ValueError('worker EOF')
                    result.extend(block)
                    if len(result) > LIMIT:
                        raise ValueError('response bound')
            response = decode(bytes(result))
            if (not exact(response, ('version', 'id', 'ok'))
                    or type(response['version']) is not int or response['version'] != 2
                    or response['id'] != correlation or response['ok'] is not True):
                raise ValueError('response correlation/schema')
            return dict(response, id=identity)
        except BaseException:
            self.cancel()
            raise
        finally:
            self._request.release()
