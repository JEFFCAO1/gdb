import ReactDOM from "react-dom";
import React, { useState } from "react";
import "../../static/css/tailwind.css";

type GdbguiSession = {
  pid: number;
  start_time: string;
  command: string;
  client_ids: string[];
};

type AnalysisResult = {
  issueType: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  details: string;
  recommendations: string[];
  suggestedDebugCommand?: string;
  conversation_id?: string;
};

type UploadedFile = {
  name: string;
  size: number;
  type: string;
  content: string;
};
const copyIcon = (
  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinejoin="round"
      strokeWidth="2"
      d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"
    />
  </svg>
);

// @ts-expect-error ts-migrate(2339) FIXME: Property 'gdbgui_sessions' does not exist on type ... Remove this comment to see the full error message
const data: GdbguiSession[] = window.gdbgui_sessions;
// @ts-expect-error ts-migrate(2339) FIXME: Property 'csrf_token' does not exist on type 'Wind... Remove this comment to see the full error message
const csrf_token: string = window.csrf_token;
// @ts-expect-error ts-migrate(2339) FIXME: Property 'default_command' does not exist on type ... Remove this comment to see the full error message
const default_command: string = window.default_command;
function GdbguiSession(props: { session: GdbguiSession; updateData: Function }) {
  const session = props.session;
  const params = new URLSearchParams({
    gdbpid: session.pid.toString()
  }).toString();
  const url = `${window.location.origin}/tools?${params}`;
  const [shareButtonText, setShareButtonText] = useState(copyIcon);
  const [clickedKill, setClickedKill] = useState(false);
  let timeout: NodeJS.Timeout;
  return (
    <tr>
      <td className="border px-4 py-2">{session.command}</td>
      <td className="border px-4 py-2">{session.pid}</td>
      <td className="border px-4 py-2">{session.client_ids.length}</td>
      <td className="border px-4 py-2">{session.start_time}</td>
      <td className="border px-4 py-2">
        <a
          href={url}
          className="leading-7 bg-blue-500 hover:bg-blue-700 border-blue-500 hover:border-blue-700 border-4 text-white py-2 px-2 rounded"
          type="button"
        >
          Connect to Session
        </a>
        <button
          className="bg-blue-500 hover:bg-blue-700 border-blue-500 hover:border-blue-700 border-4 text-white m-1 p-2 rounded align-middle"
          title="Copy Sharable URL"
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(url);
            setShareButtonText(<span>Copied!</span>);
            if (timeout) {
              clearTimeout(timeout);
            }
            timeout = setTimeout(() => setShareButtonText(copyIcon), 3000);
          }}
        >
          {shareButtonText}
        </button>
      </td>
      <td className="border px-4 py-2">
        <button
          className="leading-7 bg-red-500 hover:bg-red-700 border-red-500 hover:border-red-700 border-4 text-white py-2 px-2 rounded"
          type="button"
          onClick={async () => {
            if (clickedKill) {
              await fetch("/kill_session", {
                method: "PUT",
                headers: {
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({ gdbpid: session.pid, csrf_token })
              });
              await props.updateData();
            } else {
              setClickedKill(true);
              setTimeout(() => {
                setClickedKill(false);
              }, 5000);
            }
          }}
        >
          {clickedKill ? "Click Again to Confirm" : "Kill Session"}
        </button>
      </td>
    </tr>
  );
}

function redirect(url: string) {
  window.open(url, "_blank");
  setTimeout(() => window.location.reload(), 500);
}
class StartCommand extends React.Component<any, { value: string }> {
  constructor(props: any) {
    super(props);
    // @ts-expect-error
    this.state = { value: window.default_command };

    this.handleChange = this.handleChange.bind(this);
    this.handleSubmit = this.handleSubmit.bind(this);
  }

  handleChange(event: any) {
    this.setState({ value: event.target.value });
  }

  handleSubmit() {
    const params = new URLSearchParams({
      gdb_command: this.state.value
    }).toString();
    redirect(`/tools?${params}`);
  }

