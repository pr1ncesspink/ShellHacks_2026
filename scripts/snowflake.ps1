param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CommandArgs
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot "backend\.env.snowflake"
$python = Join-Path $repoRoot ".venv\Scripts\python.exe"
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
    $name, $value = $match.Groups[1].Value, $match.Groups[2].Value
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

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $python
$startInfo.WorkingDirectory = $repoRoot
$startInfo.UseShellExecute = $false
$startInfo.ArgumentList.Add("-m")
$startInfo.ArgumentList.Add("backend.projectdata")
foreach ($argument in $CommandArgs) {
    $startInfo.ArgumentList.Add($argument)
}
foreach ($name in $loadedNames) {
    $startInfo.Environment[$name] = $entries[$name]
}
$process = [System.Diagnostics.Process]::Start($startInfo)
$process.WaitForExit()
exit $process.ExitCode
