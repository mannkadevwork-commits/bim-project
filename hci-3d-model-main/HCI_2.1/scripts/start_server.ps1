# Portable HCI_2.1 launcher.
# Optional overrides: $env:HCI21_PYTHON, $env:HCI21_MODEL_PATH, $env:HCI21_HOST, $env:HCI21_PORT.
$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$WebDir = (Resolve-Path (Join-Path $PSScriptRoot "..\web")).Path
if (-not $env:HCI21_HOST) { $env:HCI21_HOST = "127.0.0.1" }
if (-not $env:HCI21_PORT) { $env:HCI21_PORT = "8000" }
if (-not $env:HCI21_MODEL_PATH) {
    $BundledModel = Join-Path $ProjectRoot "best_hci21.pt"
    if (Test-Path $BundledModel) { $env:HCI21_MODEL_PATH = $BundledModel }
}
Set-Location $WebDir

$Python = $env:HCI21_PYTHON
if (-not $Python -and $env:CONDA_PREFIX) {
    $Candidate = Join-Path $env:CONDA_PREFIX "python.exe"
    if (Test-Path $Candidate) { $Python = $Candidate }
}

if ($Python) {
    & $Python -c "import torch; print('torch:', torch.__version__)"
    if ($LASTEXITCODE -ne 0) { throw "PyTorch check failed in the selected Python." }
    & $Python -c "import ultralytics; print('ultralytics:', ultralytics.__version__)"
    if ($LASTEXITCODE -ne 0) { throw "Ultralytics check failed in the selected Python." }
    Write-Host "[HCI_2.1] Model: $env:HCI21_MODEL_PATH"
    & $Python -m uvicorn server:app --host $env:HCI21_HOST --port $env:HCI21_PORT
    exit $LASTEXITCODE
}

if (Get-Command conda -ErrorAction SilentlyContinue) {
    conda run --no-capture-output -n improved_model_train python -c "import torch; print('torch:', torch.__version__)"
    if ($LASTEXITCODE -ne 0) { throw "PyTorch check failed in improved_model_train." }
    conda run --no-capture-output -n improved_model_train python -c "import ultralytics; print('ultralytics:', ultralytics.__version__)"
    if ($LASTEXITCODE -ne 0) { throw "Ultralytics check failed in improved_model_train." }
    Write-Host "[HCI_2.1] Model: $env:HCI21_MODEL_PATH"
    conda run --no-capture-output -n improved_model_train python -m uvicorn server:app --host $env:HCI21_HOST --port $env:HCI21_PORT
    exit $LASTEXITCODE
}

throw "Set HCI21_PYTHON, activate a conda environment, or install Conda with an 'improved_model_train' environment."
