$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
npm --prefix web ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
npm --prefix web run build
if ($LASTEXITCODE -ne 0) { throw 'Angular build failed' }
go run ./cmd/server
