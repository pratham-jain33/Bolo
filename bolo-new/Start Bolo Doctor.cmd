@echo off
title Bolo Doctor (dev - runs from source, always current)
cd /d "%~dp0"

echo Starting Bolo Doctor from source...
echo One window: dictate, review, approve, save, print, share.
echo.

call npm run dev

if errorlevel 1 (
  echo.
  echo ---------------------------------------------------------------
  echo Bolo Doctor exited with an error. The messages above say why.
  echo ---------------------------------------------------------------
  pause >nul
)