  render() {
    return (
      <>
        <div>Enter the gdb command to run in the session.</div>
        <div className="flex w-full mx-auto items-center container">
          <input
            type="text"
            className="flex-grow leading-9 bg-gray-900 text-gray-100 font-mono focus:outline-none focus:shadow-outline border border-gray-300 py-2 px-2 block appearance-none rounded-l-lg"
            value={this.state.value}
            onChange={this.handleChange}
            onKeyUp={event => {
              if (event.key.toLowerCase() === "enter") {
                this.handleSubmit();
              }
            }}
            placeholder="gdb --flag args"
          />
          <button
            className="flex-grow-0 leading-7 bg-green-500 hover:bg-green-700 border-green-500 hover:border-green-700 border-4 text-white py-2 px-2 rounded-r-lg"
            type="button"
            onClick={this.handleSubmit}
          >
            Start New Session
          </button>
        </div>
      </>
    );
  }
}

// File Upload Component for error logs, core dumps, etc.
function FileUpload({ 
  label, 
  accept, 
  onFileUpload, 
  uploadedFile 
}: { 
  label: string; 
  accept: string; 
  onFileUpload: (file: UploadedFile) => void;
  uploadedFile?: UploadedFile;
}) {
  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const content = await file.text();
    onFileUpload({
      name: file.name,
      size: file.size,
      type: file.type,
      content
    });
  };

  return (
    <div className="mb-4">
      <label className="block text-sm font-medium text-gray-700 mb-2">
        {label}
      </label>
      <input
        type="file"
        accept={accept}
        onChange={handleFileChange}
        className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
      />
      {uploadedFile && (
        <div className="mt-2 p-2 bg-green-50 border border-green-200 rounded">
          <p className="text-sm text-green-800">
            ✓ {uploadedFile.name} ({(uploadedFile.size / 1024).toFixed(1)} KB)
          </p>
        </div>
      )}
    </div>
  );
}

// Source Code Directory Selection Component
function SourceCodeDirectory({ 
  onDirectorySelect, 
  selectedDirectory 
}: { 
  onDirectorySelect: (path: string) => void;
  selectedDirectory?: string;
}) {
  const [inputPath, setInputPath] = useState(selectedDirectory || '');

  const handleBrowse = () => {
    // For now, use input field. In a real implementation, this could open a file dialog
    const path = prompt('Enter source code directory path:', inputPath || '/path/to/source');
    if (path) {
      setInputPath(path);
      onDirectorySelect(path);
    }
  };

  return (
    <div className="mb-4">
      <label className="block text-sm font-medium text-gray-700 mb-2">
        Source Code Directory
      </label>
      <div className="flex">
        <input
          type="text"
          value={inputPath}
          onChange={(e) => setInputPath(e.target.value)}
          onBlur={() => inputPath && onDirectorySelect(inputPath)}
          placeholder="/path/to/source/code"
          className="flex-grow px-3 py-2 border border-gray-300 rounded-l-md focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={handleBrowse}
          className="px-4 py-2 bg-blue-500 text-white rounded-r-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          Browse
        </button>
      </div>
      {selectedDirectory && (
        <div className="mt-2 p-2 bg-blue-50 border border-blue-200 rounded">
          <p className="text-sm text-blue-800">Selected: {selectedDirectory}</p>
        </div>
      )}
    </div>
  );
}

