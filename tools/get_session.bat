@echo off
rem ============================================================
rem  Smile One session in one go (double-click this file).
rem  1) opens Chrome (its own profile, so you stay logged in next time)
rem  2) you log in to smile.one (Google login is fine), then press Enter here
rem  3) saves smileone_session.json (smile.one cookies only) and
rem     copies its text to the clipboard -> paste it in Admin Panel > ML TopUp
rem ============================================================
setlocal
cd /d "%~dp0.."
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" (
  echo Chrome not found. Edit the CHROME path in tools\get_session.bat
  pause
  exit /b 1
)
start "" "%CHROME%" --remote-debugging-port=9222 --user-data-dir="%CD%\chrome-smile-profile" "https://www.smile.one/merchant/mobilelegends"
echo.
echo  1) In the Chrome window: log in to smile.one (if it is not logged in already).
echo  2) Come back here and press any key.
echo.
pause >nul
python tools\save_session_smile.py
if errorlevel 1 (
  echo.
  echo  FAILED. Make sure the Chrome window above is still open, then run this again.
  pause
  exit /b 1
)
clip < smileone_session.json
echo.
echo  Done. smileone_session.json is saved and its text is COPIED to the clipboard.
echo  Now open Admin Panel ^> ML TopUp, paste into the box, press Save, then "Session check".
echo  (or send the smileone_session.json file to the bot as a file)
echo.
pause
