@echo off
REM Portable HCI_2.1 launcher. Optional overrides: HCI21_PYTHON, HCI21_MODEL_PATH, HCI21_HOST, HCI21_PORT.
setlocal
set "PROJECT_ROOT=%~dp0..\.."
set "WEB_DIR=%~dp0..\web"
if not defined HCI21_HOST set "HCI21_HOST=127.0.0.1"
if not defined HCI21_PORT set "HCI21_PORT=8000"
if not defined HCI21_MODEL_PATH if exist "%PROJECT_ROOT%\best_hci21.pt" set "HCI21_MODEL_PATH=%PROJECT_ROOT%\best_hci21.pt"
cd /d "%WEB_DIR%" || exit /b 1

if defined HCI21_PYTHON goto use_python
if defined CONDA_PREFIX if exist "%CONDA_PREFIX%\python.exe" set "HCI21_PYTHON=%CONDA_PREFIX%\python.exe"
if defined HCI21_PYTHON goto use_python
where conda >nul 2>&1
if not errorlevel 1 goto use_conda

echo ERROR: Python was not selected and conda was not found.
echo Set HCI21_PYTHON to a working Python executable, or install/initialize Conda.
echo For a non-conda environment, set HCI21_ALLOW_ANY_PYTHON=1 only after testing PyTorch.
exit /b 1

:use_python
echo [HCI_2.1] Python: %HCI21_PYTHON%
"%HCI21_PYTHON%" -c "import torch; print('torch:', torch.__version__)" || exit /b 1
"%HCI21_PYTHON%" -c "import ultralytics; print('ultralytics:', ultralytics.__version__)" || exit /b 1
echo [HCI_2.1] Model: %HCI21_MODEL_PATH%
echo [HCI_2.1] Starting on http://%HCI21_HOST%:%HCI21_PORT%
"%HCI21_PYTHON%" -m uvicorn server:app --host "%HCI21_HOST%" --port "%HCI21_PORT%"
exit /b %errorlevel%

:use_conda
echo [HCI_2.1] Using Conda environment improved_model_train
call conda run --no-capture-output -n improved_model_train python -c "import torch; print('torch:', torch.__version__)" || exit /b 1
call conda run --no-capture-output -n improved_model_train python -c "import ultralytics; print('ultralytics:', ultralytics.__version__)" || exit /b 1
echo [HCI_2.1] Model: %HCI21_MODEL_PATH%
echo [HCI_2.1] Starting on http://%HCI21_HOST%:%HCI21_PORT%
call conda run --no-capture-output -n improved_model_train python -m uvicorn server:app --host "%HCI21_HOST%" --port "%HCI21_PORT%"
exit /b %errorlevel%
