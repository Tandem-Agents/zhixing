"""Owned PTY fixture for the fixed original R; never reads a user's terminal."""
import errno
import fcntl
import json
import os
import select
import signal
import socket
import subprocess
import sys
import termios
import time
import uuid


def run(executable, scenario):
    def expired(_signal, _frame):
        raise TimeoutError('owned recovery fixture exceeded 20 seconds')

    signal.signal(signal.SIGALRM, expired)
    signal.alarm(20)
    instance = str(uuid.uuid4())
    channel, inherited = socket.socketpair()
    master, slave = os.openpty()
    baseline = termios.tcgetattr(slave)
    original_flags = fcntl.fcntl(slave, fcntl.F_GETFL)
    child = None
    output = bytearray()
    pending = bytearray()

    def read_output():
        while select.select([master], [], [], 0)[0]:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            output.extend(data)
            assert len(output) <= 65536, 'unbounded recovery output'

    def receive(name):
        end = time.monotonic() + 5
        while time.monotonic() < end:
            while b'\n' in pending:
                line, _, rest = pending.partition(b'\n')
                pending[:] = rest
                message = json.loads(line)
                assert message['instance'] == instance and message['pid'] == child.pid
                if message['event'] == name:
                    return message
                assert message['event'] == 'control', message
            channel.settimeout(max(0.001, end - time.monotonic()))
            data = channel.recv(4096)
            assert data, 'R exited before expected receipt'
            pending.extend(data)
            assert len(pending) <= 8192
        raise AssertionError('R receipt timeout: ' + name)

    def send(command):
        channel.sendall(('1 ' + instance + ' ' + command + '\n').encode())

    def own_terminal():
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        os.dup2(inherited.fileno(), 3)

    try:
        child = subprocess.Popen([executable, 'resident', instance], stdin=slave, stdout=slave, stderr=slave,
                                 env={**os.environ, 'ZHIXING_TERMINAL_FD': '3'},
                                 preexec_fn=own_terminal, close_fds=True,
                                 pass_fds=(3, inherited.fileno()))
        inherited.close()
        assert receive('ready')['baseline']['foreground'] is True
        # Ordinary controls must be observed, never trigger competing restore.
        for control in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT):
            child.send_signal(control)
            receive('control')
        read_output()
        assert not output, 'R wrote before admission'
        send('admit')
        receive('admitted')
        send('modes-128')
        receive('modes-admitted')
        send('activate')
        receive('entered')
        read_output()
        assert bytes(output) == b'\x1b[?1049h'
        if scenario == 'eof':
            channel.close()
            channel = None
            assert child.wait(timeout=5) == 74
            read_output()
            assert bytes(output) == b'\x1b[?1049h', 'EOF must not authorize final TTY writes'
        else:
            send('permit-modes')
            receive('modes-permitted')
            changed = termios.tcgetattr(slave)
            changed[0] = 0
            changed[1] = 0
            changed[3] &= ~(termios.ECHO | termios.ICANON | termios.ISIG)
            termios.tcsetattr(slave, termios.TCSANOW, changed)
            fcntl.fcntl(slave, fcntl.F_SETFL, original_flags | os.O_NONBLOCK)
            send('restore-' + str(int(time.time() * 1000) + 2000))
            receipt = receive('result')
            assert receipt['errors'] == 0 and receipt['controls'] == 4, receipt
            assert child.wait(timeout=5) == 0
            read_output()
            assert output.count(b'\x1b[?1049h') == 1 and output.count(b'\x1b[?1049l') == 1
            assert bytes(output).endswith(b'\r\n') and output.count(b'\r\n') == 1
            assert termios.tcgetattr(slave) == baseline, 'original termios not restored'
            assert fcntl.fcntl(slave, fcntl.F_GETFL) == original_flags, 'shared status flags not restored'
        print(json.dumps({'scenario': scenario, 'pid': child.pid, 'exit': child.returncode, 'bytes': len(output)}))
    finally:
        if channel:
            channel.close()
        if child and child.poll() is None:
            child.kill()
            child.wait(timeout=5)
        inherited.close()
        os.close(master)
        os.close(slave)
        signal.alarm(0)


run(sys.argv[1], sys.argv[2])
