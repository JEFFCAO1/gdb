import requests
import werkzeug
import json
import logging
import os

from flask import (
    Blueprint,
    current_app,
    jsonify,
    redirect,
    render_template,
    request,
    session,
    Response,
)
from pygments.lexers import get_lexer_for_filename  # type: ignore

from gdbgui import htmllistformatter, __version__

from .constants import TEMPLATE_DIR, USING_WINDOWS, SIGNAL_NAME_TO_OBJ
from .http_util import (
    add_csrf_token_to_session,
    authenticate,
    client_error,
    csrf_protect,
)

logger = logging.getLogger(__file__)
blueprint = Blueprint("http_routes", __name__, template_folder=str(TEMPLATE_DIR))

# strace 工具页面
@blueprint.route("/strace", methods=["GET"])
@authenticate
def strace_page():
    add_csrf_token_to_session()
    return render_template("strace.html")

# top 工具页面
@blueprint.route("/top", methods=["GET"])
@authenticate
def top_page():
    add_csrf_token_to_session()
    return render_template("top.html")

# top 工具页面
@blueprint.route("/perfetto", methods=["GET"])
@authenticate
def perfetto_page():
    add_csrf_token_to_session()
    return render_template("top.html")

# top 工具文件上传
@blueprint.route("/top/upload", methods=["POST"])
@authenticate
def top_upload():
    if 'file' not in request.files:
        return "未选择文件", 400
    file = request.files['file']
    if file.filename == '':
        return "未选择文件", 400
    # 可自定义保存路径
    save_path = os.path.join(current_app.config.get("UPLOAD_FOLDER", "/tmp"), werkzeug.utils.secure_filename(file.filename))
    file.save(save_path)
    return f"文件已上传到: {save_path}", 200

# AI Chatbox backend
@blueprint.route("/api/chat", methods=["POST"])
def chatbox_api():
    data = request.get_json(force=True)
    # Accepts: { 
    #   query: str,  # actual user input
    #   inputs: {     # structured debug context
    #     CurCode?: str,
    #     ProcessInfo?: str, 
    #     ProgramOutput?: str,
    #     GDBOutput?: str,
    #     GDBLog?: str,
    #     CurAssembly?: str
    #   }
    # }
    user_query = data.get("query")
    debug_inputs = data.get("inputs", {})
    
    user = "Dev"  # or get from session/user context
    api_url = "http://172.31.150.200/v1/chat-messages"
    api_key = "app-mP555H3nbfKmJ1w5BamG93bf"
    
    if not user_query:
        return jsonify({"reply": "No query provided."}), 400
    
    query = user_query
    
    # Build structured inputs with debug context
    inputs = {}
    
    # Add structured debug context fields
    if debug_inputs.get("CurCode"):
        inputs["CurCode"] = debug_inputs["CurCode"]
    
    if debug_inputs.get("ProcessInfo"):
        inputs["ProcessInfo"] = debug_inputs["ProcessInfo"]
        
    if debug_inputs.get("ProgramOutput"):
        inputs["ProgramOutput"] = debug_inputs["ProgramOutput"]

    if debug_inputs.get("GDBOutput"):
        inputs["GDBOutput"] = debug_inputs["GDBOutput"]

    if debug_inputs.get("GDBLog"):
        inputs["GDBLog"] = debug_inputs["GDBLog"]
    
    payload = {
        "inputs": inputs,
        "query": query,
        "response_mode": "blocking",
        "user": user
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "gdbgui/ai-chatbox"
    }
    try:
        response = requests.post(api_url, headers=headers, json=payload, timeout=30)
        response.raise_for_status()
        data = response.json()
        return jsonify({"reply": data.get("answer", "No response from API")})
    except requests.exceptions.RequestException as e:
        logger.error(f"Chat API error: {e}")
        return jsonify({"reply": f"Chat service error: {str(e)}"}), 500
    except Exception as e:
        logger.error(f"Chat error: {e}")
        return jsonify({"reply": f"Internal error: {str(e)}"}), 500

