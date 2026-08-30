@echo off
rem 인더필드 ERP 서버 실행 (http://localhost:8787)
rem 이 창을 닫으면 서버가 종료됩니다.
cd /d "%~dp0"
echo [ERP] 서버를 시작합니다... 브라우저에서 http://localhost:8787 을 여세요.
"C:\Program Files\Adobe\Adobe Creative Cloud Experience\libs\node.exe" server\index.mjs
pause
