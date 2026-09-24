@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo  [1/3] 启动本地代理桥（socks5 -^> http）
echo        *.supabase.co 直连会被重置，必须走代理
echo ============================================
start "socks-bridge" /min cmd /c "node scripts\socks-bridge.mjs"
timeout /t 2 >nul

echo.
echo ============================================
echo  [2/3] 自检：上游 socks5 是否真的活着
echo        没有这道检查，上游挂了也会照常启动，
echo        结果就是全站"网络异常"却看不出是代理断了
echo ============================================
node -e "const n=require('net');const s=n.connect(10808,'127.0.0.1');s.on('connect',()=>{console.log('  [OK] 上游 socks5 127.0.0.1:10808 可用');process.exit(0)});s.on('error',()=>{console.log('  [FAIL] 上游 socks5 127.0.0.1:10808 没有响应');process.exit(1)});s.setTimeout(2000,()=>{console.log('  [FAIL] 上游 socks5 连接超时');process.exit(1)})"

if errorlevel 1 (
  echo.
  echo  ----------------------------------------------------------
  echo  上游代理没起来 —— 现在启动网站，所有页面都会报"网络异常"。
  echo  两条路，选一条再继续：
  echo    1. 打开你的代理软件（提供 socks5 127.0.0.1:10808，不必开全局模式）
  echo    2. 若网络本身能直连 ^(如手机热点^)，请关闭本窗口，改用 npm run dev 启动
  echo  ----------------------------------------------------------
  pause
)

echo.
echo ============================================
echo  [3/3] 让 Node 走本地代理桥
echo ============================================
set HTTPS_PROXY=http://127.0.0.1:18080
set HTTP_PROXY=http://127.0.0.1:18080
set NODE_USE_ENV_PROXY=1

echo.
echo ============================================
echo  [3/3] 启动网站：http://localhost:3000
echo        关闭本窗口即停止网站
echo ============================================
echo.
npm run dev
