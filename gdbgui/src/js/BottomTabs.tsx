import React from "react";
import { Terminals } from "./Terminals";
import SshConsole from "./SshConsole";

const TABS = [
  { id: "terminals", label: "调试终端" },
  { id: "ssh", label: "SSH 控制台" }
] as const;

type TabId = typeof TABS[number]["id"];

const BottomTabs: React.FC = () => {
  const [activeTab, setActiveTab] = React.useState<TabId>("terminals");

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap border-b border-gray-800 bg-gray-900 text-sm">
        {TABS.map(tab => (
          <button
            type="button"
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 font-semibold tracking-wide focus:outline-none ${
              tab.id === activeTab
                ? "bg-gray-800 text-white"
                : "text-gray-400 hover:text-white"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="relative flex-1 overflow-hidden">
        <div className={`${activeTab === "terminals" ? "flex" : "hidden"} h-full`}>
          <Terminals />
        </div>
        <div className={`${activeTab === "ssh" ? "flex" : "hidden"} h-full`}>
          <SshConsole />
        </div>
      </div>
    </div>
  );
};

export default BottomTabs;