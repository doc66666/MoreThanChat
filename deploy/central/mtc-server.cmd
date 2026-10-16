@echo off
setlocal
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0server-cli.mjs" %*
) else (
  node "%~dp0server-cli.mjs" %*
)
exit /b %errorlevel%
