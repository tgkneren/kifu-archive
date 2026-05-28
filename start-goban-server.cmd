@echo off
cd /d "%~dp0"
set "PORT=4174"
set "HOST=0.0.0.0"
"C:\Program Files\nodejs\node.exe" server.mjs >> server-live.log 2>> server-live-error.log
