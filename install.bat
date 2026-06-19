@echo off
echo ============================================
echo  MRP Browser - Instalacja
echo ============================================
echo.

cd /d "%~dp0"

echo Sprawdzanie Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo BLAD: Node.js nie jest zainstalowany!
    echo Pobierz ze: https://nodejs.org
    pause
    exit /b 1
)

echo Node.js OK
echo.
echo Instalacja zaleznosci (node-firebird)...
npm install

if errorlevel 1 (
    echo BLAD instalacji npm!
    pause
    exit /b 1
)

echo.
echo ============================================
echo  Instalacja zakonczona!
echo  Uruchom: START.bat
echo ============================================
pause
