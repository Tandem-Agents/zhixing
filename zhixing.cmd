@echo off
node --env-file="%~dp0.env" --import=tsx/esm "%~dp0packages\cli\src\index.ts" %*
