// gdbgui/src/js/SshConsole.tsx
import React from "react";
import GdbApi from "./GdbApi";


type Message = {
  id: number;
  role: "user" | "server";
  content: string;
  isError?: boolean;
};

type SshConnectionState = "disconnected" | "connecting" | "connected";

const initialFormState = {
  host: "",
  port: 22,
  username: "",
  password: "",
};

const statusLabels: Record<SshConnectionState, string> = {
  disconnected: "未连接",
  connecting: "连接中...",
  connected: "已连接",
};

const passwordPromptRegex = /(password|passphrase|密码)\s*[:：]?\s*$/i;

const CSI_FINAL_MIN = 0x40;
const CSI_FINAL_MAX = 0x7e;
const CSI_PARAMETER_MIN = 0x30;
const CSI_PARAMETER_MAX = 0x3f;
const CSI_INTERMEDIATE_MIN = 0x20;
const CSI_INTERMEDIATE_MAX = 0x2f;

type TerminalSanitizerState = {
  pending: string;
  currentLine: string;
  emittedLength: number;
};

const ansiGeneralPattern =
  /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B[@-Z\\-_]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
const controlCharsPattern = /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F]/g;

const stripAnsi = (value: string): string =>
  value.replace(ansiGeneralPattern, "").replace(controlCharsPattern, "");

const isControlCode = (code: number): boolean => {
  if (code >= 0 && code <= 8) {
    return true;
  }
  if (code === 11 || code === 12 || code === 127) {
    return true;
  }
  return code >= 14 && code <= 31;
};

const consumeCsiSequence = (input: string, start: number, index: number): number | null => {
  let cursor = index;

  while (cursor < input.length) {
    const code = input.charCodeAt(cursor);
    if (code >= CSI_FINAL_MIN && code <= CSI_FINAL_MAX) {
      return cursor - start + 1;
    }
    const isParameter = code >= CSI_PARAMETER_MIN && code <= CSI_PARAMETER_MAX;
    const isIntermediate = code >= CSI_INTERMEDIATE_MIN && code <= CSI_INTERMEDIATE_MAX;
    if (!isParameter && !isIntermediate) {
      return cursor - start + 1;
    }
    cursor += 1;
  }

  return null;
};

const consumeOscSequence = (input: string, start: number): number | null => {
  let cursor = start;

  while (cursor < input.length) {
    const code = input.charCodeAt(cursor);
    if (code === 0x07) {
      return cursor - (start - 2) + 1;
    }
    if (code === 0x1b && input[cursor + 1] === "\\") {
      return cursor - (start - 2) + 2;
    }
    if (code === 0x9c) {
      return cursor - (start - 2) + 1;
    }
    cursor += 1;
  }

  return null;
};

const consumeStTerminatedSequence = (input: string, start: number): number | null => {
  let cursor = start;

  while (cursor < input.length) {
    const code = input.charCodeAt(cursor);
    if (code === 0x1b && input[cursor + 1] === "\\") {
      return cursor - (start - 2) + 2;
    }
    if (code === 0x9c) {
      return cursor - (start - 2) + 1;
    }
    cursor += 1;
  }

  return null;
};

const consumeSimpleEscape = (input: string, start: number): number | null => {
  let cursor = start + 1;

  while (cursor < input.length) {
    const code = input.charCodeAt(cursor);
    if (code >= 0x30 && code <= 0x7e) {
      return cursor - start + 1;
    }
    if (code < 0x20 || code > 0x2f) {
      return cursor - start + 1;
    }
    cursor += 1;
  }

  return null;
};

const consumeEscapeSequence = (input: string, start: number): number | null => {
  const first = input[start];

  if (first === "\u009b") {
    return consumeCsiSequence(input, start, start + 1);
  }

  if (first !== "\u001b") {
    return 1;
  }

  const next = input[start + 1];
  if (next === undefined) {
    return null;
  }

  if (next === "[") {
    return consumeCsiSequence(input, start, start + 2);
  }

  if (next === "]") {
    return consumeOscSequence(input, start + 2);
  }

  if (next === "P" || next === "^" || next === "_" || next === "X") {
    return consumeStTerminatedSequence(input, start + 2);
  }

  return consumeSimpleEscape(input, start);
};

