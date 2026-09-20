// ============================================================
// Creator Interest Profile —— 向量数学（纯函数，零依赖）
// 聚类/继承/候选相似度共用，全部确定性、可单测。
// ============================================================

/** WF4/WF9：pgvector 列经 PostgREST 返回 "[1,2,...]" 字符串或数组，统一为 number[]（否则 null） */
export function parseVectorColumn(v: unknown): number[] | null {
  if (Array.isArray(v)) {
    return v.length > 0 && v.every((x) => typeof x === 'number') ? (v as number[]) : null
  }
  if (typeof v === 'string' && v.startsWith('[')) {
    try {
      const p: unknown = JSON.parse(v)
      return Array.isArray(p) && p.every((x) => typeof x === 'number') ? (p as number[]) : null
    } catch {
      return null
    }
  }
  return null
}

/** 点积；长度不一致时按较短长度计算（调用方应保证 1024 维一致） */
export function dotProduct(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  let sum = 0
  for (let i = 0; i < n; i++) sum += a[i] * b[i]
  return sum
}

export function magnitude(a: number[]): number {
  let sum = 0
  for (const x of a) sum += x * x
  return Math.sqrt(sum)
}

/** 余弦相似度 [-1,1]；零向量或异常输入返回 0（表示"无相似证据"，不抛错） */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 0
  const dot = dotProduct(a, b)
  const ma = magnitude(a)
  const mb = magnitude(b)
  if (ma === 0 || mb === 0) return 0
  return dot / (ma * mb)
}

/** 余弦距离 [0,2] */
export function cosineDistance(a: number[], b: number[]): number {
  return 1 - cosineSimilarity(a, b)
}

/** 加权质心：Σ(w·v)/Σw；总权为 0 时退化为算术平均 */
export function weightedCentroid(
  vectors: Array<{ vector: number[]; weight: number }>
): number[] {
  if (vectors.length === 0) return []
  const dim = vectors[0].vector.length
  const acc = new Array<number>(dim).fill(0)
  let total = 0
  for (const { vector, weight } of vectors) {
    const w = Number.isFinite(weight) ? weight : 0
    total += w
    for (let i = 0; i < dim && i < vector.length; i++) acc[i] += w * vector[i]
  }
  if (total > 0) {
    for (let i = 0; i < dim; i++) acc[i] /= total
    return acc
  }
  for (let i = 0; i < dim; i++) acc[i] = vectors.reduce((s, x) => s + (x.vector[i] ?? 0), 0) / vectors.length
  return acc
}
