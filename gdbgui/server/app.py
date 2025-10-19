# gdbgui/server/app.py
import binascii
import logging
import os
import socket
import re
from dataclasses import dataclass, field
from threading import Event, Lock
from typing import Any, Dict, List, Optional, TYPE_CHECKING

try:
    import paramiko
except ImportError:  # pragma: no cover - exercised when optional dep missing
    paramiko = None  # type: ignore[assignment]

import traceback
from flask import Flask, abort, request, session
from flask_compress import Compress  # type: ignore
from flask_socketio import SocketIO, emit  # type: ignore

from .constants import DEFAULT_GDB_EXECUTABLE, STATIC_DIR, TEMPLATE_DIR
from .http_routes import blueprint
from .http_util import is_cross_origin
from .sessionmanager import SessionManager, DebugSession

logger = logging.getLogger(__file__)
# Create flask application and add some configuration keys to be used in various callbacks
PARAMIKO_AVAILABLE = paramiko is not None

if not PARAMIKO_AVAILABLE:
    logger.warning(
        "Paramiko is not installed. SSH console functionality will be disabled."
    )

if TYPE_CHECKING:
    from paramiko import SSHClient as ParamikoSSHClient
else:
    ParamikoSSHClient = Any

app = Flask(__name__, template_folder=str(TEMPLATE_DIR), static_folder=str(STATIC_DIR))
Compress(
    app
)  # add gzip compression to Flask. see https://github.com/libwilliam/flask-compress
app.register_blueprint(blueprint)
app.config["initial_binary_and_args"] = []
app.config["gdb_path"] = DEFAULT_GDB_EXECUTABLE
app.config["gdb_command"] = None
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.config["project_home"] = None
app.config["remap_sources"] = {}
manager = SessionManager()
app.config["_manager"] = manager
app.secret_key = binascii.hexlify(os.urandom(24)).decode("utf-8")
socketio = SocketIO(manage_session=False)


ANSI_CSI_RE = re.compile(r"\x1B\[[0-?]*[ -/]*[@-~]")
ANSI_OSC_RE = re.compile(r"\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)")
ANSI_SIMPLE_RE = re.compile(r"\x1B[@-Z\\-_]")
ANSI_CONTROL_RE = re.compile(r"[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]")


def _sanitize_terminal_output(data: Optional[str]) -> Optional[str]:
    if data is None:
        return None
    if not data:
        return ""

    cleaned = ANSI_OSC_RE.sub("", data)
    cleaned = ANSI_CSI_RE.sub("", cleaned)
    cleaned = ANSI_SIMPLE_RE.sub("", cleaned)
    cleaned = ANSI_CONTROL_RE.sub("", cleaned)

    cleaned = cleaned.replace("\r\n", "\n").replace("\r", "\n")

    if not cleaned and ("\n" in data or "\r" in data):
        return "\n"

    return cleaned


@dataclass
class ActiveCommand:
    command: str
    stdin: Any
    stdout: Any
    stderr: Any
    channel: "paramiko.Channel"
    stop_event: Event = field(default_factory=Event)
    termination_message: Optional[str] = None
    terminated_with_error: bool = False


@dataclass
class SshSession:
    client: ParamikoSSHClient
    command_lock: Lock = field(default_factory=Lock)
    shell_lock: Lock = field(default_factory=Lock)
    shell_channel: Optional["paramiko.Channel"] = None
    shell_stop_event: Optional[Event] = None
    shell_task: Optional[Any] = None
    command_task: Optional[Any] = None
    active_command: Optional[ActiveCommand] = None


ssh_clients: Dict[str, SshSession] = {}
ssh_clients_lock = Lock()


@dataclass
class PendingSshConnection:
    client: ParamikoSSHClient
    cancel_event: Event
    message_sent: bool = False


pending_ssh_connections: Dict[str, PendingSshConnection] = {}
pending_ssh_connections_lock = Lock()