const stripAnsiAndControls = (
  chunk: string,
  pending: string,
): { clean: string; remainder: string } => {
  if (!pending && !chunk) {
    return { clean: "", remainder: "" };
  }

  const data = pending ? pending + chunk : chunk;
  let clean = "";
  let index = 0;

  while (index < data.length) {
    const char = data[index];

    if (char === "\u001b" || char === "\u009b") {
      const consumed = consumeEscapeSequence(data, index);
      if (consumed === null) {
        return { clean, remainder: data.slice(index) };
      }
      index += consumed;
      continue;
    }

    const code = data.charCodeAt(index);
    if (isControlCode(code)) {
      index += 1;
      continue;
    }

    clean += char;
    index += 1;
  }

  return { clean, remainder: "" };
};

const applyCarriageControl = (
  value: string,
  state: TerminalSanitizerState,
): string => {
  if (!value) {
    return "";
  }

  let result = "";
  let { currentLine, emittedLength } = state;
  let index = 0;

  const flushPartialLine = () => {
    const delta = currentLine.slice(emittedLength);
    if (delta) {
      result += delta;
    }
    emittedLength = currentLine.length;
  };

  while (index < value.length) {
    const char = value[index];

    if (char === "\r") {
      if (index + 1 < value.length && value[index + 1] === "\n") {
        flushPartialLine();
        result += "\n";
        currentLine = "";
        emittedLength = 0;
        index += 2;
        continue;
      }
      const hadLineContent = emittedLength > 0 || currentLine.length > 0;
      flushPartialLine();
      if (hadLineContent && !result.endsWith("\n")) {
        result += "\n";
      }
      currentLine = "";
      emittedLength = 0;
      index += 1;
      continue;
    }

    if (char === "\n") {
      flushPartialLine();
      result += "\n";
      currentLine = "";
      emittedLength = 0;
      index += 1;
      continue;
    }

    currentLine += char;
    index += 1;
  }

  flushPartialLine();

  state.currentLine = currentLine;
  state.emittedLength = emittedLength;

  return result;
};

const sanitizeChunk = (raw: string, state: TerminalSanitizerState): string => {
  const { clean, remainder } = stripAnsiAndControls(raw, state.pending);
  state.pending = remainder;
  return applyCarriageControl(clean, state);
};

const prepareDisplayContent = (
  raw: string | undefined,
  state: TerminalSanitizerState,
): string | null => {
  if (!raw) {
    return null;
  }

  const sanitized = sanitizeChunk(raw, state);
  if (sanitized) {
    return sanitized;
  }

  return /\r?\n/.test(raw) ? "\n" : null;
};

type SshConsoleHandle = {
  getLastServerOutput: () => string | null;
};

