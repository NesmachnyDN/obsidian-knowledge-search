#!/usr/bin/env python3
"""Test-only Linux x86_64 inherited direct-network denial, preserving real host UIDs.

This is not a network namespace or a sandbox for hostile programs. Only the
synthetic Obsidian lifecycle fixture is admitted. No Internet socket family
can be created; pathname Unix IPC remains available for X11 and Obsidian CLI.
"""
import ctypes as C
import errno
import os
import platform
import socket
import stat
import sys


class ArgCmp(C.Structure):
    _fields_ = [('arg', C.c_uint), ('op', C.c_int),
                ('datum_a', C.c_uint64), ('datum_b', C.c_uint64)]


def deny_ip():
    if platform.system() != 'Linux' or platform.machine() != 'x86_64' or os.getuid() == 0:
        raise RuntimeError('unsupported host')
    if any(stat.S_ISSOCK(os.fstat(fd).st_mode) for fd in (0, 1, 2)):
        raise RuntimeError('socket stdio')
    lib = C.CDLL('libseccomp.so.2')
    lib.seccomp_init.argtypes = [C.c_uint32]
    lib.seccomp_init.restype = C.c_void_p
    lib.seccomp_release.argtypes = [C.c_void_p]
    lib.seccomp_syscall_resolve_name.argtypes = [C.c_char_p]
    lib.seccomp_syscall_resolve_name.restype = C.c_int
    lib.seccomp_rule_add_array.argtypes = [C.c_void_p, C.c_uint32, C.c_int,
                                          C.c_uint, C.POINTER(ArgCmp)]
    lib.seccomp_rule_add_array.restype = C.c_int
    lib.seccomp_load.argtypes = [C.c_void_p]
    lib.seccomp_load.restype = C.c_int
    ctx = lib.seccomp_init(0x7fff0000)  # SCMP_ACT_ALLOW
    if not ctx:
        raise RuntimeError('seccomp init failed')
    action = 0x00050000 | errno.EPERM  # SCMP_ACT_ERRNO
    try:
        # Restrict all socket families except AF_UNIX, not just IPv4/IPv6.
        # The default native-architecture filter kills incompatible ABIs.
        cmp = ArgCmp(0, 1, socket.AF_UNIX, 0)  # SCMP_CMP_NE
        for name in ('socket', 'socketpair', 'io_uring_setup', 'io_uring_enter',
                     'io_uring_register', 'pidfd_getfd'):
            nr = lib.seccomp_syscall_resolve_name(name.encode('ascii'))
            if nr < 0:
                raise RuntimeError('unresolved syscall')
            arg = name in ('socket', 'socketpair')
            if lib.seccomp_rule_add_array(ctx, action, nr, int(arg),
                                           C.byref(cmp) if arg else None) != 0:
                raise RuntimeError('seccomp rule failed')
        if lib.seccomp_load(ctx) != 0:
            raise RuntimeError('seccomp load failed')
    finally:
        lib.seccomp_release(ctx)
    verify_denial()


def verify_denial():
    with open('/proc/self/status', encoding='ascii') as stream:
        status = dict(line.split(':', 1) for line in stream if ':' in line)
    if status.get('NoNewPrivs', '').strip() != '1' or status.get('Seccomp', '').strip() != '2':
        raise RuntimeError('inherited filter not proved')
    cases = [(family, kind) for family in (socket.AF_INET, socket.AF_INET6)
             for kind in (socket.SOCK_STREAM, socket.SOCK_DGRAM)]
    cases += [(socket.AF_NETLINK, socket.SOCK_DGRAM), (socket.AF_PACKET, socket.SOCK_DGRAM)]
    for family, kind in cases:
        try:
            with socket.socket(family, kind):
                raise RuntimeError('network socket unexpectedly available')
        except OSError as exc:
            if exc.errno != errno.EPERM:
                raise
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM):
        pass


def main():
    if sys.argv[1:] == ['--verify-inherited']:
        verify_denial()
        print('DIRECT_NETWORK_DENIED')
    elif len(sys.argv) > 2 and sys.argv[1] == '--':
        if os.environ.get('OKS_POLICY_2E3A_NO_IP') != '1':
            raise SystemExit('NO_IP_TEST_MODE_REQUIRED')
        deny_ip()
        # Do not inherit any already-open network socket from the caller.
        for entry in os.listdir('/proc/self/fd'):
            fd = int(entry)
            if fd > 2:
                try:
                    os.close(fd)
                except OSError as exc:
                    if exc.errno != errno.EBADF:
                        raise
        # The disposable child gets only fixture configuration, never the
        # caller's credential/proxy environment or desktop session.
        names = ('HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
                 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'ELECTRON_OZONE_PLATFORM_HINT',
                 'tmp', 'app', 'cli', 'repo', 'package_dir', 'previous_package_dir',
                 'first_sha', 'fixture_sha', 'OKS_POLICY_2E3A_TEST',
                 'OKS_POLICY_2E3A_NO_IP', 'OKS_POLICY_2E3C_TEST', 'OKS_HOST_NO_ROUTE')
        child_env = {name: os.environ[name] for name in names if name in os.environ}
        child_env.update(PATH='/usr/bin:/bin', LANG='C.UTF-8')
        print('DIRECT_NETWORK_DENIED', flush=True)
        os.execvpe(sys.argv[2], sys.argv[2:], child_env)
    else:
        raise SystemExit('NO_IP_TEST_ARGUMENTS')

if __name__ == '__main__':
    try:
        main()
    except Exception:
        # A guard denial is expected in negative tests. Never expose the local
        # executable, fixture paths, argv, environment or raw exception trace.
        print('DIRECT_NETWORK_DENIAL_UNAVAILABLE', file=sys.stderr)
        raise SystemExit(2) from None
