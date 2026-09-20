'use client'

import Link from 'next/link'

// ============================================================
// 登录引导弹窗：游客尝试使用需登录功能时弹出
// 替代直接跳转 /login，让用户在当前页面了解产品价值后再决定注册
// ============================================================

export function LoginGate({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-sm mx-4 rounded-2xl border border-indigo-500/30 bg-zinc-900 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-zinc-500 hover:text-zinc-300 transition text-lg leading-none"
          aria-label="关闭"
        >
          ×
        </button>

        <div className="text-center">
          <div className="text-4xl mb-3">🔐</div>
          <h2 className="text-lg font-semibold text-white mb-2">
            登录后即可生成
          </h2>
          <p className="text-sm text-zinc-400 leading-relaxed mb-6">
            注册账号后，AI 将结合你的创作者人格、素材库与历史作品，
            生成更贴合你风格的文案，并支持多版本迭代优化。
          </p>

          <div className="space-y-2.5">
            <Link
              href="/login"
              className="block w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition"
            >
              登录 / 注册
            </Link>
            <button
              onClick={onClose}
              className="block w-full py-2.5 rounded-xl text-zinc-500 hover:text-zinc-300 text-xs transition"
            >
              再看看
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
