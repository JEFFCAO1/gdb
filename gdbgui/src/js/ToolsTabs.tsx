import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import "../../static/css/tailwind.css";
import "./initGlobals";
import SshConsole from "./SshConsole";
import GdbApi from "./GdbApi";
import SplitPane from "react-split-pane";

function removeSuffix(s: string | null, suffix: string): string  {
    if(!s) return "";
    return s.endsWith(suffix) ? s.slice(0, s.length - suffix.length) : s;
}

function ChatSidebar({
  onCollectPty,
  injectedMessage,
  className,
  getCollectedData,
  showStraceOption = false,
  showValgrindOption = false,
  getLastSshOutput,
}: {
  onCollectPty: () => void;
  injectedMessage?: string | null;
  className?: string | "w-80";
  getCollectedData?: () => Promise<string | null>;
  showStraceOption?: boolean;
  showValgrindOption?: boolean;
  getLastSshOutput?: () => string | null;
}) {
  const [messages, setMessages] = React.useState([
    { sender: "ai", text: "Hi! I'm your AI assistant. How can I help you today?" },
  ]);
  const [input, setInput] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [autoCollect, setAutoCollect] = React.useState(false);
  const [straceChecked, setStraceChecked] = React.useState(false);
  const [valgrind, setVargrind] = React.useState(false);
  const [waitingForCollection, setWaitingForCollection] = React.useState(false);
  const [conversationId, setConversationId] = React.useState<string | null>(null);
  const messagesEndRef = React.useRef<HTMLDivElement>(null);
  const collectionPromiseRef = React.useRef<{
    resolve: (value: { [key: string]: string } | null) => void;
    reject: (error: any) => void;
  } | null>(null);
  const lastInjectedMessageRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  // Store structured debug context from collection
  const [structuredDebugContextRef, setStructuredDebugContextRef] = React.useState<{ [key: string]: string } | null>(null);

  // Listen for structured debug context from iframe
  React.useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data.type === "structuredDebugContext") {
        const debugContext = event.data.payload;
        console.debug("[ChatSidebar] Received structured debug context:", debugContext);

        setStructuredDebugContextRef(debugContext);

        // If we're waiting for collection, resolve the promise
        if (waitingForCollection && collectionPromiseRef.current) {
          collectionPromiseRef.current.resolve(debugContext);
          collectionPromiseRef.current = null;
          setWaitingForCollection(false);
        }
        // Only show message in chat if auto-collect is disabled AND we're not waiting for collection
        else if (!autoCollect && !waitingForCollection) {
          // For structured data, show a simple summary instead of raw data
          const summary = `Debug context available: ${Object.keys(debugContext)
            .filter((k) => debugContext[k])
            .join(", ")}`;
          setMessages((msgs) => [...msgs, { sender: "ai", text: summary }]);
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [autoCollect, waitingForCollection]);

  // Legacy support for injected messages (keeping for backward compatibility)
  React.useEffect(() => {
    if (injectedMessage && injectedMessage !== lastInjectedMessageRef.current) {
      lastInjectedMessageRef.current = injectedMessage;

      // Only show legacy messages if auto-collect is disabled AND we're not waiting for collection
      if (!autoCollect && !waitingForCollection) {
        // Only show if this message doesn't look like debug context
        const isDebugContext = /### Collected Terminal Contents|### Source Code Contents|### Right Sidebar Contents/.test(injectedMessage);
        if (!isDebugContext) {
          setMessages((msgs) => [...msgs, { sender: "ai", text: injectedMessage }]);
        }
      }
    }
  }, [injectedMessage, autoCollect, waitingForCollection]);

  function formatAssistantReply(raw: string): string {
    if (!raw) return "[No reply]";
    let txt = raw.trim();
    // Collapse excessive blank lines
    txt = txt.replace(/\n{3,}/g, "\n\n");
    // Ensure code fences are balanced
    const fenceCount = (txt.match(/```/g) || []).length;
    if (fenceCount % 2 === 1) {
      txt += "\n```";
    }
    // Add markdown bullets when the model returns numbered list without periods
    txt = txt.replace(/^(\d+) +(.*)$/gm, (m, n, rest) => `${n}. ${rest}`);
    // Normalize indentation inside code blocks
    txt = txt.replace(/```[\s\S]*?```/g, (block) => {
      const lines = block.split("\n");
      if (lines.length < 3) return block; // nothing to normalize
      const contentLines = lines.slice(1, -1);
      const indents = contentLines
        .filter((l) => l.trim())
        .map((l) => l.match(/^\s*/)?.[0].length || 0);
      const minIndent = indents.length ? Math.min(...indents) : 0;
      if (minIndent > 0) {
        const newContent = contentLines.map((l) => l.slice(minIndent)).join("\n");
        return [lines[0], newContent, lines[lines.length - 1]].join("\n");
      }
      return block;
    });
    return txt;
  }

  // No longer needed - using structured data directly from collection

  async function handleSend() {
    if (!input.trim() || loading) return;
    setError("");
    const userMsg = { sender: "user" as const, text: input };
    setMessages((msgs) => [...msgs, userMsg]);
    setInput("");
    setLoading(true);

    // Auto-collect context if checkbox is enabled
    let structuredDebugContext: { [key: string]: string } = {};
    if (autoCollect) {
      try {
        // Create a promise to wait for collection
        const collectionPromise = new Promise<{ [key: string]: string } | null>((resolve, reject) => {
          collectionPromiseRef.current = { resolve, reject };

          // Set timeout to avoid infinite waiting
          setTimeout(() => {
            if (collectionPromiseRef.current) {
              collectionPromiseRef.current.resolve(null);
              collectionPromiseRef.current = null;
              setWaitingForCollection(false);
            }
          }, 3000); // 3 second timeout
        });

        setWaitingForCollection(true);

        // Trigger collection
        onCollectPty();

        // Wait for collection to complete
        const debugData = await collectionPromise;

        // Use the structured data directly
        if (debugData) {
          structuredDebugContext = debugData;
          console.debug("[ChatSidebar] Successfully collected structured debug context:", structuredDebugContext);
        } else {
          console.warn("[ChatSidebar] Failed to collect debug context - timeout or no data");
        }
      } catch (e) {
        console.warn("Failed to collect context:", e);
        setWaitingForCollection(false);
        if (collectionPromiseRef.current) {
          collectionPromiseRef.current = null;
        }
      }
    }
    if(valgrind){
        // Attach last SSH output as ValgrindLog (if available)
        const lastOutput = getLastSshOutput ? getLastSshOutput() : null;
        structuredDebugContext["ValgrindLog"] = removeSuffix(lastOutput, "命令已完成。");
        console.debug("[ChatSidebar] Added valgrind log to debug context:", structuredDebugContext);
    }
    try {
      const inputs: { [key: string]: string } = structuredDebugContext || {};
      // Inject persisted analysis if available
      try {
        const persistedAnalysis = localStorage.getItem('gdbgui_analysis');
        if (persistedAnalysis && !inputs.Analysis) {
          inputs.Analysis = persistedAnalysis;
        }
      } catch (e) {
        console.debug('No persisted analysis found or failed to read');
      }
      const payload = {
        query: input,
        inputs,
        // Prefer store-provided client_id if available, else try window global set by GdbApi
        client_id: localStorage.getItem("client_id") || undefined,
      };
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(payload)
      });
      if (!res.ok || !res.body) throw new Error("API error: " + res.status);

      // Prepare a provisional AI message appended immediately after user message.
      let aiText = "";
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Insert placeholder AI message (always last during this request)
      setMessages((msgs) => [...msgs, { sender: "ai", text: "" }]);

      const flushUpdate = () => {
        setMessages((msgs) => {
          if (!msgs.length) return msgs;
          const copy = [...msgs];
          const idx = copy.length - 1; // last should be our streaming AI message
          if (copy[idx].sender === "ai") {
            copy[idx] = { ...copy[idx], text: aiText || "" };
          }
          return copy;
        });
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const rawChunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const chunk = rawChunk.replace(/\r/g, "").trim();
          if (!chunk) continue;
          // Parse SSE: allow multiple 'data:' lines (concatenate) and ignore comments
          let eventName = "message";
          const dataLines: string[] = [];
          for (const line of chunk.split(/\n/)) {
            if (!line) continue;
            if (line.startsWith(":")) continue; // comment
            if (line.startsWith("event:")) {
              eventName = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice(5));
            }
          }
          if (!dataLines.length) continue;
          const dataPayload = dataLines.join("\n").trim();
          // Only attempt JSON parse if it looks like JSON
          if (!dataPayload.startsWith("{") || !dataPayload.endsWith("}")) {
            // Non-JSON data not expected; skip
            continue;
          }
          try {
            const obj = JSON.parse(dataPayload);
            if (eventName === "message" && obj.fragment) {
              aiText += obj.fragment;
              flushUpdate();
            } else if (eventName === "done" && obj.answer) {
              aiText = obj.answer;
              flushUpdate();
            } else if (eventName === "error" && obj.error) {
              aiText += `\n[Error: ${obj.error}]`;
              flushUpdate();
            }
          } catch (e) {
            aiText += "\n[Malformed event data]";
            flushUpdate();
          }
        }
      }
    } catch (e: any) {
      setError(e?.message || "Unknown error");
      setMessages((msgs) => [...msgs, { sender: "ai", text: "Sorry, I couldn't process your request." }]);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleSend();
  }

  const containerClassName = ["h-full bg-gray-100 border-l flex flex-col", className].filter(Boolean).join(" ");

  return (
    <div className={containerClassName}>
      <div className="p-2 font-bold border-b flex items-center gap-2">
        <span>AI Chat</span>
        {/* Show a simple spinner when a request is in progress */}
        {loading && <span className="ml-auto animate-spin">🤖</span>}
      </div>
      <div className="flex-1 overflow-y-auto p-2 text-sm space-y-3">
        {messages.map((msg, i) => {
          const isUser = msg.sender === "user";
          const isLong = !isUser && /Collected Terminal Contents|Right Sidebar Contents/.test(msg.text);
          return (
            <div key={i} className={isUser ? "flex justify-end" : "flex justify-start"}>
              <div
                className={
                  "rounded-lg px-3 py-2 " +
                  (isLong
                    ? "w-full whitespace-pre-wrap bg-white text-gray-800 border"
                    : isUser
                    ? "bg-blue-500 text-white self-end max-w-xs"
                    : "bg-white text-gray-800 border self-start flex items-start gap-2 max-w-xs")
                }
              >
                {msg.sender === "ai" && !isLong && <span className="mr-2">🤖</span>}
                <div className={isLong ? "w-full prose prose-sm max-w-none markdown-body" : ""}>
                  <ReactMarkdown>{msg.text}</ReactMarkdown>
                </div>
              </div>
            </div>
          );
        })}
        {/* Dummy div to keep the scroll position anchored at the bottom */}
        <div ref={messagesEndRef} />
      </div>
      {/* Display an error banner if an error occurred */}
      {error && <div className="text-red-600 text-xs px-2 pb-1">{error}</div>}
      {/* Auto-collect and strace checkboxes */}
      <div className="px-2 py-1 border-t bg-gray-50 flex flex-row gap-1">
        <label className="flex items-center gap-2 text-xs text-gray-600">
          <input
            type="checkbox"
            checked={autoCollect}
            onChange={(e) => setAutoCollect(e.target.checked)}
            className="rounded"
          />
          GDB
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-600">
          <input
            type="checkbox"
            checked={straceChecked}
            onChange={(e) => setStraceChecked(e.target.checked)}
            className="rounded"
          />
          strace
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-600">
          <input
            type="checkbox"
            checked={valgrind}
            onChange={(e) => setVargrind(e.target.checked)}
            className="rounded"
          />
          valgrind
        </label>
      </div>
      <div className="p-2 border-t flex gap-2">
        <input
          className="w-full border rounded p-1"
          placeholder={loading ? "Waiting for response..." : "Type a message...(What's the next GDB command?)"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
        />
        <button
          className="bg-blue-500 text-white rounded px-3 py-1 disabled:opacity-50"
          onClick={handleSend}
          disabled={loading || !input.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}

// Always render the iframe, only toggle visibility
const GdbPanel = React.forwardRef<HTMLIFrameElement, { visible: boolean }>(({ visible }, ref) => (
  <div className="w-full h-full flex flex-col flex-1 min-h-0" style={{ display: visible ? "flex" : "none" }}>
    <iframe
      ref={ref}
      src="/gdb"
      title="gdbgui"
      className="w-full flex-1 min-h-0 border-0"
      style={{ minHeight: 0, height: "100%" }}
    />
  </div>
));

export default function ToolsTabs() {
  const [active, setActive] = useState("gdb");
  const gdbIframeRef = React.useRef<HTMLIFrameElement>(null);
  const sshConsoleRef = React.useRef<any>(null);
  const [gdbReady, setGdbReady] = React.useState(false);
  const [ptyMessage, setPtyMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!e.data) return;
      if (e.data.type === "gdbguiReady") {
        setGdbReady(true);
        console.debug("[ToolsTabs] gdb iframe reported ready");
      } else if (e.data.type === "ptyContents") {
        const { payload } = e.data;
        if (payload) {
          let formatted: string[] = [];

          // Handle new structure with terminals and sourceCode
          if (payload.terminals) {
            formatted.push("### Collected Terminal Contents");
            formatted.push("");
            formatted.push("#### userPty");
            formatted.push("```\n" + (payload.terminals.userPty || "(empty)") + "\n```");
            formatted.push("");
            formatted.push("#### programPty");
            formatted.push("```\n" + (payload.terminals.programPty || "(empty)") + "\n```");
            formatted.push("");
            formatted.push("#### gdbguiPty");
            formatted.push("```\n" + (payload.terminals.gdbguiPty || "(empty)") + "\n```");

            // Add source code contents if available
            if (payload.sourceCode) {
              formatted.push("");
              formatted.push("### Source Code Contents");
              formatted.push("");
              formatted.push(`**File:** ${payload.sourceCode.filename}`);
              formatted.push(`**State:** ${payload.sourceCode.sourceCodeState}`);

              if (payload.sourceCode.currentLine) {
                formatted.push(`**Current Line:** ${payload.sourceCode.currentLine}`);
              }

              if (payload.sourceCode.breakpoints && payload.sourceCode.breakpoints.length > 0) {
                formatted.push(`**Breakpoints:** ${payload.sourceCode.breakpoints.join(", ")}`);
              }

              if (payload.sourceCode.sourceLines && payload.sourceCode.sourceLines.length > 0) {
                formatted.push("");
                formatted.push("#### Source Code");
                formatted.push("```c\n" + payload.sourceCode.sourceLines.join("\n") + "\n```");
              }

              if (payload.sourceCode.assemblyLines && payload.sourceCode.assemblyLines.length > 0) {
                formatted.push("");
                formatted.push("#### Assembly");
                formatted.push("```asm\n" + payload.sourceCode.assemblyLines.join("\n") + "\n```");
              }
            }

            // Add right sidebar contents if available
            if (payload.rightSidebar) {
              formatted.push("");
              formatted.push("### Right Sidebar Contents");
              formatted.push("");

              // Current execution context
              if (payload.rightSidebar.currentThreadId !== null) {
                formatted.push(`**Current Thread:** ${payload.rightSidebar.currentThreadId}`);
              }
              if (payload.rightSidebar.selectedFrameNum !== null) {
                formatted.push(`**Selected Frame:** ${payload.rightSidebar.selectedFrameNum}`);
              }

              // Threads info
              if (payload.rightSidebar.threads && payload.rightSidebar.threads.length > 0) {
                formatted.push("");
                formatted.push("#### Threads");
                for (const thread of payload.rightSidebar.threads) {
                  formatted.push(`- Thread ${thread.id}: ${thread.state}${thread.name ? ` (${thread.name})` : ""}`);
                }
              }

              // Locals
              if (payload.rightSidebar.locals && payload.rightSidebar.locals.length > 0) {
                formatted.push("");
                formatted.push("#### Local Variables");
                for (const local of payload.rightSidebar.locals) {
                  formatted.push(`- **${local.name}** (${local.type}): ${local.value || "(no value)"}`);
                }
              }

              // Expressions
              if (payload.rightSidebar.expressions && payload.rightSidebar.expressions.length > 0) {
                formatted.push("");
                formatted.push("#### Expressions");
                for (const expr of payload.rightSidebar.expressions) {
                  formatted.push(`- **${expr.expression}** (${expr.type}): ${expr.value || "(no value)"}`);
                }
              }

              // Breakpoints
              if (payload.rightSidebar.breakpoints && payload.rightSidebar.breakpoints.length > 0) {
                formatted.push("");
                formatted.push("#### Breakpoints");
                for (const bp of payload.rightSidebar.breakpoints) {
                  const status = bp.enabled === "y" ? "enabled" : "disabled";
                  const condition = bp.condition ? ` (condition: ${bp.condition})` : "";
                  const hits = bp.timesHit ? ` [hit ${bp.timesHit} times]` : "";
                  formatted.push(`- **${bp.number}:** ${bp.fullname}:${bp.line} (${status})${condition}${hits}`);
                }
              }

              // Memory
              if (payload.rightSidebar.memory && payload.rightSidebar.memory.startAddr) {
                formatted.push("");
                formatted.push("#### Memory View");
                formatted.push(`**Address Range:** ${payload.rightSidebar.memory.startAddr} - ${payload.rightSidebar.memory.endAddr}`);
                formatted.push(`**Bytes Per Line:** ${payload.rightSidebar.memory.bytesPerLine}`);
                const cacheSize = Object.keys(payload.rightSidebar.memory.cache || {}).length;
                if (cacheSize > 0) {
                  formatted.push(`**Cached Memory Locations:** ${cacheSize}`);
                }
              }

              // Registers
              if (payload.rightSidebar.registers && payload.rightSidebar.registers.names && payload.rightSidebar.registers.names.length > 0) {
                formatted.push("");
                formatted.push("#### Registers");
                formatted.push(`**Available Registers:** ${payload.rightSidebar.registers.names.length}`);
                const currentValues = Object.keys(payload.rightSidebar.registers.currentValues || {}).length;
                if (currentValues > 0) {
                  formatted.push(`**Current Values Available:** ${currentValues}`);
                }
              }
            }
          } else {
            // Fallback for old structure
            formatted.push("### Collected Terminal Contents");
            formatted.push("");
            formatted.push("#### userPty");
            formatted.push("```\n" + (payload.userPty || "(empty)") + "\n```");
            formatted.push("");
            formatted.push("#### programPty");
            formatted.push("```\n" + (payload.programPty || "(empty)") + "\n```");
            formatted.push("");
            formatted.push("#### gdbguiPty");
            formatted.push("```\n" + (payload.gdbguiPty || "(empty)") + "\n```");
          }

          setPtyMessage(formatted.join("\n"));
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const isStrace = active === "strace";
  const isValgrind = active === "valgrind";
  const tabs = [
    { label: "GDB", id: "gdb" },
    { label: "strace", id: "strace" },
    { label: "valgrind", id: "valgrind" },
    // { label: "top", id: "top" },
    // { label: "perfetto", id: "perfetto" },
  ];

  const StracePanel = ({ visible }: { visible: boolean }) => {
    if (!visible) return null;
    return (
      <div className="flex h-full w-full min-h-0">
        <div className="flex-1 min-w-0 overflow-hidden border-r border-gray-200 bg-black">
          <SshConsole />
        </div>
      </div>
    );
  };

  const ValgrindPanel = ({ visible }: { visible: boolean }) => {
    if (!visible) return null;
    return (
      <div className="flex h-full w-full min-h-0">
        <div className="flex-1 min-w-0 overflow-hidden border-r border-gray-200 bg-black">
          <SshConsole />
        </div>
      </div>
    );
  };

  {/*
  const TopPanel = ({ visible }: { visible: boolean }) => (visible ? <div className="p-4">top tool content here</div> : null);
  */}

  const handleCollectPty = () => {
    if (!gdbReady) {
      console.warn("[ToolsTabs] gdb iframe not ready yet");
      return;
    }
    if (gdbIframeRef.current && gdbIframeRef.current.contentWindow) {
      console.debug("[ToolsTabs] sending collectPty postMessage to collect terminal and source code contents");
      gdbIframeRef.current.contentWindow.postMessage({ type: "collectPty" }, "*");
    } else {
      console.warn("[ToolsTabs] iframe window not available");
    }
  };

  const getCollectedData = async (): Promise<string | null> => {
    return ptyMessage;
  };

  // Render helper for the perfetto panel. It uses an iframe to embed the
  // external Perfetto UI.
  {/*
  const PerfettoPanel = ({ visible }: { visible: boolean }) => (
    <div className={visible ? "w-full h-full flex flex-col flex-1 min-h-0" : "hidden"}>
      <iframe
        src="https://ui.perfetto.dev"
        title="perfetto"
        className="w-full flex-1 min-h-0 border-0"
        style={{ minHeight: 0, height: "100%" }}
      />
    </div>
  );
  */}

  return (
    <SplitPane
      split="vertical"
      minSize={320}
      defaultSize={"60%"}
      style={{ height: "100vh" }}
      paneStyle={{ display: "flex", flexDirection: "column", height: "100%" }}
      pane1Style={{ minWidth: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}
      pane2Style={{ minWidth: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}
      resizerStyle={{
        background: "#e5e7eb",
        width: "8px",
        cursor: "col-resize",
        zIndex: 9999,
        pointerEvents: "auto",
      }}
      onDragStarted={() => {
        // 禁用所有 iframe 的鼠标事件
        document.querySelectorAll("iframe").forEach((el) => {
          (el as HTMLIFrameElement).style.pointerEvents = "none";
        });
      }}
      onDragFinished={() => {
        // 恢复所有 iframe 的鼠标事件
        document.querySelectorAll("iframe").forEach((el) => {
          (el as HTMLIFrameElement).style.pointerEvents = "";
        });
      }}
    >
      {/* 左侧工具区 */}
      <div className="flex flex-col h-full min-w-0">
        {/* Tabs as navbar at the top */}
        <div className="flex border-b bg-white">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`px-6 py-3 font-semibold border-b-2 transition-colors duration-150 ${
                active === tab.id ? "border-blue-500 text-blue-600 bg-gray-100" : "border-transparent text-gray-500 hover:text-blue-500"
              }`}
              onClick={() => setActive(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {/* Panel content: mount all panels but only show the active one */}
        <div className="flex-1 min-h-0 bg-gray-50 overflow-hidden relative">
          <GdbPanel ref={gdbIframeRef} visible={active === "gdb"} />
          <StracePanel visible={active === "strace"} />
          <div className={active === "valgrind" ? "flex h-full w-full min-h-0" : "hidden"}>
            <SshConsole ref={sshConsoleRef} />
          </div>
          <ValgrindPanel visible={active === "valgrind"} />
          {/*<TopPanel visible={active === "top"} />*/}
          {/*<PerfettoPanel visible={active === "perfetto"} />*/}
        </div>
      </div>
      {/* 右侧 AI Chat */}
      <ChatSidebar
        onCollectPty={handleCollectPty}
        injectedMessage={ptyMessage}
        className={isStrace ? "flex-1 min-w-0" : "min-w-0"}
        getCollectedData={getCollectedData}
        showStraceOption={isStrace}
        showValgrindOption={isValgrind}
        getLastSshOutput={() => (sshConsoleRef.current ? sshConsoleRef.current.getLastServerOutput() : null)}
      />
    </SplitPane>
  );
}
