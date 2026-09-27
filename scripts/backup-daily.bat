@echo off
chcp 65001 >nul
rem ============================================================
rem 每日数据库备份（Windows 计划任务入口）
rem
rem 注册方式（管理员 PowerShell 执行一次）：
rem   schtasks /Create /TN "FoodDBBackup" /TR "cmd /c cd /d C:\Users\王俊澄\Desktop\food && scripts\backup-daily.bat" /SC DAILY /ST 03:00 /F
rem
rem 说明：备份产物落在 backups\ ，保留最近 30 份；日志追加到 backups\backup.log。
rem       详见 docs\runbooks\backup-restore.md
rem ============================================================

cd /d "%~dp0.."

if not exist "backups" mkdir "backups"

echo [%date% %time%] 开始备份 >> backups\backup.log
node scripts\backup-db.mjs --keep=30 >> backups\backup.log 2>&1

if errorlevel 1 (
  echo [%date% %time%] 备份失败，请查看上方日志 >> backups\backup.log
  exit /b 1
)

echo [%date% %time%] 备份完成 >> backups\backup.log
exit /b 0
