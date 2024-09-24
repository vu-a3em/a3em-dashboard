ifeq ($(OS),Windows_NT)
	BREW_CMD :=
	PYTHON_CMD := python -m pip install .
	UNINSTALL_CMD := python -m pip uninstall -y a3em
else
	UNAME_S := $(shell uname -s)
	ifeq ($(UNAME_S),Linux)
		BREW_CMD :=
		PYTHON_CMD := python3 -m pip install .
		UNINSTALL_CMD := python3 -m pip uninstall -y a3em
	else
		BREW_CMD := brew install python-tk
		PYTHON_CMD := python3 -m pip install --break-system-packages .
		UNINSTALL_CMD := python3 -m pip uninstall -y --break-system-packages a3em
	endif
endif


all:
	$(BREW_CMD)
	$(PYTHON_CMD)
	rm -rf build dist a3em* *.egg-info

clean:
	rm -rf build dist a3em* *.egg-info

uninstall:
	$(UNINSTALL_CMD)