# Issue Analysis API
@blueprint.route("/api/analyze_issue", methods=["POST"])
def analyze_issue_api():
    """Analyze uploaded error logs, core files, and source code to provide preliminary issue assessment"""
    data = request.get_json(force=True)
    
    error_log = data.get("errorLog", "")
    core_file = data.get("coreFile", "")
    source_directory = data.get("sourceDirectory", "")
    has_error_log = data.get("hasErrorLog", False)
    has_core_file = data.get("hasCoreFile", False)
    has_source_directory = data.get("hasSourceDirectory", False)
    
    # Build analysis prompt for AI
    analysis_prompt = "Analyze the following debugging information and provide a structured assessment:\n\n"
    
    if has_error_log and error_log:
        analysis_prompt += f"ERROR LOG:\n{error_log}\n\n"
    
    if has_core_file and core_file:
        analysis_prompt += f"CORE DUMP FILE: {core_file}\n\n"
        
    if has_source_directory and source_directory:
        analysis_prompt += f"SOURCE CODE DIRECTORY: {source_directory}\n\n"
    
    analysis_prompt += """Please analyze this information and provide:
1. Issue Type: What kind of problem this appears to be (segmentation fault, memory leak, logic error, etc.)
2. Severity: Rate as low/medium/high/critical
3. Summary: Brief description of the issue
4. Details: Technical analysis of the problem
5. Recommendations: List of specific debugging steps or fixes
6. Suggested GDB Command: A specific gdb command to start debugging this issue

Format your response as a JSON object with these fields: issueType, severity, summary, details, recommendations (array), suggestedGdbCommand"""

    # Call AI API for analysis
    api_url = "http://172.31.150.200/v1/chat-messages"
    api_key = "app-mP555H3nbfKmJ1w5BamG93bf"
    
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "inputs": {},
        "query": analysis_prompt,
        "response_mode": "blocking",
        "conversation_id": "",
        "user": "IssueAnalyzer"
    }
    
    try:
        response = requests.post(api_url, headers=headers, json=payload, timeout=60)
        response.raise_for_status()
        ai_response = response.json()
        ai_answer = ai_response.get("answer", "")
        
        # Try to parse JSON response from AI
        try:
            # Look for JSON in the AI response
            import re
            json_match = re.search(r'\{.*\}', ai_answer, re.DOTALL)
            if json_match:
                analysis_result = json.loads(json_match.group())
            else:
                # Fallback: create structured response from AI text
                analysis_result = {
                    "issueType": "Unknown Issue",
                    "severity": "medium",
                    "summary": "AI analysis completed",
                    "details": ai_answer,
                    "recommendations": ["Review the AI analysis for detailed insights", "Start debugging with suggested GDB command"],
                    "suggestedGdbCommand": "gdb ./your_program"
                }
        except json.JSONDecodeError:
            # If AI doesn't return valid JSON, create a fallback response
            analysis_result = {
                "issueType": "Analysis Completed", 
                "severity": "medium",
                "summary": "AI provided detailed analysis of your issue",
                "details": ai_answer,
                "recommendations": [
                    "Review the detailed analysis provided",
                    "Follow the AI's debugging suggestions",
                    "Use the suggested GDB command to start debugging"
                ],
                "suggestedGdbCommand": "gdb ./your_program"
            }
            
        # Ensure all required fields exist with defaults
        analysis_result.setdefault("issueType", "Unknown Issue")
        analysis_result.setdefault("severity", "medium") 
        analysis_result.setdefault("summary", "Issue analysis completed")
        analysis_result.setdefault("details", "See AI analysis for details")
        analysis_result.setdefault("recommendations", ["Start debugging with GDB"])
        analysis_result.setdefault("suggestedGdbCommand", "gdb ./your_program")
        
        return jsonify(analysis_result)
        
    except requests.exceptions.RequestException as e:
        logger.error(f"Issue analysis API error: {e}")
        return jsonify({
            "issueType": "Analysis Error",
            "severity": "medium", 
            "summary": "Unable to analyze issue at this time",
            "details": f"Analysis service error: {str(e)}",
            "recommendations": ["Try again later", "Proceed with manual debugging"],
            "suggestedGdbCommand": "gdb ./your_program"
        }), 500
    except Exception as e:
        logger.error(f"Issue analysis error: {e}")
        return jsonify({
            "issueType": "Analysis Error",
            "severity": "medium",
            "summary": "Internal analysis error", 
            "details": f"Internal error: {str(e)}",
            "recommendations": ["Contact support", "Proceed with manual debugging"],
            "suggestedGdbCommand": "gdb ./your_program"
        }), 500

@blueprint.route("/api/GDBAssist", methods=["POST"])
def gdb_assist():
    return jsonify({"reply": {}})

@blueprint.route("/read_file", methods=["GET"])
@csrf_protect
def read_file():
    """Read a file and return its contents as an array"""

    def should_highlight():
        try:
            return json.loads(request.args.get("highlight", "true"))
        except Exception as e:
            if current_app.debug:
                print("Raising exception since debug is on")
                raise e

            else:
                return True  # highlight argument was invalid for some reason, default to true

    path = request.args.get("path")
    start_line = int(request.args.get("start_line"))
    start_line = max(1, start_line)  # make sure it's not negative
    end_line = int(request.args.get("end_line"))

    if path and os.path.isfile(path):
        try:
            last_modified = os.path.getmtime(path)
            with open(path, "r") as f:
                raw_source_code_list = f.read().split("\n")
                num_lines_in_file = len(raw_source_code_list)
                end_line = min(
                    num_lines_in_file, end_line
                )  # make sure we don't try to go too far

                # if leading lines are '', then the lexer will strip them out, but we want
                # to preserve blank lines. Insert a space whenever we find a blank line.
                for i in range((start_line - 1), (end_line)):
                    if raw_source_code_list[i] == "":
                        raw_source_code_list[i] = " "
                raw_source_code_lines_of_interest = raw_source_code_list[
                    (start_line - 1) : (end_line)
                ]
            try:
                lexer = get_lexer_for_filename(path)
            except Exception:
                lexer = None

            if lexer and should_highlight():
                highlighted = True
                # convert string into tokens
                tokens = lexer.get_tokens("\n".join(raw_source_code_lines_of_interest))
                # format tokens into nice, marked up list of html
                formatter = (
                    htmllistformatter.HtmlListFormatter()
                )  # Don't add newlines after each line
                source_code = formatter.get_marked_up_list(tokens)
            else:
                highlighted = False
                source_code = raw_source_code_lines_of_interest

            return jsonify(
                {
                    "source_code_array": source_code,
                    "path": path,
                    "last_modified_unix_sec": last_modified,
                    "highlighted": highlighted,
                    "start_line": start_line,
                    "end_line": end_line,
                    "num_lines_in_file": num_lines_in_file,
                }
            )

        except Exception as e:
            return client_error({"message": "%s" % e})

    else:
        return client_error({"message": "File not found: %s" % path})


