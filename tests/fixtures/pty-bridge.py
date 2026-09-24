#!/usr/bin/env python3
"""Development-only PTY bridge for CLI integration tests."""

import errno
import os
import pty
import select
import signal
import sys

pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])


def terminate(_signum, _frame):
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass


signal.signal(signal.SIGTERM, terminate)
sources = [fd, sys.stdin.fileno()]
child_status = None
while True:
    ready, _, _ = select.select(sources, [], [], 0.1)
    if sys.stdin.fileno() in ready:
        data = os.read(sys.stdin.fileno(), 65536)
        if data:
            os.write(fd, data)
        else:
            sources.remove(sys.stdin.fileno())
            os.write(fd, b"\x04")
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            data = b""
        if not data:
            break
        os.write(sys.stdout.fileno(), data)
    if child_status is None:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            child_status = status

if child_status is None:
    _, child_status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(child_status))
