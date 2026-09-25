@echo off
title bolo (dev - runs from source, always current)
cd /d "%~dp0"

echo Starting bolo from source...
echo.

call npm run dev

if errorlevel 1 (
  echo.
  echo ---------------------------------------------------------------
  echo bolo exited with an error. The messages above say why.
  echo ---------------------------------------------------------------
  pause >nul
)
