python -m venv venv && source venv/bin/activate && pip install -r requirements.txt
pip install nox
nox -s develop