@app.before_request
def csrf_protect_all_post_and_cross_origin_requests():
    """returns None upon success"""
    success = None
    wlist = {"/api/chat", "/api/GDBAssist", "/api/analyze_issue"}
    if request.path in wlist:
        return success
    if is_cross_origin(request):
        logger.warning("Received cross origin request. Aborting")
        abort(403)
    if request.method in ["POST", "PUT"]:
        server_token = session.get("csrf_token")
        if server_token == request.form.get("csrf_token"):
            return success
        elif server_token == request.environ.get("HTTP_X_CSRFTOKEN"):
            return success
        elif request.json and server_token == request.json.get("csrf_token"):
            return success
        else:
            logger.warning("Received invalid csrf token. Aborting")
            abort(403)
def _emit_to_client(event: str, payload: Dict[str, Any], client_id: str) -> None:
    socketio.emit(
        event,
        payload,
        namespace="/gdb_listener",
        room=client_id,
    )


def _get_ssh_session(client_id: str) -> Optional[SshSession]:
    with ssh_clients_lock:
        return ssh_clients.get(client_id)


def _stop_active_command(
    session: SshSession, client_id: str, *, message: Optional[str] = None, error: bool = False
) -> None:
    with session.command_lock:
        active_command = session.active_command
    if active_command is None:
        return

    active_command.termination_message = message
    active_command.terminated_with_error = error
    active_command.stop_event.set()

    try:
        active_command.channel.close()
    except Exception:
        logger.debug("Failed to close ssh command channel", exc_info=True)

def _stop_shell(session: SshSession, client_id: str, message: Optional[str] = None) -> None:
    with session.shell_lock:
        stop_event = session.shell_stop_event
        channel = session.shell_channel
        session.shell_stop_event = None
        session.shell_channel = None
        session.shell_task = None

    if stop_event is not None:
        stop_event.set()
    if channel is not None:
        try:
            channel.close()
        except Exception:
            logger.debug("Failed to close interactive shell channel", exc_info=True)

    if message:
        _emit_to_client(
            "ssh_shell_event",
            {"ok": True, "active": False, "message": message},
            client_id,
        )


def _shell_output_worker(client_id: str) -> None:
    while True:
        session = _get_ssh_session(client_id)
        if session is None:
            break

        with session.shell_lock:
            channel = session.shell_channel
            stop_event = session.shell_stop_event

        if channel is None or stop_event is None:
            break

        if stop_event.is_set():
            break

        try:
            stdout_data = b""
            while channel.recv_ready():
                stdout_data += channel.recv(4096)

            stderr_data = b""
            while channel.recv_stderr_ready():
                stderr_data += channel.recv_stderr(4096)

            if stdout_data:
                stdout_text = _sanitize_terminal_output(
                    stdout_data.decode("utf-8", errors="ignore")
                )
                if stdout_text:
                    _emit_to_client(
                        "ssh_shell_output",
                        {
                            "output": stdout_text,
                            "isError": False,
                        },
                        client_id,
                    )

            if stderr_data:
                stderr_text = _sanitize_terminal_output(
                    stderr_data.decode("utf-8", errors="ignore")
                )
                if stderr_text:
                    _emit_to_client(
                        "ssh_shell_output",
                        {
                            "output": stderr_text,
                            "isError": True,
                        },
                        client_id,
                    )

            if channel.closed or channel.exit_status_ready():
                _stop_shell(session, client_id)
                _emit_to_client(
                    "ssh_shell_event",
                    {
                        "ok": False,
                        "active": False,
                        "message": "交互式会话已结束。",
                    },
                    client_id,
                )
                break

        except socket.timeout:
            pass
        except Exception:
            logger.exception("Unexpected error while reading ssh shell output")
            _stop_shell(session, client_id)
            _emit_to_client(
                "ssh_shell_event",
                {
                    "ok": False,
                    "active": False,
                    "message": "读取交互式会话输出时发生错误。",
                },
                client_id,
            )
            break

        socketio.sleep(0.05)


