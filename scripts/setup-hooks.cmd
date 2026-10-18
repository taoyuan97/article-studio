@echo off
setlocal EnableExtensions
cd /d "%~dp0.."

echo [1/3] 启用 pre-push 分支保护钩子...
git config core.hooksPath .githooks
for /f "delims=" %%p in ('git config core.hooksPath') do set "CURRENT=%%p"
if /I not "%CURRENT%"==".githooks" (
  echo [FAIL] core.hooksPath 设置失败：%CURRENT%
  exit /b 1
)
echo [OK] core.hooksPath = %CURRENT%

set "SH=%ProgramFiles%\Git\bin\sh.exe"
if not exist "%SH%" set "SH=%ProgramFiles(x86)%\Git\bin\sh.exe"
if not exist "%SH%" (
  echo [WARN] 未找到 Git 自带 sh，跳过钩子功能自测。
  echo        请按 docs\git\branch-workflow.md 7.2 手动验证两条路径。
  exit /b 0
)

echo [2/3] 自测：直推 main 应被拦截...
echo refs/heads/dummy 0000000000000000000000000000000000000000 refs/heads/main 0000000000000000000000000000000000000000|"%SH%" .githooks/pre-push origin origin >nul 2>&1
if errorlevel 1 (
  echo [OK] 直推 main 已拦截
) else (
  echo [FAIL] 未能拦截直推 main，请检查 .githooks/pre-push 与 core.hooksPath
  exit /b 1
)

echo [3/3] 自测：功能分支应放行...
echo refs/heads/dummy 0000000000000000000000000000000000000000 refs/heads/feature/dummy 0000000000000000000000000000000000000000|"%SH%" .githooks/pre-push origin origin >nul 2>&1
if errorlevel 1 (
  echo [FAIL] 误拦功能分支，请检查 .githooks/pre-push
  exit /b 1
)
echo [OK] 功能分支已放行

echo.
echo 分支钩子已启用。当前分支：
git branch --show-current
echo 规范见 docs\git\branch-workflow.md
exit /b 0
