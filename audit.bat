@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Puck Workshop audit
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem  audit.bat - one click local audit of a Workshop mod, same pipeline as the
rem  site and the Codespace: steamcmd download, SHA-256 of every file, PE parse,
rem  ILSpy decompile, indicator scan, then REPORT.md + evidence\ + sources\.
rem
rem  Usage:
rem    audit.bat                     ask for a Workshop id / link
rem    audit.bat 3765045334          audit that id
rem    audit.bat 3765045334 site     also publish it as an automated site triage
rem    audit.bat <id> --dir <path>   audit files already on disk
rem ---------------------------------------------------------------------------

set "MODE=full"
set "ID="
set "EXTRA="

:parse
if "%~1"=="" goto parsed
set "ARG=%~1"
if /i "!ARG!"=="site" (
  set "MODE=site"
  shift
  goto parse
)
if "!ARG:~0,2!"=="--" (
  set "EXTRA=!EXTRA! !ARG!"
  if not "%~2"=="" (
    set "EXTRA=!EXTRA! "%~2""
    shift
  )
  shift
  goto parse
)
if "!ID!"=="" (
  set "ID=!ARG!"
) else (
  set "EXTRA=!EXTRA! !ARG!"
)
shift
goto parse
:parsed

if "!ID!"=="" (
  echo.
  echo   Puck Workshop audit
  echo   -------------------
  set /p "ID=Workshop id or link: "
)
if "!ID!"=="" (
  echo Nothing to do - no Workshop id given.
  pause
  exit /b 2
)

rem accept full workshop links and steam:// links
set "RAW_ID=!ID!"
for /f "delims=" %%A in ('node -e "const s=process.env.RAW_ID||'';const m=s.match(/id=(\d{4,})/)||s.match(/(\d{6,})/);process.stdout.write(m?m[1]:s)"') do set "ID=%%A"
echo.
echo   Auditing Workshop !ID!  [mode: !MODE!]
echo.

rem --- prerequisites -----------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo   [x] Node.js 20+ is required: https://nodejs.org/
  echo       Install it, then run this file again.
  pause
  exit /b 1
)

set "ILSPYCMD="
where ilspycmd >nul 2>nul
if not errorlevel 1 set "ILSPYCMD=ilspycmd"
if not defined ILSPYCMD if exist "%USERPROFILE%\.dotnet\tools\ilspycmd.exe" set "ILSPYCMD=%USERPROFILE%\.dotnet\tools\ilspycmd.exe"
if not defined ILSPYCMD (
  echo   [i] ILSpy CLI not found - decompiled sources will be skipped.
  echo       Install it once with:  dotnet tool install --global ilspycmd
)

set "STEAMCMD="
where steamcmd >nul 2>nul
if not errorlevel 1 set "STEAMCMD=steamcmd"
if not defined STEAMCMD for %%P in (
  "C:\steamcmd\steamcmd.exe"
  "%USERPROFILE%\steamcmd\steamcmd.exe"
  "%USERPROFILE%\Documents\Code\_steamcmd\steamcmd.exe"
  "%ProgramFiles(x86)%\Steam\steamcmd.exe"
) do if exist %%P set "STEAMCMD=%%~P"
if not defined STEAMCMD (
  echo   [i] steamcmd not found - pass --dir with files already on disk, or install it.
  echo       https://developer.valvesoftware.com/wiki/SteamCMD
)

rem --- run ---------------------------------------------------------------------
if /i "!MODE!"=="site" (
  echo   Publishing as a site triage ^(reports\ + data\^)...
  node scripts\audit-mod.mjs --id !ID! --no-deploy
) else (
  echo   Full local audit into audit-out\
  node scripts\audit-box.mjs --id !ID! --out audit-out!EXTRA!
)
if errorlevel 1 (
  echo.
  echo   [x] The audit failed - see the output above.
  pause
  exit /b 1
)

echo.
echo   Done. Reports in %CD%\audit-out
if defined AUDIT_BATCH exit /b 0
if /i not "!MODE!"=="site" if exist "audit-out" start "" explorer "audit-out"
echo.
pause
exit /b 0
