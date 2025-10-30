# Develop:

- python -m venv venv && source venv/bin/activate && pip install -r requirements.txt

- pip install nox

- nox -s develop

# Build

- nox -s build_executables_current_platform

# RUN

- ./build/executable/gdbgui_0.15.3.0
