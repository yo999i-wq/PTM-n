@echo off
chcp 65001 >nul
title Stany Lantek - weryfikacja stanow
cd /d "%~dp0"

echo ============================================
echo   Weryfikacja stanow Lantek ^<-^> ERP
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [BLAD] Nie znaleziono Node.js. Zainstaluj Node ze strony https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Pierwsze uruchomienie - instaluje zaleznosci ^(npm install^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [BLAD] npm install nie powiodl sie.
    pause
    exit /b 1
  )
  echo.
)

rem --- Regula zapory Windows, zeby wspolpracownicy w sieci mogli sie polaczyc ---
netsh advfirewall firewall show rule name="Stany Lantek 3066" >nul 2>nul
if errorlevel 1 (
  echo Dodaje regule zapory dla portu 3066 ^(udostepnianie w sieci^)...
  netsh advfirewall firewall add rule name="Stany Lantek 3066" dir=in action=allow protocol=TCP localport=3066 >nul 2>nul
  if errorlevel 1 (
    echo   [i] Nie udalo sie dodac reguly zapory ^(brak uprawnien administratora^).
    echo       Udostepnianie w sieci moze byc zablokowane. Aby wlaczyc raz na stale,
    echo       uruchom start.bat jako Administrator lub dodaj recznie wyjatek dla portu 3066.
  ) else (
    echo   [OK] Regula zapory dodana.
  )
  echo.
)

rem --- Adres sieciowy tego komputera ---
set "LANIP="
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do if not defined LANIP set "LANIP=%%a"
set "LANIP=%LANIP: =%"

echo Startuje serwer...
echo   Ten komputer:  http://localhost:3066
if defined LANIP echo   Udostepnij:     http://%LANIP%:3066
echo Zamknij to okno, aby zatrzymac aplikacje.
echo.

start "" http://localhost:3066
node server.js

echo.
echo Serwer zatrzymany.
pause
