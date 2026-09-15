param(
  [switch]$Execute,
  [int]$RetentionDays = 30,
  [int]$OrphanRetentionDays = 7
)

$ErrorActionPreference = 'Stop'
$backend = Split-Path -Parent $PSScriptRoot
Push-Location $backend
try {
  $env:HCI_JOB_RETENTION_DAYS = $RetentionDays
  $env:HCI_ORPHAN_JOB_RETENTION_DAYS = $OrphanRetentionDays
  if ($Execute) {
    node .\scripts\cleanup-existing-jobs.js --execute
  } else {
    node .\scripts\cleanup-existing-jobs.js
  }
} finally { Pop-Location }
