import React from "react";
import GdbApi from "./GdbApi";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { store } from "statorgfc";
import "xterm/css/xterm.css";
import constants from "./constants";
import Actions from "./Actions";

function customKeyEventHandler(config: {
  pty_name: string;
  pty: Terminal;
  canPaste: boolean;
  pidStoreKey: string;
}) {
  return async (e: KeyboardEvent): Promise<boolean> => {
    if (!(e.type === "keydown")) {
      return true;
    }
    if (e.shiftKey && e.ctrlKey) {
      const key = e.key.toLowerCase();
      if (key === "c") {
        const toCopy = config.pty.getSelection();
        navigator.clipboard.writeText(toCopy);
        config.pty.focus();
        return false;
      } else if (key === "v") {
        if (!config.canPaste) {
          return false;
        }
        const toPaste = await navigator.clipboard.readText();

        GdbApi.getSocket().emit("pty_interaction", {
          data: { pty_name: config.pty_name, key: toPaste, action: "write" }
        });
        return false;
      }
    }
    return true;
  };
}
export class Terminals extends React.Component {
  userPtyRef: React.RefObject<any>;
  programPtyRef: React.RefObject<any>;
  gdbguiPtyRef: React.RefObject<any>;
  userPty: Terminal | null = null;
  programPty: Terminal | null = null;
  gdbguiPty: Terminal | null = null;
  constructor(props: any) {
    super(props);
    this.userPtyRef = React.createRef();
    this.programPtyRef = React.createRef();
    this.gdbguiPtyRef = React.createRef();
    this.terminal = this.terminal.bind(this);
  }

  terminal(ref: React.RefObject<any>) {
    let className = " bg-black p-0 m-0 h-full align-baseline ";
    return (
      <div className={className}>
        <div className="absolute h-full w-1/3 align-baseline  " ref={ref}></div>
      </div>
    );
  }
  render() {
    let terminalsClass = "w-full h-full relative grid grid-cols-3 ";
    return (
      <div className={terminalsClass}>
        {this.terminal(this.userPtyRef)}
        {/* <GdbGuiTerminal /> */}
        {this.terminal(this.gdbguiPtyRef)}
        {this.terminal(this.programPtyRef)}
      </div>
    );
  }

