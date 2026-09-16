[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$workspaceRoot = Split-Path -Parent $PSScriptRoot
$researchRoot = Join-Path $workspaceRoot '.research'

New-Item -ItemType Directory -Force -Path $researchRoot | Out-Null

$upstreams = @(
    @{
        Name = 'deepseek-harness'
        Url = 'https://github.com/deepseek-ai/deepseek-harness.git'
    },
    @{
        Name = 'cordis'
        Url = 'https://github.com/cordiverse/cordis.git'
    }
)

foreach ($upstream in $upstreams) {
    $target = Join-Path $researchRoot $upstream.Name
    if (Test-Path -LiteralPath (Join-Path $target '.git')) {
        Write-Host "Updating $($upstream.Name)..."
        git -C $target pull --ff-only
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to update $($upstream.Name)."
        }
    }
    elseif (Test-Path -LiteralPath $target) {
        throw "Refusing to overwrite non-Git directory: $target"
    }
    else {
        Write-Host "Cloning $($upstream.Name)..."
        git clone $upstream.Url $target
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to clone $($upstream.Name)."
        }
    }

    git -C $target log -1 --format='%h %ci %s'
}
