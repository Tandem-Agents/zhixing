@echo off
node --env-file="%~dp0.env" "%~dp0packages\cli\dist\index.js" %*
