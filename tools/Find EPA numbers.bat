@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0find-epa-numbers.ps1"
if errorlevel 1 pause