// Analysis Results Display Component
function AnalysisResults({ result }: { result: AnalysisResult }) {
  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical': return 'text-red-800 bg-red-100 border-red-200';
      case 'high': return 'text-orange-800 bg-orange-100 border-orange-200';
      case 'medium': return 'text-yellow-800 bg-yellow-100 border-yellow-200';
      case 'low': return 'text-blue-800 bg-blue-100 border-blue-200';
      default: return 'text-gray-800 bg-gray-100 border-gray-200';
    }
  };

  const startDebugging = () => {
    // Persist condensed analysis summary for later chat context instead of unused conversation_id
    try {
      const analysisString = `IssueType=${result.issueType}; Severity=${result.severity}; Summary=${result.summary}\nDetails:\n${result.details}`;
      localStorage.setItem('gdbgui_analysis', analysisString);
    } catch (e) {
      console.warn('Failed to persist analysis to localStorage', e);
    }
    window.open(`/tools`, '_blank');
  };

  return (
    <div className="mt-6 p-6 bg-white border border-gray-200 rounded-lg shadow">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xl font-semibold text-gray-800">Analysis Results</h3>
        <span className={`px-3 py-1 rounded-full text-sm font-medium border ${getSeverityColor(result.severity)}`}>
          {result.severity.toUpperCase()} SEVERITY
        </span>
      </div>
      
      <div className="mb-4">
        <h4 className="font-medium text-gray-800 mb-2">Issue Type</h4>
        <p className="text-gray-700">{result.issueType}</p>
      </div>

      <div className="mb-4">
        <h4 className="font-medium text-gray-800 mb-2">Summary</h4>
        <p className="text-gray-700">{result.summary}</p>
      </div>

      <div className="mb-4">
        <h4 className="font-medium text-gray-800 mb-2">Details</h4>
        <div className="p-3 bg-gray-50 border border-gray-200 rounded">
          <pre className="text-sm text-gray-700 whitespace-pre-wrap">{result.details}</pre>
        </div>
      </div>

      <div className="mb-6">
        <h4 className="font-medium text-gray-800 mb-2">Recommendations</h4>
        <ul className="list-disc list-inside space-y-1">
          {result.recommendations.map((rec, index) => (
            <li key={index} className="text-gray-700">{rec}</li>
          ))}
        </ul>
      </div>

      {result.suggestedDebugCommand && (
        <div className="flex items-center justify-between p-4 bg-blue-50 border border-blue-200 rounded">
          <div>
            <p className="text-sm text-blue-800 font-medium">Suggested Debug Command:</p>
            <code className="text-blue-900 bg-blue-100 px-2 py-1 rounded text-sm">
              {result.suggestedDebugCommand}
            </code>
          </div>
          <button
            onClick={startDebugging}
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            Start Debugging
          </button>
        </div>
      )}
    </div>
  );
}