@blueprint.route("/get_last_modified_unix_sec", methods=["GET"])
@csrf_protect
def get_last_modified_unix_sec():
    """Get last modified unix time for a given file"""
    path = request.args.get("path")
    if path and os.path.isfile(path):
        try:
            last_modified = os.path.getmtime(path)
            return jsonify({"path": path, "last_modified_unix_sec": last_modified})

        except Exception as e:
            return client_error({"message": "%s" % e, "path": path})

    else:
        return client_error({"message": "File not found: %s" % path, "path": path})


@blueprint.route("/help")
def help_route():
    return redirect("https://github.com/cs01/gdbgui/blob/master/HELP.md")

@blueprint.route("/", methods=["GET"])
@authenticate
def tools():
    add_csrf_token_to_session()
    return render_template("toolstabs.html")


@blueprint.route("/gdb", methods=["GET"])
@authenticate
def gdbgui():
    gdbpid = request.args.get("gdbpid", 0)
    gdb_command = request.args.get("gdb_command", current_app.config["gdb_command"])
    add_csrf_token_to_session()

    THEMES = ["monokai", "light"]
    initial_data = {
        "csrf_token": session["csrf_token"],
        "gdbgui_version": __version__,
        "gdbpid": gdbpid,
        "gdb_command": gdb_command,
        "initial_binary_and_args": current_app.config["initial_binary_and_args"],
        "project_home": current_app.config["project_home"],
        "remap_sources": current_app.config["remap_sources"],
        "themes": THEMES,
        "signals": SIGNAL_NAME_TO_OBJ,
        "using_windows": USING_WINDOWS,
    }

    return render_template(
        "gdbgui.html",
        version=__version__,
        debug=current_app.debug,
        initial_data=initial_data,
        themes=THEMES,
    )


@blueprint.route("/dashboard", methods=["GET"])
@authenticate
def dashboard():
    """Dashboard page for issue analysis and session management"""
    add_csrf_token_to_session()
    
    manager = current_app.config.get("_manager")
    sessions = manager.get_dashboard_data() if manager else []
    
    # Get default GDB command from config
    default_command = current_app.config.get("gdb_command", "gdb")
    
    return render_template(
        "dashboard.html",
        version=__version__,
        debug=current_app.debug,
        gdbgui_sessions=sessions,
        csrf_token=session.get("csrf_token"),
        default_command=default_command
    )


@blueprint.route("/dashboard_data", methods=["GET"])
@authenticate
def dashboard_data():
    manager = current_app.config.get("_manager")

    return jsonify(manager.get_dashboard_data())


@blueprint.route("/kill_session", methods=["PUT"])
@authenticate
def kill_session():
    from .app import manager

    pid = request.json.get("gdbpid")
    if pid:
        manager.remove_debug_session_by_pid(pid)
        return jsonify({"success": True})
    else:
        return Response(
            "Missing required parameter: gdbpid",
            401,
        )


@blueprint.route("/send_signal_to_pid", methods=["POST"])
def send_signal_to_pid():
    signal_name = request.form.get("signal_name", "").upper()
    pid_str = str(request.form.get("pid"))
    try:
        pid_int = int(pid_str)
    except ValueError:
        return (
            jsonify(
                {
                    "message": "The pid %s cannot be converted to an integer. Signal %s was not sent."
                    % (pid_str, signal_name)
                }
            ),
            400,
        )

    if signal_name not in SIGNAL_NAME_TO_OBJ:
        raise ValueError("no such signal %s" % signal_name)
    signal_value = int(SIGNAL_NAME_TO_OBJ[signal_name])

    try:
        os.kill(pid_int, signal_value)
    except Exception:
        return (
            jsonify(
                {
                    "message": "Process could not be killed. Is %s an active PID?"
                    % pid_int
                }
            ),
            400,
        )
    return jsonify(
        {
            "message": "sent signal %s (%s) to process id %s"
            % (signal_name, signal_value, pid_str)
        }
    )
