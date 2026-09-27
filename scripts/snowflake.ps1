param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CommandArgs
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot "backend\.env.snowflake"
$python = Join-Path $repoRoot ".venv\Scripts\python.exe"
# Prefer the dedicated upload environment once backend/requirements-projectdata.txt is installed there.
$projectDataRoot = Join-Path $repoRoot ".venv-projectdata"
if (Test-Path -LiteralPath (Join-Path $projectDataRoot "Lib\site-packages\snowflake\connector") -PathType Container) {
    $python = Join-Path $projectDataRoot "Scripts\python.exe"
}
$allowedNames = @(
    "SNOWFLAKE_ACCOUNT", "SNOWFLAKE_USER", "SNOWFLAKE_TOKEN", "SNOWFLAKE_WAREHOUSE",
    "SNOWFLAKE_ROLE", "SNOWFLAKE_DATABASE", "SNOWFLAKE_SCHEMA", "SNOWFLAKE_STAGE",
    "SNOWFLAKE_STATEMENT_TIMEOUT", "GRIDLOCK_REFERENCE_DATABASE", "GRIDLOCK_UPLOAD_DATABASE",
    "GRIDLOCK_DATA_SCHEMA"
)
$requiredNames = @("SNOWFLAKE_ACCOUNT", "SNOWFLAKE_USER", "SNOWFLAKE_TOKEN", "SNOWFLAKE_WAREHOUSE")
$loadedNames = [System.Collections.Generic.HashSet[string]]::new()
$entries = @{}

if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    throw "Missing backend/.env.snowflake. Copy backend/.env.snowflake.example and fill it in."
}
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "Missing .venv\\Scripts\\python.exe. Create the repository virtual environment first."
}

foreach ($line in Get-Content -LiteralPath $envFile) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) {
        continue
    }
    $match = [regex]::Match($trimmed, "^([A-Z0-9_]+)=(.*)$")
    if (-not $match.Success -or $allowedNames -notcontains $match.Groups[1].Value) {
        throw "Invalid Snowflake environment-file entry."
    }
    $name, $value = $match.Groups[1].Value, $match.Groups[2].Value.Trim()
    # Accept dotenv-style quoting: KEY="value" or KEY='value'.
    if ($value.Length -ge 2 -and ($value[0] -eq '"' -or $value[0] -eq "'") -and $value[-1] -eq $value[0]) {
        $value = $value.Substring(1, $value.Length - 2)
    }
    if ($value.StartsWith("<")) {
        throw "Replace placeholders in backend/.env.snowflake before running this command."
    }
    $loadedNames.Add($name) | Out-Null
    $entries[$name] = $value
}

$missingRequired = $requiredNames | Where-Object {
    -not $loadedNames.Contains($_) -or [string]::IsNullOrWhiteSpace($entries[$_])
}
if ($missingRequired) {
    throw "Missing required Snowflake environment-file settings."
}

# Windows PowerShell 5.1 has no ProcessStartInfo.ArgumentList, so set the values for the
# child launch and restore the caller's environment afterwards.
$previous = @{}
foreach ($name in $loadedNames) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    [Environment]::SetEnvironmentVariable($name, $entries[$name], "Process")
}
Push-Location -LiteralPath $repoRoot
try {
    & $python -m backend.projectdata @CommandArgs
    $exitCode = $LASTEXITCODE
}
finally {
    Pop-Location
    foreach ($name in $loadedNames) {
        [Environment]::SetEnvironmentVariable($name, $previous[$name], "Process")
    }
}
exit $exitCode
