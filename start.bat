@echo off
title Jarvis - Central Command
echo ====================================================
echo   Jarvis HUD + WhatsApp Exporter Startup
echo ====================================================
echo.

echo [1/3] Launching WhatsApp Exporter (Look for QR code here if disconnected)...
start "WhatsApp Exporter" cmd /k "cd /d D:\whatsapp-web.js\my-bot && node export.js"

echo [2/3] Launching Dashboard Node Server...
start "Dashboard Server" cmd /k "cd /d D:\whatsapp-web.js\my-bot && node dashboard.js"

echo [3/3] Opening Jarvis HUD in your browser...
rem Give the dashboard a second to bind the port before opening the browser
timeout /t 2 /nobreak >nul
start http://localhost:3000

echo.
echo ====================================================
echo  WAIT! If this is your first time or you disconnected,
echo  check the "WhatsApp Exporter" window and scan the QR code.
echo.
echo  Once the exporter is connected and ready, return here.
echo ====================================================
echo.
pause

echo.
echo Starting Jarvis Agent Backend...
echo (Check your browser at http://localhost:3000 and turn on the Mic)
echo.
cd /d D:\whatsapp-web.js\my-bot
python jarvis.py