def _command_output_worker(client_id: str, command: str) -> None:
    session = _get_ssh_session(client_id)
    if session is None:
        return

    with session.command_lock:
        active_command = session.active_command
    if active_command is None:
        return

    channel = active_command.channel
    exit_status: Optional[int] = None
    error_message: Optional[str] = None

    try:
        channel.settimeout(0.0)
    except Exception:
        logger.debug("Failed to set non-blocking mode on command channel", exc_info=True)

    try:
        while not active_command.stop_event.is_set():
            stdout_data = b""
            try:
                while channel.recv_ready():
                    stdout_data += channel.recv(4096)
            except socket.timeout:
                pass

            if stdout_data:
                stdout_text = _sanitize_terminal_output(
                    stdout_data.decode("utf-8", errors="ignore")
                )
                if stdout_text:
                    _emit_to_client(
                        "ssh_output",
                        {
                            "ok": True,
                            "output": stdout_text,
                            "state": "stream",
                            "command": command,
                        },
                        client_id,
                    )

            stderr_data = b""
            try:
                while channel.recv_stderr_ready():
                    stderr_data += channel.recv_stderr(4096)
            except socket.timeout:
                pass

            if stderr_data:
                stderr_text = _sanitize_terminal_output(
                    stderr_data.decode("utf-8", errors="ignore")
                )
                if stderr_text:
                    _emit_to_client(
                        "ssh_output",
                        {
                            "ok": False,
                            "error_output": stderr_text,
                            "state": "stream",
                            "command": command,
                        },
                        client_id,
                    )

            if channel.closed:
                break

            if channel.exit_status_ready():
                try:
                    exit_status = channel.recv_exit_status()
                except Exception as exc:  # pragma: no cover - defensive
                    logger.debug("Failed to read exit status", exc_info=True)
                    error_message = f"获取命令退出状态失败: {exc}"
                break

            socketio.sleep(0.05)

    except Exception:
        logger.exception("Unexpected error while executing ssh command")
        error_message = "执行命令时发生未预期的错误。"

    finally:
        try:
            active_command.stdin.close()
        except Exception:
            logger.debug("Failed to close command stdin", exc_info=True)
        try:
            active_command.stdout.close()
        except Exception:
            logger.debug("Failed to close command stdout", exc_info=True)
        try:
            active_command.stderr.close()
        except Exception:
            logger.debug("Failed to close command stderr", exc_info=True)

        with session.command_lock:
            if session.active_command is active_command:
                session.active_command = None
                session.command_task = None

    payload: Dict[str, Any] = {
        "state": "finished",
        "command": command,
    }

    if active_command.termination_message:
        payload.update(
            {
                "ok": not active_command.terminated_with_error,
                "message": active_command.termination_message,
            }
        )
    else:
        if exit_status is not None:
            payload.update(
                {
                    "ok": exit_status == 0,
                    "exit_status": exit_status,
                    "message": (
                        "命令已完成。"
                        if exit_status == 0
                        else f"命令已完成，退出状态 {exit_status}。"
                    ),
                }
            )
        elif error_message:
            payload.update({"ok": False, "message": error_message})
        else:
            payload.update({"ok": True, "message": "命令已完成。"})

    _emit_to_client("ssh_output", payload, client_id)

def cancel_pending_connection(client_id: str) -> Optional[PendingSshConnection]:
    with pending_ssh_connections_lock:
        pending = pending_ssh_connections.pop(client_id, None)
    if pending is None:
        return None

    pending.cancel_event.set()
    try:
        pending.client.close()
    except Exception:
        logger.debug(
            "Failed to close pending ssh client for %s", client_id, exc_info=True
        )
    return pending


def close_ssh_connection(client_id: str, message: Optional[str] = None) -> None:
    with ssh_clients_lock:
        session = ssh_clients.pop(client_id, None)

    connection_closed = session is not None
    ssh_client = session.client if session else None
    if session is not None:
        _stop_active_command(
            session, client_id, message="命令已因连接关闭而终止。", error=True
        )
        _stop_shell(session, client_id)
    if connection_closed and ssh_client is not None:
        try:
            ssh_client.close()
        except Exception:
            logger.exception("Failed to close ssh client for %s", client_id)
    if message and connection_closed:
        _emit_to_client("ssh_disconnected", {"message": message}, client_id)


