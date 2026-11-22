"""Linux descriptor-relative bounded read under a caller-trusted root."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import stat
import sys
from dataclasses import dataclass


def open_directory(root: Path) -> int:
    """Anchor every ancestor without following symlinks."""
    if not root.is_absolute() or '..' in root.parts:
        raise ValueError('noncanonical root')
    current = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in root.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=current)
            old, current = current, child
            os.close(old)
        result, current = current, None
        return result
    finally:
        if current is not None:
            os.close(current)


def root_identity(root: Path) -> tuple[int, int]:
    fd = open_directory(root)
    try:
        info = os.fstat(fd)
        return info.st_dev, info.st_ino
    finally:
        os.close(fd)


@dataclass(frozen=True)
class Source:
    data: bytes
    digest: str


class ScopedReader:
    def __init__(self, root: Path, ignored: frozenset[str] = frozenset({'.git', '.obsidian'})):
        if (sys.platform != 'linux' or os.open not in os.supports_dir_fd
                or not hasattr(os, 'O_NOFOLLOW')):
            raise OSError('unsupported descriptor filesystem interface')
        # Root is explicitly trusted, but its spelling and all ancestors must be canonical.
        if not root.is_absolute() or str(root.resolve(strict=True)) != str(root):
            raise ValueError('noncanonical root')
        self.root = root
        self.fd = open_directory(root)
        info = os.fstat(self.fd)
        self.identity = (info.st_dev, info.st_ino)
        self.device = os.fstat(self.fd).st_dev
        self.ignored = ignored

    def read(self, relative: str, maximum: int = 8192) -> Source:
        if self.fd is None:
            raise ValueError('reader closed')
        if root_identity(self.root) != self.identity:
            raise ValueError('stale root')
        if (type(relative) is not str or len(relative.encode('utf-8')) > 1024
                or '\\' in relative or '\x00' in relative
                or any(p in ('', '.', '..') or p in self.ignored for p in relative.split('/'))):
            raise ValueError('scope path')
        if type(maximum) is not int or not 1 <= maximum <= 65536:
            raise ValueError('read bound')
        current = os.dup(self.fd)
        try:
            parts = relative.split('/')
            for index, part in enumerate(parts):
                flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                if index < len(parts) - 1:
                    flags |= os.O_DIRECTORY
                child = os.open(part, flags, dir_fd=current)
                os.close(current)
                current = child
                if os.fstat(current).st_dev != self.device:
                    raise ValueError('cross-device source unsupported')
            before = os.fstat(current)
            if not stat.S_ISREG(before.st_mode) or before.st_size > maximum:
                raise ValueError('nonregular or oversize source')
            data = bytearray()
            while len(data) <= maximum:
                block = os.read(current, maximum + 1 - len(data))
                if not block:
                    break
                data.extend(block)
            after = os.fstat(current)
            stamp = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
            if len(data) > maximum or stamp(before) != stamp(after):
                raise ValueError('source changed or oversize')
            # Re-walk from the anchored root: renamed/replaced path components
            # must not make detached bytes appear current.
            check = os.dup(self.fd)
            try:
                for index, part in enumerate(parts):
                    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                    if index < len(parts) - 1:
                        flags |= os.O_DIRECTORY
                    child = os.open(part, flags, dir_fd=check)
                    old, check = check, child
                    os.close(old)
                if (stamp(os.fstat(check)) != stamp(after)
                        or root_identity(self.root) != self.identity):
                    raise ValueError('stale source path')
            finally:
                os.close(check)
            return Source(bytes(data), hashlib.sha256(data).hexdigest())
        finally:
            os.close(current)

    def fresh(self, relative: str, expected: str) -> bool:
        try:
            return self.read(relative).digest == expected
        except (OSError, ValueError):
            return False

    def close(self) -> None:
        fd, self.fd = self.fd, None
        if fd is not None:
            os.close(fd)