  collectAllPtyContents() {
    const grab = (pty: Terminal | null): string => {
      if (!pty || !pty.buffer || !pty.buffer.active) return "";
      const lines: string[] = [];
      for (let i = 0; i < pty.buffer.active.length; i++) {
        lines.push(pty.buffer.active.getLine(i)?.translateToString() ?? "");
      }
      // Trim trailing blank lines for cleanliness
      while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
      return lines.join("\n");
    };

    // Collect terminal contents as structured data
    const terminalContents = {
      gdbOutput: grab(this.userPty),
      programOutput: grab(this.programPty),
      gdbLog: grab(this.gdbguiPty)
    };

    // Collect source code contents if available
    let sourceCodeData = null;
    try {
      if ((window as any).collectSourceCodeContents) {
        sourceCodeData = (window as any).collectSourceCodeContents();
      }
    } catch (e) {
      console.warn("[Terminals] Could not collect source code contents:", e);
    }

    // Collect right sidebar contents if available
    let rightSidebarData = null;
    try {
      if ((window as any).collectRightSidebarContents) {
        rightSidebarData = (window as any).collectRightSidebarContents();
      }
    } catch (e) {
      console.warn("[Terminals] Could not collect right sidebar contents:", e);
    }

    // Structure the debug context according to predefined format
    const structuredDebugContext = {
      CurCode: "",
      ProcessInfo: "",
      ProgramOutput: terminalContents.programOutput || "",
      GDBOutput: terminalContents.gdbOutput || "",
      GDBLog: terminalContents.gdbLog || ""
    };

    // Add source code if available
    if (sourceCodeData && sourceCodeData.sourceLines) {
      structuredDebugContext.CurCode = sourceCodeData.sourceLines.join('\n');
    }

    // Add process info from sidebar data
    if (rightSidebarData) {
      const processInfoParts = [];
      
      if (rightSidebarData.currentThreadId !== null) {
        processInfoParts.push(`Current Thread: ${rightSidebarData.currentThreadId}`);
      }
      
      if (rightSidebarData.selectedFrameNum !== null) {
        processInfoParts.push(`Selected Frame: ${rightSidebarData.selectedFrameNum}`);
      }

      if (rightSidebarData.locals && rightSidebarData.locals.length > 0) {
        processInfoParts.push("Local Variables:");
        rightSidebarData.locals.forEach((local: any) => {
          processInfoParts.push(`  ${local.name}: ${local.value} (${local.type})`);
        });
      }

      if (rightSidebarData.expressions && rightSidebarData.expressions.length > 0) {
        processInfoParts.push("Expressions:");
        rightSidebarData.expressions.forEach((expr: any) => {
          processInfoParts.push(`  ${expr.expression}: ${expr.value}`);
        });
      }

      if (rightSidebarData.breakpoints && rightSidebarData.breakpoints.length > 0) {
        processInfoParts.push("Breakpoints:");
        rightSidebarData.breakpoints.forEach((bp: any) => {
          processInfoParts.push(`  ${bp.fullname}:${bp.line} (${bp.enabled ? 'enabled' : 'disabled'})`);
        });
      }

      structuredDebugContext.ProcessInfo = processInfoParts.join('\n');
    }

    // Console log (debug)
    console.log("[Terminals] Collected structured debug context", structuredDebugContext);

    // Send structured data to parent (chat box) if embedded in iframe
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ 
          type: "structuredDebugContext", 
          payload: structuredDebugContext 
        }, "*");
      }
    } catch (e) {
      // ignore cross-origin issues
    }

    return structuredDebugContext;
  }

  componentDidMount() {
    const fitAddon = new FitAddon();
    const programFitAddon = new FitAddon();
    const gdbguiFitAddon = new FitAddon();

    const userPty = new Terminal({
      cursorBlink: true,
      macOptionIsMeta: true,
      scrollback: 9999
    });
    this.userPty = userPty;
    userPty.loadAddon(fitAddon);
    userPty.open(this.userPtyRef.current);
    userPty.writeln(`running command: ${store.get("gdb_command")}`);
    userPty.writeln("");
    userPty.attachCustomKeyEventHandler(
      // @ts-expect-error
      customKeyEventHandler({
        pty_name: "user_pty",
        pty: userPty,
        canPaste: true,
        pidStoreKey: "gdb_pid"
      })
    );
    GdbApi.getSocket().on("user_pty_response", function(data: string) {
      userPty.write(data);
    });
    userPty.onKey((data, ev) => {
      GdbApi.getSocket().emit("pty_interaction", {
        data: { pty_name: "user_pty", key: data.key, action: "write" }
      });
      if (data.domEvent.code === "Enter") {
        Actions.onConsoleCommandRun();
      }
    });

    const programPty = new Terminal({
      cursorBlink: true,
      macOptionIsMeta: true,
      scrollback: 9999
    });
    this.programPty = programPty;
    programPty.loadAddon(programFitAddon);
    programPty.open(this.programPtyRef.current);
    programPty.attachCustomKeyEventHandler(
      // @ts-expect-error
      customKeyEventHandler({
        pty_name: "program_pty",
        pty: programPty,
        canPaste: true,
        pidStoreKey: "inferior_pid"
      })
    );
    programPty.write(constants.xtermColors.grey);
    programPty.write(
      "Program output -- Programs being debugged are connected to this terminal. " +
        "You can read output and send input to the program from here."
    );
    programPty.writeln(constants.xtermColors.reset);
    GdbApi.getSocket().on("program_pty_response", function(pty_response: string) {
      programPty.write(pty_response);
    });
    programPty.onKey((data, ev) => {
      GdbApi.getSocket().emit("pty_interaction", {
        data: { pty_name: "program_pty", key: data.key, action: "write" }
      });
    });

    const gdbguiPty = new Terminal({
      cursorBlink: false,
      macOptionIsMeta: true,
      scrollback: 9999,
      disableStdin: true
      // theme: { background: "#888" }
    });
    this.gdbguiPty = gdbguiPty;
    gdbguiPty.write(constants.xtermColors.grey);
    gdbguiPty.writeln("gdbgui output (read-only)");
    gdbguiPty.writeln(
      "Copy/Paste available in all terminals with ctrl+shift+c, ctrl+shift+v"
    );
    gdbguiPty.write(constants.xtermColors.reset);

    gdbguiPty.attachCustomKeyEventHandler(
      // @ts-expect-error
      customKeyEventHandler({ pty_name: "unused", pty: gdbguiPty, canPaste: false })
    );

    gdbguiPty.loadAddon(gdbguiFitAddon);
    gdbguiPty.open(this.gdbguiPtyRef.current);
    // gdbguiPty is written to elsewhere
    store.set("gdbguiPty", gdbguiPty);

    const interval = setInterval(() => {
      fitAddon.fit();
      programFitAddon.fit();
      gdbguiFitAddon.fit();
      const socket = GdbApi.getSocket();

      if (socket.disconnected) {
        return;
      }
      socket.emit("pty_interaction", {
        data: {
          pty_name: "user_pty",
          rows: userPty.rows,
          cols: userPty.cols,
          action: "set_winsize"
        }
      });

      socket.emit("pty_interaction", {
        data: {
          pty_name: "program_pty",
          rows: programPty.rows,
          cols: programPty.cols,
          action: "set_winsize"
        }
      });
    }, 2000);

    setTimeout(() => {
      fitAddon.fit();
      programFitAddon.fit();
      gdbguiFitAddon.fit();
    }, 0);

    // Expose the collect function globally for external access
    (window as any).collectPtyContents = this.collectAllPtyContents.bind(this);

    // Listen for messages from parent window
    window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'collectPty') {
        this.collectAllPtyContents();
      }
    });
    // Notify parent frame we're ready
    try {
      window.parent && window.parent !== window && window.parent.postMessage({ type: 'gdbguiReady' }, '*');
    } catch (e) {
      // ignore
    }
  }
}