@socketio.on("connect", namespace="/gdb_listener")
def client_connected():
    """Connect a websocket client to a debug session

    This is the main intial connection.

    Depending on the arguments passed, the client will connect
    to an existing debug session, or create a new one.
    A message is a emitted back to the client with details on
    the debug session that was created or connected to.
    """
    if is_cross_origin(request):
        logger.warning("Received cross origin request. Aborting")
        abort(403)

    csrf_token = request.args.get("csrf_token")
    if csrf_token is None:
        logger.warning("Recieved invalid csrf token")
        emit("server_error", {"message": "Recieved invalid csrf token"})
        return

    elif csrf_token != session.get("csrf_token"):
        # this can happen fairly often, so log debug message, not warning
        logger.debug(
            "Recieved invalid csrf token %s (expected %s)"
            % (csrf_token, str(session.get("csrf_token")))
        )
        emit(
            "server_error", {"message": "Session expired. Please refresh this webpage."}
        )
        return

    desired_gdbpid = int(request.args.get("gdbpid", 0))
    try:
        if desired_gdbpid:
            # connect to exiting debug session
            debug_session = manager.connect_client_to_debug_session(
                desired_gdbpid=desired_gdbpid, client_id=request.sid
            )
            emit(
                "debug_session_connection_event",
                {
                    "ok": True,
                    "started_new_gdb_process": False,
                    "pid": debug_session.pid,
                    "message": f"Connected to existing gdb process {desired_gdbpid}",
                },
            )
        else:
            # start new debug session
            gdb_command = request.args.get("gdb_command", app.config["gdb_command"])
            mi_version = request.args.get("mi_version", "mi2")
            debug_session = manager.add_new_debug_session(
                gdb_command=gdb_command, mi_version=mi_version, client_id=request.sid
            )
            emit(
                "debug_session_connection_event",
                {
                    "ok": True,
                    "started_new_gdb_process": True,
                    "message": f"Started new gdb process, pid {debug_session.pid}",
                    "pid": debug_session.pid,
                },
            )
    except Exception as e:
        emit(
            "debug_session_connection_event",
            {"message": f"Failed to establish gdb session: {e}", "ok": False},
        )

    # Make sure there is a reader thread reading. One thread reads all instances.
    if manager.gdb_reader_thread is None:
        manager.gdb_reader_thread = socketio.start_background_task(
            target=read_and_forward_gdb_and_pty_output
        )
        logger.info("Created background thread to read gdb responses")


@socketio.on("pty_interaction", namespace="/gdb_listener")
def pty_interaction(message):
    """Write a character to the user facing pty"""
    debug_session = manager.debug_session_from_client_id(request.sid)
    if not debug_session:
        emit(
            "error_running_gdb_command",
            {"message": f"no gdb session available for client id {request.sid}"},
        )
        return

    try:
        data = message.get("data")
        pty_name = data.get("pty_name")
        if pty_name == "user_pty":
            pty = debug_session.pty_for_gdb
        elif pty_name == "program_pty":
            pty = debug_session.pty_for_debugged_program
        else:
            raise ValueError(f"Unknown pty: {pty_name}")

        action = data.get("action")
        if action == "write":
            key = data["key"]
            pty.write(key)
        elif action == "set_winsize":
            pty.set_winsize(data["rows"], data["cols"])
        else:
            raise ValueError(f"Unknown action {action}")
    except Exception:
        err = traceback.format_exc()
        logger.error(err)
        emit("error_running_gdb_command", {"message": err})


@socketio.on("run_gdb_command", namespace="/gdb_listener")
def run_gdb_command(message: Dict[str, str]):
    """Write commands to gdbgui's gdb mi pty"""
    client_id = request.sid  # type: ignore
    debug_session = manager.debug_session_from_client_id(client_id)
    if not debug_session:
        emit("error_running_gdb_command", {"message": "no session"})
        return
    pty_mi = debug_session.pygdbmi_controller
    if pty_mi is not None:
        try:
            # the command (string) or commands (list) to run
            cmds = message["cmd"]
            for cmd in cmds:
                pty_mi.write(
                    cmd + "\n",
                    timeout_sec=0,
                    raise_error_on_timeout=False,
                    read_response=False,
                )

        except Exception:
            err = traceback.format_exc()
            logger.error(err)
            emit("error_running_gdb_command", {"message": err})
    else:
        emit("error_running_gdb_command", {"message": "gdb is not running"})


