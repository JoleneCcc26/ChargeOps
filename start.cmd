@echo off
REM ============================================================================
REM  ChargeOps — start everything
REM ============================================================================
REM  Double-click this, or run it from a terminal. Leave the window open: the
REM  four processes it starts live inside it, and closing it stops them.
REM
REM  Why this file exists: MySQL is installed as a Windows service, so it comes
REM  back on its own after a restart. Node is not, so nothing is listening on
REM  4000 or 5173 until something starts it. That asymmetry is why the database
REM  looks fine and the page will not open.
REM ============================================================================

cd /d "%~dp0"

echo.
echo   ChargeOps
echo   ---------------------------------------------------------------
echo.

REM --- Is MySQL actually up? ---------------------------------------------
REM  Checked first because every failure downstream of a stopped database
REM  looks like an application bug and is not one.
sc query MySQL96 2>nul | find "RUNNING" >nul
if errorlevel 1 (
  sc query MySQL80 2>nul | find "RUNNING" >nul
  if errorlevel 1 (
    echo   [!] MySQL does not appear to be running.
    echo.
    echo       Start it from Services, or in an ADMIN terminal:
    echo         net start MySQL96
    echo.
    echo       Continuing anyway - the server will report the real error.
    echo.
  )
)

REM --- Dependencies ------------------------------------------------------
if not exist "node_modules" (
  echo   node_modules missing - installing. This takes a few minutes.
  echo.
  call npm ci
  echo.
)

echo   Starting API, workers, simulated fleet and web UI...
echo.
echo   When you see "VITE ready", open:   http://localhost:5173
echo   Sign in with any of: ops, tech, finance, host, viewer
echo   Password: chargeops-demo
echo.
echo   Press Ctrl+C to stop everything.
echo   ---------------------------------------------------------------
echo.

call npm run dev:all

REM  If dev:all exits, hold the window open so the error is readable rather
REM  than flashing past on a double-click.
echo.
echo   ---------------------------------------------------------------
echo   Everything stopped. Press any key to close.
pause >nul