const SshConsole = React.forwardRef<SshConsoleHandle, {}>((_props, ref) => {
  // Keep the socket in state so that it can be updated once GdbApi initialises.
  const [socket, setSocket] = React.useState<any>(GdbApi.getSocket());
  const [connectionState, setConnectionState] =
    React.useState<SshConnectionState>("disconnected");
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [formState, setFormState] = React.useState(initialFormState);
  const [command, setCommand] = React.useState("");
  const [isCommandRunning, setIsCommandRunning] = React.useState(false);
  const [commandHistory, setCommandHistory] = React.useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = React.useState<number | null>(null);
  const [isShellActive, setIsShellActive] = React.useState(false);
  const [isShellToggling, setIsShellToggling] = React.useState(false);
  const nextMessageIdRef = React.useRef(1);
  const messageEndRef = React.useRef<HTMLDivElement | null>(null);
  const commandInputRef = React.useRef<HTMLInputElement | null>(null);
  const connectionTimeoutRef = React.useRef<number | null>(null);
  const commandSanitizerRef = React.useRef<TerminalSanitizerState>({
    pending: "",
    currentLine: "",
    emittedLength: 0,
  });
  const shellSanitizerRef = React.useRef<TerminalSanitizerState>({
    pending: "",
    currentLine: "",
    emittedLength: 0,
  });

  const resetSanitizers = React.useCallback(() => {
    commandSanitizerRef.current.pending = "";
    commandSanitizerRef.current.currentLine = "";
    commandSanitizerRef.current.emittedLength = 0;
    shellSanitizerRef.current.pending = "";
    shellSanitizerRef.current.currentLine = "";
    shellSanitizerRef.current.emittedLength = 0;
  }, []);

  const sanitizeForDisplay = React.useCallback(
    (raw: string | undefined, state: TerminalSanitizerState): string | null =>
      prepareDisplayContent(raw, state),
    [],
  );

  const sanitizeEphemeral = React.useCallback(
    (raw: string | undefined): string | null =>
      prepareDisplayContent(raw, { pending: "", currentLine: "", emittedLength: 0 }),
    [],
  );

  React.useEffect(() => {
    if (!socket) {
      const api: any = GdbApi as any;
      if (api && typeof api.init === "function") {
        try {
          api.init();
        } catch (err) {
          console.warn("Failed to init GdbApi:", err);
        }
      }
      const newSocket = GdbApi.getSocket();
      if (newSocket) {
        setSocket(newSocket);
      }
    }
  }, [socket]);

  const appendMessage = React.useCallback((message: Omit<Message, "id">) => {
    setMessages((prevMessages) => {
      if (prevMessages.length && message.role === "server") {
        const lastMessage = prevMessages[prevMessages.length - 1];
        const sameRole = lastMessage.role === message.role;
        const sameError = Boolean(lastMessage.isError) === Boolean(message.isError);

        if (sameRole && sameError) {
          const mergedMessages = [...prevMessages];
          const trailingNewline = lastMessage.content.endsWith("\n");
          const incomingContent = message.content;
          const combinedContent = trailingNewline || incomingContent.startsWith("\n")
            ? `${lastMessage.content}${incomingContent}`
            : `${lastMessage.content}\n${incomingContent}`;

          mergedMessages[mergedMessages.length - 1] = {
            ...lastMessage,
            content: combinedContent,
          };
          return mergedMessages;
        }
      }

      return [
        ...prevMessages,
        {
          ...message,
          id: nextMessageIdRef.current++,
        },
      ];
    });
  }, []);

  // Expose an imperative handle so parent can read the last server output
  React.useImperativeHandle(ref, () => ({
    getLastServerOutput: () => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "server") return messages[i].content || null;
      }
      return null;
    },
  }), [messages]);

  const [shouldMaskNextInput, setShouldMaskNextInput] = React.useState(false);

  const checkForPasswordPrompt = React.useCallback((text: string) => {
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (passwordPromptRegex.test(line.trim())) {
        setShouldMaskNextInput(true);
        break;
      }
    }
  }, []);

  const handleShellOutput = React.useCallback(
    (data: { output?: string; isError?: boolean }) => {
      const displayContent = sanitizeForDisplay(data.output, shellSanitizerRef.current);
      if (displayContent === null) {
        return;
      }
      checkForPasswordPrompt(displayContent);
      appendMessage({
        role: "server",
        content: displayContent,
        isError: data.isError,
      });
    },
    [appendMessage, checkForPasswordPrompt, sanitizeForDisplay],
  );

  const handleShellEvent = React.useCallback(
    (data: { ok: boolean; active?: boolean; message?: string }) => {
      if (typeof data.active === "boolean") {
        setIsShellActive(data.active);
        if (!data.active) {
          setShouldMaskNextInput(false);
        } else {
          shellSanitizerRef.current.pending = "";
          shellSanitizerRef.current.currentLine = "";
          shellSanitizerRef.current.emittedLength = 0;
        }
      } else if (!data.ok) {
        setIsShellActive(false);
        setShouldMaskNextInput(false);
      }
      setIsShellToggling(false);
      const eventMessage = sanitizeEphemeral(data.message);
      if (eventMessage !== null) {
        appendMessage({
          role: "server",
          content: eventMessage,
          isError: !data.ok,
        });
      }
    },
    [appendMessage, sanitizeEphemeral],
  );

  React.useEffect(() => {
    if (!socket) {
      return;
    }

    const handleConnection = (data: { ok: boolean; message?: string }) => {
      setConnectionState(data.ok ? "connected" : "disconnected");
      setIsShellToggling(false);
      if (data.ok) {
        setIsShellActive(false);
        setIsShellToggling(false);
        setIsCommandRunning(false);
        setShouldMaskNextInput(false);
        setFormState((prev) => ({ ...prev, password: "" }));
        resetSanitizers();
      } else {
        setIsCommandRunning(false);
        setShouldMaskNextInput(false);
        resetSanitizers();
      }
      const messageContent = sanitizeEphemeral(data.message);
      if (messageContent !== null) {
        appendMessage({
          role: "server",
          content: messageContent,
          isError: !data.ok,
        });
      }
    };

    const handleOutput = (data: {
      ok: boolean;
      output?: string;
      error_output?: string;
      command?: string;
      message?: string;
      state?: string;
      exit_status?: number;
    }) => {
      if (data.state === "started") {
        setIsCommandRunning(true);
        setShouldMaskNextInput(false);
        commandSanitizerRef.current.pending = "";
        commandSanitizerRef.current.currentLine = "";
        commandSanitizerRef.current.emittedLength = 0;
        const startedMessage = sanitizeEphemeral(data.message);
        if (startedMessage !== null) {
          appendMessage({
            role: "server",
            content: startedMessage,
            isError: !data.ok,
          });
        }
        return;
      }

      if (data.state === "input_error") {
        setIsCommandRunning(false);
        setShouldMaskNextInput(false);
        const inputErrorMessage = sanitizeEphemeral(data.message);
        if (inputErrorMessage !== null) {
          appendMessage({
            role: "server",
            content: inputErrorMessage,
            isError: true,
          });
        }
        return;
      }

      if (!data.state && data.command) {
        appendMessage({ role: "user", content: data.command });
      }

      if (data.state !== "stream") {
        const messageContent = sanitizeEphemeral(data.message);
        if (messageContent !== null) {
          appendMessage({
            role: "server",
            content: messageContent,
            isError: !data.ok,
          });
          checkForPasswordPrompt(messageContent);
        }
      }

      const outputContent = sanitizeForDisplay(data.output, commandSanitizerRef.current);
      if (outputContent !== null) {
        appendMessage({ role: "server", content: outputContent });
        checkForPasswordPrompt(outputContent);
      }

      const errorOutputContent = sanitizeForDisplay(
        data.error_output,
        commandSanitizerRef.current,
      );
      if (errorOutputContent !== null) {
        appendMessage({
          role: "server",
          content: errorOutputContent,
          isError: true,
        });
        checkForPasswordPrompt(errorOutputContent);
      }

      if (data.state === "finished" || (!data.state && data.message)) {
        setIsCommandRunning(false);
        setShouldMaskNextInput(false);
      }
    };

    const handleDisconnect = (data: { message?: string }) => {
      setConnectionState("disconnected");
      setIsCommandRunning(false);
      setIsShellActive(false);
      setIsShellToggling(false);
      setShouldMaskNextInput(false);
      const disconnectMessage = sanitizeEphemeral(data.message);
      if (disconnectMessage !== null) {
        appendMessage({ role: "server", content: disconnectMessage, isError: true });
      }
    };

    socket.on("ssh_connection_event", handleConnection);
    socket.on("ssh_output", handleOutput);
    socket.on("ssh_disconnected", handleDisconnect);
    socket.on("ssh_shell_output", handleShellOutput);
    socket.on("ssh_shell_event", handleShellEvent);

    return () => {
      socket.off("ssh_connection_event", handleConnection);
      socket.off("ssh_output", handleOutput);
      socket.off("ssh_disconnected", handleDisconnect);
      socket.off("ssh_shell_output", handleShellOutput);
      socket.off("ssh_shell_event", handleShellEvent);
    };
  }, [appendMessage, checkForPasswordPrompt, handleShellEvent, handleShellOutput, resetSanitizers, sanitizeEphemeral, sanitizeForDisplay, socket]);

  // NOTE: previously we emitted `ssh_disconnect` when this component unmounted
  // or when the socket changed. That caused navigating away from panels that
  // mount/unmount this component (for example, the valgrind panel) to close the
  // SSH session unexpectedly. Do not auto-disconnect on unmount — keep the
  // session alive until the user explicitly clicks the "断开" button or the
  // socket truly closes.

  React.useEffect(() => {
    if (connectionState !== "connecting") {
      if (connectionTimeoutRef.current !== null) {
        window.clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
      return;
    }

    connectionTimeoutRef.current = window.setTimeout(() => {
      let shouldNotify = false;
      setConnectionState((current) => {
        if (current === "connecting") {
          shouldNotify = true;
          return "disconnected";
        }
        return current;
      });

      if (shouldNotify) {
        appendMessage({
          role: "server",
          content: "连接超时，请检查网络或服务器状态后重试。",
          isError: true,
        });
        setIsCommandRunning(false);
      }
      connectionTimeoutRef.current = null;
    }, 15000);

    return () => {
      if (connectionTimeoutRef.current !== null) {
        window.clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
    };
  }, [appendMessage, connectionState]);

  // Scroll to the bottom of the message list whenever messages change.
  React.useEffect(() => {
    if (messageEndRef.current) {
      messageEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages]);

  // Ensure the command input receives focus when the session becomes ready.
  React.useEffect(() => {
    if (connectionState === "connected" && commandInputRef.current) {
      commandInputRef.current.focus();
    }
  }, [connectionState, isShellActive, isCommandRunning]);

  const updateFormState = (
    key: keyof typeof initialFormState,
    value: string | number,
  ) => {
    setFormState((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const submitConnection = (event: React.FormEvent) => {
    event.preventDefault();
    if (!socket || connectionState === "connecting") {
      return;
    }
    if (!formState.host || !formState.username) {
      appendMessage({
        role: "server",
        content: "请输入主机地址和用户名以建立 SSH 连接。",
        isError: true,
      });
      return;
    }
    setConnectionState("connecting");
    appendMessage({
      role: "server",
      content: `正在连接到 ${formState.username}@${formState.host}:${formState.port}...`,
    });
    socket.emit("ssh_connect", {
      host: formState.host,
      port: formState.port,
      username: formState.username,
      password: formState.password,
    });
  };

  const disconnect = () => {
    if (!socket) {
      return;
    }
    resetSanitizers();
    socket.emit("ssh_disconnect");
  };

  const submitCommand = (event: React.FormEvent) => {
    event.preventDefault();
    if (!socket || connectionState !== "connected") {
      return;
    }
    if (isShellActive) {
      const dataToSend = `${command}\n`;
      setCommand("");
      setHistoryIndex(null);
      const shouldStoreHistory = Boolean(command) && !shouldMaskNextInput;
      if (shouldStoreHistory) {
        setCommandHistory((prev) =>
          prev.length && prev[prev.length - 1] === command ? prev : [...prev, command],
        );
      }
      if (command) {
        if (shouldMaskNextInput) {
          appendMessage({ role: "user", content: "(输入已隐藏)" });
          setShouldMaskNextInput(false);
        } else {
          appendMessage({ role: "user", content: command });
        }
      } else {
        appendMessage({ role: "user", content: "(发送空行)" });
        if (shouldMaskNextInput) {
          setShouldMaskNextInput(false);
        }
      }
      socket.emit("ssh_shell_input", { data: dataToSend });
      return;
    }

    if (isCommandRunning) {
      const dataToSend = `${command}\n`;
      setCommand("");
      setHistoryIndex(null);
      if (command) {
        if (shouldMaskNextInput) {
          appendMessage({ role: "user", content: "(输入已隐藏)" });
        } else {
          appendMessage({ role: "user", content: command });
          setCommandHistory((prev) =>
            prev.length && prev[prev.length - 1] === command ? prev : [...prev, command],
          );
        }
      } else {
        appendMessage({ role: "user", content: "(发送空行)" });
      }
      if (shouldMaskNextInput) {
        setShouldMaskNextInput(false);
      }
      socket.emit("ssh_command_input", { data: dataToSend });
      return;
    }

    if (!command.trim()) {
      return;
    }
    const trimmedCommand = command.trim();
    setCommand("");
    setShouldMaskNextInput(false);
    setCommandHistory((prev) =>
      prev.length && prev[prev.length - 1] === trimmedCommand
        ? prev
        : [...prev, trimmedCommand],
    );
    setHistoryIndex(null);
    appendMessage({ role: "user", content: trimmedCommand });
    setIsCommandRunning(true);
    socket.emit("ssh_command", {
      command: trimmedCommand,
    });
  };

  const handleCommandKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (!commandHistory.length) {
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHistoryIndex((prev) => {
        const newIndex =
          prev === null ? commandHistory.length - 1 : Math.max(prev - 1, 0);
        const historyValue = commandHistory[newIndex];
        if (historyValue === undefined) {
          return prev;
        }
        setCommand(historyValue);
        return newIndex;
      });
    } else if (event.key === "ArrowDown") {
      if (historyIndex === null) {
        return;
      }
      event.preventDefault();
      setHistoryIndex((prev) => {
        if (prev === null) {
          return null;
        }
        if (prev >= commandHistory.length - 1) {
          setCommand("");
          return null;
        }
        const newIndex = prev + 1;
        const historyValue = commandHistory[newIndex];
        if (historyValue === undefined) {
          return prev;
        }
        setCommand(historyValue);
        return newIndex;
      });
    }
  };

  return (
    <div className="flex h-full flex-col bg-black text-gray-100">
      <form
        className="grid gap-2 border-b border-gray-800 bg-gray-900 p-4 text-sm md:grid-cols-6 md:items-end"
        onSubmit={submitConnection}
      >
        <div className="flex flex-col">
          <label className="mb-1 text-xs uppercase tracking-widest text-gray-400">
            主机
          </label>
          <input
            type="text"
            className="rounded bg-gray-800 p-2 text-gray-100 focus:outline-none"
            value={formState.host}
            onChange={(event) => updateFormState("host", event.target.value)}
            placeholder="example.com"
          />
        </div>
        <div className="flex flex-col">
          <label className="mb-1 text-xs uppercase tracking-widest text-gray-400">
            端口
          </label>
          <input
            type="number"
            min={1}
            className="rounded bg-gray-800 p-2 text-gray-100 focus:outline-none"
            value={formState.port}
            onChange={(event) => updateFormState("port", Number(event.target.value))}
          />
        </div>
        <div className="flex flex-col">
          <label className="mb-1 text-xs uppercase tracking-widest text-gray-400">
            用户名
          </label>
          <input
            type="text"
            className="rounded bg-gray-800 p-2 text-gray-100 focus:outline-none"
            value={formState.username}
            onChange={(event) => updateFormState("username", event.target.value)}
            placeholder="user"
          />
        </div>
        <div className="flex flex-col">
          <label className="mb-1 text-xs uppercase tracking-widest text-gray-400">
            密码
          </label>
          <input
            type="password"
            className="rounded bg-gray-800 p-2 text-gray-100 focus:outline-none"
            value={formState.password}
            onChange={(event) => updateFormState("password", event.target.value)}
            placeholder="可选"
          />
        </div>
        <div className="flex items-end gap-2">
          <button
            className="rounded bg-blue-600 px-3 py-2 text-xs font-semibold tracking-wide text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-blue-900"
            type="submit"
            disabled={connectionState === "connecting"}
          >
            {connectionState === "connected"
              ? "重新连接"
              : connectionState === "connecting"
              ? "连接中..."
              : "连接"}
          </button>
          <button
            type="button"
            className="rounded bg-red-600 px-3 py-2 text-xs font-semibold tracking-wide text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:bg-red-900"
            onClick={disconnect}
            disabled={connectionState === "disconnected"}
          >
            {connectionState === "connecting" ? "取消连接" : "断开"}
          </button>
          <button
            type="button"
            className="rounded bg-purple-600 px-3 py-2 text-xs font-semibold tracking-wide text-white hover:bg紫-500 disabled:cursor-not-allowed disabled:bg紫-900"
            onClick={() => {
              if (!socket || connectionState !== "connected") {
                return;
              }
              setIsShellToggling(true);
              if (isShellActive) {
                socket.emit("ssh_shell_stop");
              } else {
                socket.emit("ssh_shell_start", {});
              }
            }}
            disabled={connectionState !== "connected" || isShellToggling}
          >
            {isShellActive
              ? isShellToggling
                ? "停止交互中..."
                : "停止交互"
              : isShellToggling
              ? "开启交互中..."
              : "开启交互"}
          </button>
        </div>
        <div className="flex items-end text-xs text-gray-400 md:justify-end">
          当前状态：{statusLabels[connectionState]}
          {isShellActive && connectionState === "connected" && " · 交互式会话已启用"}
        </div>
      </form>

      <div className="flex-1 overflow-auto p-4 text-sm">
        {messages.length === 0 ? (
          <div className="text-gray-400">
            建立 SSH 连接后，可以在下方输入框中发送命令并查看输出。
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((message) => (
              <div key={message.id} className="whitespace-pre-wrap">
                <span
                  className={`mr-2 font-semibold ${
                    message.role === "user" ? "text-blue-400" : "text-green-400"
                  }`}
                >
                  {message.role === "user" ? "命令" : "远端"}
                </span>
                <span className={message.isError ? "text-red-400" : "text-gray-100"}>
                  {message.content || "(无输出)"}
                </span>
              </div>
            ))}
            <div ref={messageEndRef} />
          </div>
        )}
      </div>

      <form className="border-t border-gray-800 bg-gray-900 p-4" onSubmit={submitCommand}>
        <div className="flex gap-2">
          <input
            type="text"
            className="flex-1 rounded bg-gray-800 p-2 text-gray-100 focus:outline-none"
            value={command}
            placeholder={
              connectionState === "connected"
                ? isShellActive
                  ? "交互模式：输入内容后回车发送"
                  : isCommandRunning
                  ? shouldMaskNextInput
                    ? "命令正在等待密码，请输入后回车"
                    : "命令正在执行，可输入附加内容后回车"
                  : "输入要执行的命令并回车"
                : "请先连接到 SSH 服务器"
            }
            onChange={(event) => {
              setCommand(event.target.value);
              setHistoryIndex(null);
            }}
            disabled={connectionState !== "connected"}
            onKeyDown={handleCommandKeyDown}
            ref={commandInputRef}
          />
          <button
            className="rounded bg蓝-600 px-3 py-2 text-xs font-semibold tracking-wide text白 hover:bg蓝-500 disabled:cursor-not-allowed disabled:bg蓝-900"
            type="submit"
            disabled={connectionState !== "connected" || isShellToggling}
          >
            {isShellActive
              ? "发送"
              : isCommandRunning
              ? shouldMaskNextInput
                ? "提交密码"
                : "发送输入"
              : "发送"}
          </button>
        </div>
      </form>
    </div>
  );
});

export default SshConsole;