@socketio.on("ssh_connect", namespace="/gdb_listener")
def ssh_connect(message: Dict[str, Optional[str]]):
    client_id = request.sid
    host = (message.get("host") or "").strip()
    username = (message.get("username") or "").strip()
    password = message.get("password") or None

    if not PARAMIKO_AVAILABLE:
        emit(
            "ssh_connection_event",
            {
                "ok": False,
                "message": "服务器缺少 Paramiko 依赖，无法建立 SSH 连接。请先安装 paramiko。",
            },
        )
        return
    try:
        port = int(message.get("port", 22) or 22)
    except (TypeError, ValueError):
        emit(
            "ssh_connection_event",
            {"ok": False, "message": "提供的端口号无效。"},
        )
        return

    if not host or not username:
        emit(
            "ssh_connection_event",
            {"ok": False, "message": "主机地址和用户名是建立连接所必需的。"},
        )
        return

    previous_pending = cancel_pending_connection(client_id)
    if previous_pending is not None:
        previous_pending.message_sent = True
    close_ssh_connection(client_id)

    ssh_client = paramiko.SSHClient()
    ssh_client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    pending = PendingSshConnection(client=ssh_client, cancel_event=Event())
    with pending_ssh_connections_lock:
        pending_ssh_connections[client_id] = pending

    def establish_connection() -> None:
        try:
            ssh_client.connect(
                hostname=host,
                port=port,
                username=username,
                password=password,
                allow_agent=False,
                look_for_keys=False,
                timeout=10,
                banner_timeout=10,
                auth_timeout=10,
            )
            if pending.cancel_event.is_set():
                logger.info(
                    "SSH connection attempt for %s was cancelled after connecting", client_id
                )
                try:
                    ssh_client.close()
                except Exception:
                    logger.debug(
                        "Failed to close ssh client after cancellation for %s",
                        client_id,
                        exc_info=True,
                    )
                if not pending.message_sent:
                    _emit_to_client(
                        "ssh_connection_event",
                        {"ok": False, "message": "连接请求已取消。"},
                        client_id,
                    )
                    pending.message_sent = True
                return

            with ssh_clients_lock:
                ssh_clients[client_id] = SshSession(client=ssh_client)
            _emit_to_client(
                "ssh_connection_event",
                {
                    "ok": True,
                    "message": f"已连接到 {username}@{host}:{port}",
                },
                client_id,
            )
            logger.info(
                "SSH client %s connected to %s@%s:%s", client_id, username, host, port
            )
        except Exception as exc:
            try:
                ssh_client.close()
            except Exception:
                logger.debug(
                    "Failed to close ssh client after exception for %s",
                    client_id,
                    exc_info=True,
                )

            if pending.cancel_event.is_set():
                logger.info("SSH connection attempt for %s was cancelled", client_id)
                if not pending.message_sent:
                    _emit_to_client(
                        "ssh_connection_event",
                        {"ok": False, "message": "连接请求已取消。"},
                        client_id,
                    )
                    pending.message_sent = True
            else:
                logger.exception(
                    "Failed to connect ssh client %s to %s@%s:%s",
                    client_id,
                    username,
                    host,
                    port,
                )
                _emit_to_client(
                    "ssh_connection_event",
                    {"ok": False, "message": f"连接失败: {exc}"},
                    client_id,
                )
        finally:
            with pending_ssh_connections_lock:
                pending_ssh_connections.pop(client_id, None)

    socketio.start_background_task(establish_connection)


@socketio.on("ssh_command", namespace="/gdb_listener")
def ssh_command(message: Dict[str, Optional[str]]):
    client_id = request.sid
    command = (message.get("command") or "").strip()
    if not command:
        emit(
            "ssh_output",
            {"ok": False, "message": "未提供要执行的命令。"},
        )
        return

    if not PARAMIKO_AVAILABLE:
        emit(
            "ssh_output",
            {
                "ok": False,
                "message": "服务器未启用 SSH 支持。请安装 paramiko 后重试。",
                "command": command,
            },
        )
        return

    with ssh_clients_lock:
        session = ssh_clients.get(client_id)

    if session is None:
        emit(
            "ssh_output",
            {"ok": False, "message": "尚未建立 SSH 连接。", "command": command},
        )
        return

    with session.command_lock:
        if session.active_command is not None:
            emit(
                "ssh_output",
                {
                    "ok": False,
                    "message": "上一个命令仍在执行中，请完成后再试。",
                    "command": command,
                },
            )
            return

        try:
            stdin, stdout, stderr = session.client.exec_command(
                command, get_pty=True
            )
        except Exception as exc:
            emit(
                "ssh_output",
                {
                    "ok": False,
                    "message": f"执行命令失败: {exc}",
                    "command": command,
                },
            )
            return

        session.active_command = ActiveCommand(
            command=command,
            stdin=stdin,
            stdout=stdout,
            stderr=stderr,
            channel=stdout.channel,
        )
        session.command_task = socketio.start_background_task(
            _command_output_worker, client_id, command
        )

    emit(
        "ssh_output",
        {"ok": True, "command": command, "state": "started"},
    )


