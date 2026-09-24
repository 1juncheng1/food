// ============================================================
// socks-bridge —— 把本机 socks5 代理转成 Node 能用的 HTTP 代理
//
// 为什么需要它：
//   本项目部署在国内网络环境下，*.supabase.co 直连会被 RST（TLS 重置），
//   只有走代理才能访问。浏览器能用（用户装了代理扩展/软件），
//   但 Node 侧不一样：
//     · Node 的 fetch(undici) 读 HTTP_PROXY/HTTPS_PROXY 环境变量
//       （Node ≥ 24 需同时设 NODE_USE_ENV_PROXY=1）；
//     · 它**只认 http:// 与 https:// 形式**，不认 socks5://（会直接抛
//       Invalid URL protocol: the URL must start with `http:` or `https:`）；
//     · 而多数代理软件的 socks 口（如 10808）并没有同时开放 http 口。
//   于是在本机起一个 HTTP CONNECT 代理，收到 CONNECT 后
//   自己完成 SOCKS5 握手再透传字节流，Node 侧就只需认这个 http 地址。
//
// 用法：
//   node scripts/socks-bridge.mjs            # 监听 127.0.0.1:18080
//   然后启动服务时带上：
//     HTTPS_PROXY=http://127.0.0.1:18080 NODE_USE_ENV_PROXY=1
//   端口/上游可用环境变量覆盖：BRIDGE_PORT / SOCKS_HOST / SOCKS_PORT
//
// 说明：仅实现 CONNECT（HTTPS 隧道）——本项目服务端要访问的全是 https。
// ============================================================

import http from 'node:http'
import net from 'node:net'

const SOCKS_HOST = process.env.SOCKS_HOST || '127.0.0.1'
const SOCKS_PORT = Number(process.env.SOCKS_PORT || 10808)
const LISTEN_PORT = Number(process.env.BRIDGE_PORT || 18080)
const SOCKS_TIMEOUT_MS = 15_000

/**
 * 与上游 socks5 建立到 target 的连接（无认证）。
 * 成功后 resolve 一个已就绪的 socket，后续字节直接透传。
 */
function socks5Connect(targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(SOCKS_PORT, SOCKS_HOST)
    let phase = 'greeting'
    let pending = Buffer.alloc(0)

    const fail = (msg) => {
      socket.destroy()
      reject(new Error(msg))
    }

    socket.setTimeout(SOCKS_TIMEOUT_MS, () => fail('上游 socks 握手超时'))
    socket.once('error', (e) => reject(e))

    // ① 问候：声明「无需认证」
    socket.on('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])))

    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])

      if (phase === 'greeting') {
        if (pending.length < 2) return
        if (pending[0] !== 0x05 || pending[1] !== 0x00) return fail('上游 socks 未接受无认证连接')
        pending = pending.subarray(2)
        phase = 'connect'
        // ② 连接请求：ATYP=0x03（域名，让代理解析 DNS，避免本地 DNS 污染）
        const host = Buffer.from(targetHost, 'utf8')
        const port = Buffer.alloc(2)
        port.writeUInt16BE(targetPort)
        socket.write(
          Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, port])
        )
        // 不 return：同一次 data 里可能已经带上响应，继续往下判
      }

      if (phase === 'connect') {
        if (pending.length < 5) return
        if (pending[1] !== 0x00) return fail(`上游 socks 拒绝连接（code ${pending[1]}）`)
        const atyp = pending[3]
        const need =
          atyp === 0x01 ? 10 // IPv4 + port
            : atyp === 0x04 ? 22 // IPv6 + port
              : 5 + pending[4] + 2 // 域名长度 + port
        if (pending.length < need) return

        const rest = pending.subarray(need)
        socket.setTimeout(0)
        socket.removeAllListeners('data')
        socket.removeAllListeners('error')
        if (rest.length) socket.unshift(rest)
        resolve(socket)
      }
    })
  })
}

const server = http.createServer((_req, res) => {
  // 只做隧道：目标一定是 https，Node 会先发 CONNECT
  res.writeHead(501, { 'Content-Type': 'text/plain' })
  res.end('socks-bridge: only CONNECT is supported')
})

server.on('connect', async (req, clientSocket, head) => {
  const [host, portRaw] = req.url.split(':')
  const port = Number(portRaw || 443)

  try {
    const upstream = await socks5Connect(host, port)
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head?.length) upstream.write(head)

    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)

    const cleanup = () => {
      upstream.destroy()
      clientSocket.destroy()
    }
    upstream.on('close', cleanup)
    clientSocket.on('close', cleanup)
    upstream.on('error', cleanup)
    clientSocket.on('error', cleanup)
  } catch (e) {
    console.error(`[socks-bridge] ${host}:${port} 连接失败:`, e.message)
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  }
})

server.on('error', (e) => {
  // 端口被占用 = 已经有一个桥在跑（重复双击启动脚本的常见情况）。
  // 这是正常状态，不该给用户抛一堆红字。
  if (e.code === 'EADDRINUSE') {
    console.log(`[socks-bridge] 端口 ${LISTEN_PORT} 已有桥在运行，直接复用`)
    process.exit(0)
  }
  console.error('[socks-bridge] 启动失败:', e.message)
  process.exit(1)
})

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(
    `[socks-bridge] 已启动：http://127.0.0.1:${LISTEN_PORT} → socks5://${SOCKS_HOST}:${SOCKS_PORT}`
  )
})
