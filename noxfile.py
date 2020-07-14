import nox  # type: ignore
from pathlib import Path
from sys import platform

nox.options.sessions = ["tests", "lint", "docs"]
python = ["3.6", "3.7", "3.8"]


doc_dependencies = [".", "mkdocs", "mkdocs-material"]
lint_dependencies = ["black", "flake8", "mypy", "check-manifest"]
files_to_lint = ["gdbgui", "tests"] + [str(p) for p in Path(".").glob("*.py")]


@nox.session(python=python)
def tests(session):
    session.install(".", "pytest", "pytest-cov")
    tests = session.posargs or ["tests"]
    session.run(
        "pytest", "--cov=gdbgui", "--cov-config", ".coveragerc", "--cov-report=", *tests
    )

    session.run("yarn", "install", external=True)
    session.run("yarn", "test", external=True)
    session.run("yarn", "build", external=True)

    session.notify("cover")


@nox.session
def cover(session):
    """Coverage analysis"""
    session.install("coverage")
    session.run(
        "coverage",
        "report",
        "--show-missing",
        "--omit=gdbgui/SSLify.py",
        "--fail-under=30",
    )
    session.run("coverage", "erase")


@nox.session
def lint(session):
    session.run(
        "npx",
        "prettier@1.18.2",
        "--check",
        "--config",
        ".prettierrc.js",
        "gdbgui/src/js/**/*",
        external=True,
    )
    session.install(*lint_dependencies)
    session.run("black", "--check", *files_to_lint)
    session.run("flake8", *files_to_lint)
    session.run("mypy", *files_to_lint)
    session.run(
        "check-manifest",
        "--ignore",
        "build.js,gdbgui/static/js,gdbgui/static/js/build.js.map",
    )
    session.run("python", "setup.py", "check", "--metadata", "--strict")


@nox.session
def autoformat(session):
    session.install("black")
    session.run("black", *files_to_lint)
    session.run(
        "npx",
        "prettier@1.18.2",
        "--write",
        "--config",
        ".prettierrc.js",
        "gdbgui/src/js/**/*",
        external=True,
    )


@nox.session
def docs(session):
    session.install(*doc_dependencies)
    session.run("mkdocs", "build")


@nox.session(python=python)
def develop(session):
    session.install(*doc_dependencies, *lint_dependencies)
    session.install("-e", ".")
    command = "source %s/bin/activate" % (session.virtualenv.location_name)
    session.log("Virtual Environment is ready to be used for development")
    session.log("To use, run: '%s'", command)


@nox.session
def build(session):
    session.install("setuptools", "wheel", "twine")
    session.run("rm", "-rf", "dist", external=True)
    session.run("yarn", "build", external=True)
    session.run("python", "setup.py", "--quiet", "sdist", "bdist_wheel")
    session.run("twine", "check", "dist/*")


@nox.session
def publish(session):
    build(session)
    print("REMINDER: Has the changelog been updated?")
    session.run("python", "-m", "twine", "upload", "dist/*")
    publish_docs(session)


@nox.session
def watch_docs(session):
    session.install(*doc_dependencies)
    session.run("mkdocs", "serve")


@nox.session
def publish_docs(session):
    session.install(*doc_dependencies)
    session.run("mkdocs", "gh-deploy")


@nox.session()
def build_executable_current_platform(session):
    session.run("yarn", "install", external=True)
    session.run("yarn", "build", external=True)
    session.install(".", "PyInstaller<3.7")
    session.run("python", "make_executable.py")


@nox.session()
def build_executable_mac(session):
    if not platform.startswith("darwin"):
        raise Exception(f"Unexpected platform {platform}")
    session.notify("build_executable_current_platform")


@nox.session()
def build_executable_linux(session):
    if not platform.startswith("linux"):
        raise Exception(f"Unexpected platform {platform}")
    session.notify("build_executable_current_platform")


@nox.session()
def build_executable_windows(session):
    if not platform.startswith("win32"):
        raise Exception(f"Unexpected platform {platform}")
    session.notify("build_executable_current_platform")