@socketio.on("ssh_shell_start", namespace="/gdb_listener")
def ssh_shell_start(message: Dict[str, Any]):
    client_id = request.sid

    if not PARAMIKO_AVAILABLE:
        emit(
            "ssh_shell_event",
            {
                "ok": False,
                "active": False,
                "message": "服务器未启用 SSH 支持，无法开启交互式会话。",
            },
        )
        return

    session = _get_ssh_session(client_id)
    if session is None:
        emit(
            "ssh_shell_event",
            {
                "ok": False,
                "active": False,
                "message": "尚未建立 SSH 连接。",
            },
        )
        return

    with session.shell_lock:
        existing_channel = session.shell_channel
        existing_stop_event = session.shell_stop_event
        if existing_channel is not None and existing_stop_event is not None:
            if not existing_stop_event.is_set() and not existing_channel.closed:
                emit(
                    "ssh_shell_event",
                    {
                        "ok": True,
                        "active": True,
                        "message": "交互式会话已就绪。",
                    },
                )
                return

    try:
        channel = session.client.invoke_shell()
        channel.settimeout(0.0)
    except Exception as exc:
        logger.exception("Failed to open interactive shell")
        emit(
            "ssh_shell_event",
            {
                "ok": False,
                "active": False,
                "message": f"无法开启交互式会话: {exc}",
            },
        )
        return

    stop_event = Event()
    with session.shell_lock:
        session.shell_channel = channel
        session.shell_stop_event = stop_event
        session.shell_task = socketio.start_background_task(
            _shell_output_worker, client_id
        )

    emit(
        "ssh_shell_event",
        {"ok": True, "active": True, "message": "交互式会话已启动。"},
    )


@socketio.on("ssh_shell_input", namespace="/gdb_listener")
def ssh_shell_input(message: Dict[str, Any]):
    client_id = request.sid
    data = message.get("data")
    if data is None:
        data = ""

    session = _get_ssh_session(client_id)
    if session is None:
        emit(
            "ssh_shell_event",
            {
                "ok": False,
                "active": False,
                "message": "尚未建立 SSH 连接。",
            },
        )
        return

    with session.shell_lock:
        channel = session.shell_channel
        stop_event = session.shell_stop_event

    if channel is None or stop_event is None or stop_event.is_set():
        emit(
            "ssh_shell_event",
            {
                "ok": False,
                "active": False,
                "message": "交互式会话尚未启动。",
            },
        )
        return

    try:
        channel.send(data)
    except Exception:
        logger.exception("Failed to send data to interactive shell")
        _stop_shell(session, client_id)
        emit(
            "ssh_shell_event",
            {
                "ok": False,
                "active": False,
                "message": "向交互式会话发送数据时出错，连接已关闭。",
            },
        )


@socketio.on("ssh_shell_stop", namespace="/gdb_listener")
def ssh_shell_stop():
    client_id = request.sid
    session = _get_ssh_session(client_id)
    if session is None:
        return

    _stop_shell(session, client_id, message="交互式会话已停止。")


