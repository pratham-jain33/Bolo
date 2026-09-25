@echo off
title bolo Doctor (dev - runs from source, always current)
cd /d "%~dp0"

echo Starting Bolo Doctor from source...
echo Skips the animated onboarding and opens the plain dictation window.
echo.

call npm run dev -- --doctor

if errorlevel 1 (
  echo.
  echo ---------------------------------------------------------------
  echo bolo Doctor exited with an error. The messages above say why.
  echo ---------------------------------------------------------------
  pause >nul
)