// Issue Analysis Tab Component
function IssueAnalysisTab() {
  const [errorLog, setErrorLog] = useState<UploadedFile>();
  const [coreFile, setCoreFile] = useState<UploadedFile>();
  const [sourceDirectory, setSourceDirectory] = useState<string>();
  const [additionalInfo, setAdditionalInfo] = useState<string>('');
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult>();
  const [analyzing, setAnalyzing] = useState(false);

  const handleAnalyze = async () => {
    if (!errorLog && !coreFile && !sourceDirectory) {
      alert('Please provide at least one input (error log, core file, or source directory)');
      return;
    }

    setAnalyzing(true);
    try {
      const payload = {
        errorLog: errorLog?.content || '',
        coreFile: coreFile?.name || '',
        sourceDirectory: sourceDirectory || '',
        additionalInfo: additionalInfo || '',
        hasErrorLog: !!errorLog,
        hasCoreFile: !!coreFile,
        hasSourceDirectory: !!sourceDirectory,
        hasAdditionalInfo: !!additionalInfo
      };

      const response = await fetch('/api/analyze_issue', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error('Analysis failed');
      }

      const result = await response.json();
      
      // Persist analysis summary for later chat sessions
      try {
        const analysisString = `IssueType=${result.issueType}; Severity=${result.severity}; Summary=${result.summary}\nDetails:\n${result.details}`;
        localStorage.setItem('gdbgui_analysis', analysisString);
      } catch (e) {
        console.warn('Failed saving analysis', e);
      }
      
      setAnalysisResult(result);
    } catch (error) {
      console.error('Analysis failed:', error);
      alert('Analysis failed. Please try again.');
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-2xl font-bold text-gray-800 mb-4">AI-Powered Issue Analysis</h2>
        <p className="text-gray-600 mb-6">
          Get intelligent insights before debugging. Upload error logs, core dumps, or specify source code directories 
          to receive AI-powered analysis with actionable recommendations and suggested debugging commands.
        </p>
        
        {/* Feature highlights */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <div className="flex items-center space-x-3 p-3 bg-blue-50 rounded-lg">
            <div className="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center">
              <span className="text-white font-bold">1</span>
            </div>
            <div>
              <h3 className="font-semibold text-blue-800">Upload Files</h3>
              <p className="text-sm text-blue-600">Error logs, core dumps</p>
            </div>
          </div>
          
          <div className="flex items-center space-x-3 p-3 bg-green-50 rounded-lg">
            <div className="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center">
              <span className="text-white font-bold">2</span>
            </div>
            <div>
              <h3 className="font-semibold text-green-800">AI Analysis</h3>
              <p className="text-sm text-green-600">Intelligent assessment</p>
            </div>
          </div>
          
          <div className="flex items-center space-x-3 p-3 bg-purple-50 rounded-lg">
            <div className="w-8 h-8 bg-purple-500 rounded-full flex items-center justify-center">
              <span className="text-white font-bold">3</span>
            </div>
            <div>
              <h3 className="font-semibold text-purple-800">Start Debugging</h3>
              <p className="text-sm text-purple-600">Targeted GDB session</p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <div>
            <FileUpload
              label="Error Log File"
              accept=".log,.txt,.out,.err"
              onFileUpload={setErrorLog}
              uploadedFile={errorLog}
            />
            
            <FileUpload
              label="Core Dump File (optional)"
              accept=".core,.dump"
              onFileUpload={setCoreFile}
              uploadedFile={coreFile}
            />
          </div>

          <div>
            <SourceCodeDirectory
              onDirectorySelect={setSourceDirectory}
              selectedDirectory={sourceDirectory}
            />
            
            <div className="mt-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Additional Information
              </label>
              <textarea
                value={additionalInfo}
                onChange={(e) => setAdditionalInfo(e.target.value)}
                placeholder="Describe the problem, steps to reproduce, expected vs actual behavior..."
                rows={4}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        </div>

        <div className="flex justify-center space-x-4">
          <button
            onClick={() => {
              // Demo functionality - simulate a segfault analysis
              setAnalysisResult({
                issueType: 'Segmentation Fault',
                severity: 'high',
                summary: 'NULL pointer dereference detected in main function',
                details: `Analysis indicates a segmentation fault caused by dereferencing a NULL pointer at line 42 in main.c.
                
Stack trace suggests the error occurs in the malloc() call where insufficient memory checking leads to accessing unallocated memory.

Common causes:
- Uninitialized pointer usage
- Buffer overflow
- Use after free
- Array bounds violation`,
                recommendations: [
                  'Use Valgrind to detect memory errors: valgrind --leak-check=full ./program',
                  'Enable AddressSanitizer: compile with -fsanitize=address',
                  'Review pointer initialization and bounds checking',
                  'Add null pointer checks before dereferencing',
                  'Use static analysis tools like Clang Static Analyzer'
                ],
                suggestedDebugCommand: 'gdb ./program -ex "run" -ex "bt" -ex "info registers"'
              });
            }}
            className="px-6 py-3 bg-blue-500 text-white rounded-lg font-medium hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            Try Demo
          </button>
          
          <button
            onClick={handleAnalyze}
            disabled={analyzing || (!errorLog && !coreFile && !sourceDirectory && !additionalInfo)}
            className={`px-8 py-3 rounded-lg font-medium ${
              analyzing || (!errorLog && !coreFile && !sourceDirectory && !additionalInfo)
                ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                : 'bg-green-500 text-white hover:bg-green-600 focus:outline-none focus:ring-2 focus:ring-green-500'
            }`}
          >
            {analyzing ? 'Analyzing...' : 'Analyze Issue'}
          </button>
        </div>

        {analysisResult && <AnalysisResults result={analysisResult} />}
      </div>
    </div>
  );
}

function Nav({ activeTab, setActiveTab }: { activeTab: string; setActiveTab: (tab: string) => void }) {
  return (
    <nav className="flex items-center justify-between flex-wrap bg-blue-500 p-6">
      <div className="flex items-center flex-shrink-0 text-white mr-6">
        <a
          href={`${window.location.origin}/dashboard`}
          className="font-semibold text-xl tracking-tight"
        >
          gdbgui
        </a>
      </div>

      <div className="w-full block flex-grow lg:flex lg:items-center lg:w-auto">
        <div className="text-sm lg:flex-grow flex">
          <button
            onClick={() => setActiveTab('analysis')}
            className={`block mt-4 lg:inline-block lg:mt-0 mr-4 px-3 py-1 rounded ${
              activeTab === 'analysis' 
                ? 'bg-blue-600 text-white' 
                : 'text-blue-200 hover:text-white'
            }`}
          >
            Issue Analysis
          </button>
          <button
            onClick={() => setActiveTab('sessions')}
            className={`block mt-4 lg:inline-block lg:mt-0 mr-4 px-3 py-1 rounded ${
              activeTab === 'sessions' 
                ? 'bg-blue-600 text-white' 
                : 'text-blue-200 hover:text-white'
            }`}
          >
            Debug Sessions
          </button>
          <a
            href="https://gdbgui.com"
            className="block mt-4 lg:inline-block lg:mt-0 text-blue-200 hover:text-white mr-4"
          >
            Docs
          </a>
          <a
            href="https://github.com/cs01/gdbgui"
            className="block mt-4 lg:inline-block lg:mt-0 text-blue-200 hover:text-white mr-4"
          >
            GitHub
          </a>
        </div>
      </div>
    </nav>
  );
}

// Debug Sessions Tab Component
function DebugSessionsTab({ sessions, updateData }: { sessions: GdbguiSession[]; updateData: () => void }) {
  const sessionElements = sessions.map((d, index) => (
    <GdbguiSession key={index} session={d} updateData={updateData} />
  ));

  return (
    <div className="flex-grow w-full h-full bg-gray-300 text-center p-5">
      <div className="text-3xl font-semibold">Start new session</div>
      <StartCommand />
      <div className="mt-5 text-3xl font-semibold">
        {sessions.length === 1
          ? "There is 1 gdbgui session running"
          : `There are ${sessions.length} gdbgui sessions running`}
      </div>
      <table className="table-auto mx-auto">
        <thead>
          <tr>
            <th className="px-4 py-2">Command</th>
            <th className="px-4 py-2">PID</th>
            <th className="px-4 py-2">Connected Browsers</th>
            <th className="px-4 py-2">Start Time</th>
            <th className="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody>{sessionElements}</tbody>
      </table>
    </div>
  );
}

class Dashboard extends React.PureComponent<any, { sessions: GdbguiSession[]; activeTab: string }> {
  interval: NodeJS.Timeout | undefined;
  constructor(props: any) {
    super(props);
    this.state = { 
      sessions: data,
      activeTab: 'analysis' // Default to issue analysis tab
    };
    this.updateData = this.updateData.bind(this);
    this.setActiveTab = this.setActiveTab.bind(this);
  }
  
  async updateData() {
    const response = await fetch("/dashboard_data");
    const sessions = await response.json();
    this.setState({ sessions });
  }
  
  setActiveTab(tab: string) {
    this.setState({ activeTab: tab });
  }
  
  componentDidMount() {
    this.interval = setInterval(this.updateData, 5000);
  }
  
  componentWillUnmount() {
    if (this.interval) {
      clearInterval(this.interval);
    }
  }
  
  render() {
    const { sessions, activeTab } = this.state;
    
    return (
      <div className="w-full h-full min-h-screen flex flex-col">
        <Nav activeTab={activeTab} setActiveTab={this.setActiveTab} />
        
        {activeTab === 'analysis' && (
          <div className="flex-grow bg-gray-100 py-8">
            <IssueAnalysisTab />
          </div>
        )}
        
        {activeTab === 'sessions' && (
          <DebugSessionsTab sessions={sessions} updateData={this.updateData} />
        )}
        
        <footer className="h-40 bold text-lg bg-black text-gray-500 text-center flex flex-col justify-center">
          <p>gdbgui</p>
          <p>The browser-based frontend to gdb with AI-powered issue analysis</p>
          <a href="https://chadsmith.dev">Copyright Chad Smith</a>
        </footer>
      </div>
    );
  }
}

ReactDOM.render(<Dashboard />, document.getElementById("dashboard"));
