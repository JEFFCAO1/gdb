function ChatSidebar() {
  const [messages, setMessages] = React.useState([
    { sender: "system", text: "Chat with remote API." }
  ]);
  const [input, setInput] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const messagesEndRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  async function handleSend() {
    if (!input.trim()) return;
    const userMsg = { sender: "user", text: input };
    setMessages(msgs => [...msgs, userMsg]);
    setLoading(true);
    try {
      const res = await fetch("http://172.31.150.200/v1/chat-messages", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Authorization": "Bearer app-mP555H3nbfKmJ1w5BamG93bf"
         },
        body: JSON.stringify({ 
          query: input,
          inputs: {},
          response_mode: "blocking",
          user: "gdbgui"
         })
      });
      const data = await res.json();
      setMessages(msgs => [...msgs, { sender: "system", text: data.answer || "[No reply]" }]);
    } catch (e) {
      setMessages(msgs => [...msgs, { sender: "system", text: "[API error: " + e + "]" }]);
    }
    setLoading(false);
    setInput("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleSend();
  }

  return (
    <div className="h-full w-64 bg-gray-100 border-l flex flex-col">
      <div className="p-2 font-bold border-b">Chat</div>
      <div className="flex-1 overflow-y-auto p-2 text-sm">
        {messages.map((msg, i) => (
          <div key={i} className={msg.sender === "user" ? "text-blue-700" : "text-gray-700"}>
            <span className="font-semibold">{msg.sender === "user" ? "You" : "System"}:</span> {msg.text}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <div className="p-2 border-t">
        <input
          className="w-full border rounded p-1"
          placeholder="Type a message..."
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
        />
      </div>
    </div>
  );
}
import ReactDOM from "react-dom";
import React, { useState } from "react";
import "../../static/css/tailwind.css";

const tabs = [
  { label: "GDB", id: "gdb" },
  { label: "strace", id: "strace" },
  { label: "top", id: "top" },
  { label: "perfetto", id: "perfetto" },
];

// (removed duplicate GdbPanel)
// Always render the iframe, only toggle visibility
function GdbPanel({ visible }: { visible: boolean }) {
  return (
    <div className={visible ? "w-full h-full flex flex-col flex-1 min-h-0" : "hidden"}>
      <iframe
        src="/gdb"
        title="gdbgui"
        className="w-full flex-1 min-h-0 border-0"
        style={{ minHeight: 0, height: '100%' }}
      />
    </div>
  );
}
function StracePanel({ visible }: { visible: boolean }) {
  return visible ? <div className="p-4">strace tool content here</div> : null;
}
function TopPanel({ visible }: { visible: boolean }) {
  return visible ? <div className="p-4">top tool content here</div> : null;
}
function PerfettoPanel({ visible }: { visible: boolean }) {
  return (
    <div className={visible ? "w-full h-full flex flex-col flex-1 min-h-0" : "hidden"}>
      <iframe
        src="https://ui.perfetto.dev"
        title="perfetto"
        className="w-full flex-1 min-h-0 border-0"
        style={{ minHeight: 0, height: '100%' }}
      />
    </div>
  );
}
export default function ToolsTabs() {
  const [active, setActive] = useState("gdb");
  return (
    <div className="h-screen flex flex-row">
      <div className="flex-1 flex flex-col h-screen">
        {/* Tabs as navbar at the top */}
        <div className="flex border-b bg-white">
          {tabs.map(tab => (
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
        {/* All panels are always mounted, only one is visible */}
        <div className="flex-1 min-h-0 bg-gray-50 overflow-hidden relative">
          <GdbPanel visible={active === "gdb"} />
          <StracePanel visible={active === "strace"} />
          <TopPanel visible={active === "top"} />
          <PerfettoPanel visible={active === "perfetto"} />
        </div>
      </div>
      <ChatSidebar />
    </div>
  );
}
