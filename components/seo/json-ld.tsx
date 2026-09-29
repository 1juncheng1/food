// ────────────────────────────────────────────────────────────
// JSON-LD 结构化数据注入组件。
//
// 为什么用 dangerouslySetInnerHTML：结构化数据必须是页面里的一段
// 原生 <script type="application/ld+json">，搜索引擎不执行 React。
//
// 安全：JSON 里若出现 "</script>" 会提前闭合标签造成注入，
// 统一把 "<" 转义成 \u003c（合法 JSON 转义，解析结果不变）。
// ────────────────────────────────────────────────────────────

type JsonLdData = Record<string, unknown> | Record<string, unknown>[]

export function JsonLd({ data }: { data: JsonLdData }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/</g, '\\u003c'),
      }}
    />
  )
}