@socketio.on("ssh_command_input", namespace="/gdb_listener")
def ssh_command_input(message: Dict[str, Any]):
    client_id = request.sid
    data = message.get("data")
    if data is None:
        data = ""

    session = _get_ssh_session(client_id)
    if session is None:
        emit(
            "ssh_output",
            {
                "ok": False,
                "message": "尚未建立 SSH 连接。",
                "state": "input_error",
            },
        )
        return

    with session.command_lock:
        active_command = session.active_command

    if active_command is None:
        emit(
            "ssh_output",
            {
                "ok": False,
                "message": "当前没有正在运行的命令。",
                "state": "input_error",
            },
        )
        return

    try:
        active_command.stdin.write(data)
        active_command.stdin.flush()
    except Exception:
        logger.exception("Failed to write to ssh command stdin")
        _stop_active_command(
            session,
            client_id,
            message="向命令发送输入时出现错误，命令已终止。",
            error=True,
        )


@socketio.on("ssh_disconnect", namespace="/gdb_listener")
def ssh_disconnect():
    client_id = request.sid
    pending = cancel_pending_connection(client_id)
    if pending is not None:
        if not pending.message_sent:
            _emit_to_client(
                "ssh_connection_event",
                {"ok": False, "message": "连接请求已取消。"},
                client_id,
            )
            pending.message_sent = True
        return

    close_ssh_connection(client_id, message="SSH 连接已断开。")


def send_msg_to_clients(client_ids, msg, error=False):
    """Send message to all clients"""
    if error:
        stream = "stderr"
    else:
        stream = "stdout"

    response = [{"message": None, "type": "console", "payload": msg, "stream": stream}]

    for client_id in client_ids:
        logger.info("emiting message to websocket client id " + client_id)
        socketio.emit(
            "gdb_response", response, namespace="/gdb_listener", room=client_id
        )


@socketio.on("disconnect", namespace="/gdb_listener")
def client_disconnected():
    """do nothing if client disconnects"""
    manager.disconnect_client(request.sid)
    pending = cancel_pending_connection(request.sid)
    if pending is not None:
        pending.message_sent = True
    close_ssh_connection(request.sid)

    logger.info("Client websocket disconnected, id %s" % (request.sid))


@socketio.on("Client disconnected")
def test_disconnect():
    print("Client websocket disconnected", request.sid)


def read_and_forward_gdb_and_pty_output():
    """A task that runs on a different thread, and emits websocket messages
    of gdb responses"""

    while True:
        socketio.sleep(0.05)
        debug_sessions_to_remove = []
        for debug_session, client_ids in manager.debug_session_to_client_ids.items():
            try:
                try:
                    response = debug_session.pygdbmi_controller.get_gdb_response(
                        timeout_sec=0, raise_error_on_timeout=False
                    )

                except Exception:
                    response = None
                    send_msg_to_clients(
                        client_ids,
                        "The underlying gdb process has been killed. This tab will no longer function as expected.",
                        error=True,
                    )
                    debug_sessions_to_remove.append(debug_session)

                if response:
                    for client_id in client_ids:
                        logger.info(
                            "emiting message to websocket client id " + client_id
                        )
                        socketio.emit(
                            "gdb_response",
                            response,
                            namespace="/gdb_listener",
                            room=client_id,
                        )
                else:
                    # there was no queued response from gdb, not a problem
                    pass

            except Exception:
                logger.error("caught exception, continuing:" + traceback.format_exc())

        debug_sessions_to_remove += check_and_forward_pty_output()
        for debug_session in set(debug_sessions_to_remove):
            manager.remove_debug_session(debug_session)


def check_and_forward_pty_output() -> List[DebugSession]:
    debug_sessions_to_remove = []
    for debug_session, client_ids in manager.debug_session_to_client_ids.items():
        try:
            response = debug_session.pty_for_gdb.read()
            if response is not None:
                for client_id in client_ids:
                    socketio.emit(
                        "user_pty_response",
                        response,
                        namespace="/gdb_listener",
                        room=client_id,
                    )

            response = debug_session.pty_for_debugged_program.read()
            if response is not None:
                for client_id in client_ids:
                    socketio.emit(
                        "program_pty_response",
                        response,
                        namespace="/gdb_listener",
                        room=client_id,
                    )
        except Exception as e:
            debug_sessions_to_remove.append(debug_session)
            for client_id in client_ids:
                socketio.emit(
                    "fatal_server_error",
                    {"message": str(e)},
                    namespace="/gdb_listener",
                    room=client_id,
                )
            logger.error(e, exc_info=True)
    return debug_sessions_to_remove
