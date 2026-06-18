@echo off
title MRP Browser - Europa Systems
cd /d "%~dp0"

REM Sprawdz czy node-firebird jest dostepny
if not exist "node_modules\node-firebird" (
    echo [INFO] Brak node_modules. Instalowanie...
    npm install
    if errorlevel 1 (
        echo [BLAD] npm install nie powiodl sie!
        echo Sprawdz polaczenie z internetem lub uruchom install.bat
        pause
        exit /b 1
    )
)

echo.
echo =====================================================
echo  MRP Browser - Europa Systems
echo  http://localhost:5350
echo =====================================================
echo  Ctrl+C aby zatrzymac serwer
echo.

node server.js

if errorlevel 1 (
    echo.
    echo [BLAD] Sprawdz config.js - parametry polaczenia Firebird:
    type config.js | findstr /i "host\|port\|database\|user"
    echo.
    pause
)
