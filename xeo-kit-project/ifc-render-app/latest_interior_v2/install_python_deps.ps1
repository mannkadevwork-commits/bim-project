$ErrorActionPreference = "Stop"

# Run this script from the ifc-render-app directory.
$ProjectRoot = (Get-Location).Path
$PythonVenv = Join-Path $ProjectRoot "latest_interior_v2\.venv\Scripts\python.exe"
$Requirements = Join-Path $PSScriptRoot "requirements-gemini.txt"

if (-not (Test-Path $Requirements)) {
    throw "requirements-gemini.txt was not found beside this script."
}

if (-not (Test-Path $PythonVenv)) {
    Write-Host "Creating project virtual environment..."
    py -3.12 -m venv (Join-Path $ProjectRoot "latest_interior_v2\.venv")
}

Write-Host "Upgrading pip in the backend virtual environment..."
& $PythonVenv -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed." }

Write-Host "Installing Python dependencies..."
& $PythonVenv -m pip install -r $Requirements
if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }

Write-Host "Verifying imports and package versions..."
& $PythonVenv -c "import sys, ifcopenshell, pydantic; from google import genai; from google.genai import types; from google.genai.errors import APIError, ClientError, ServerError; print('Python:', sys.executable); print('ifcopenshell:', ifcopenshell.version); print('pydantic:', pydantic.__version__); print('google-genai: import OK')"
if ($LASTEXITCODE -ne 0) { throw "Python dependency verification failed." }

Write-Host ""
Write-Host "SUCCESS: dependencies are installed in:"
Write-Host $PythonVenv
Write-Host "Ensure Node.js launches this exact interpreter."
