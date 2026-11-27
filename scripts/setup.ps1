# mx-GPT & mx-Cowork — One-Time Setup Script (Windows PowerShell)
$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $RootDir

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  mx-GPT & mx-Cowork - One-Time Setup (Windows)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js 20+ is required. Install from https://nodejs.org/"
    exit 1
}

$NodeVer = node -v
Write-Host "[ok] Node.js $NodeVer" -ForegroundColor Green

if (-not (Test-Path "$RootDir\.env")) {
    Copy-Item "$RootDir\.env.example" "$RootDir\.env"
    Write-Host "[ok] Created .env from .env.example" -ForegroundColor Green
} else {
    Write-Host "[ok] Keeping existing .env" -ForegroundColor Green
}

New-Item -ItemType Directory -Force -Path "$RootDir\data", "$RootDir\workspace" | Out-Null

node --check "$RootDir\server\server.js"
node --check "$RootDir\deploy\ollama-queue.cjs"
node --check "$RootDir\cowork\src\electron-main.js"
Write-Host "[ok] Verified mx-GPT server, queue scheduler, and mx-Cowork" -ForegroundColor Green

Write-Host ""
Write-Host "Setup complete! Start with:" -ForegroundColor Cyan
Write-Host "  1) Queue scheduler:  node deploy\ollama-queue.cjs"
Write-Host "  2) mx-GPT web app:   node server\server.js          -> http://127.0.0.1:8088"
Write-Host "  3) mx-Cowork app:    cd cowork; npm install; npm start"
Write-Host ""
Write-Host "Or download the prebuilt Windows executable (mx-cowork-win-x64.exe) from GitHub Releases."
