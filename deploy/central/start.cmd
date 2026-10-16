@echo off
call "%~dp0mtc-server.cmd" start %*
if errorlevel 1 pause
