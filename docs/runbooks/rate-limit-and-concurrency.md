# 限流、并发与防刷配置

> 建立时间：2026-09-27
> 背景：全库审计发现"AI 接口限流覆盖率不足一半、无限并发闸门、无跨实例计数"，
> 本文档记录改造后的架构与可调参数。

---

## 一、现在有四层防护

| 层 | 位置 | 回答的问题 | 超限行为 |
|---|---|---|---|
| 1. 频率限流（按 IP，全局） | `middleware.ts` | 这个 IP 一分钟发多少次？ | 429 + `Retry-After` |
| 2. 并发闸门（全局） | `middleware.ts` | 同一时刻有多少个昂贵请求在跑？ | 503 + `Retry-After` |
| 3. 频率限流（按用户） | 各 AI 路由 `guardRateLimit` | 这个用户一分钟调几次 AI？ | 429 + `Retry-After` |
| 4. 积分预扣（并发安全） | `lib/aiCost.ts` | 这次调用扣得起吗？ | 402 提示充值 |

**为什么第 4 层不能替代前三层**：积分校验只保证"用户付得起"，
不保证"系统扛得住"。100 个用户各有 20 积分，全部合规，
但 100 个 60 秒的 AI 请求同时挂在 Serverless 进程里，
会把函数槽位和上游 DeepSeek 并发额度一起打满。

**为什么第 1 层不能替代第 3 层**：同一出口 IP（公司 NAT、校园网）
后面可能有几十个真实用户，只按 IP 限流会误伤；按 userId 才准。

---

## 二、可调参数

全部走环境变量，不配则用默认值（默认值偏保守，能直接上生产）。

| 变量 | 默认值 | 含义 |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` | 无 | Upstash Redis 地址 |
| `UPSTASH_REDIS_REST_TOKEN` | 无 | Upstash Redis token |
| `AI_MAX_CONCURRENCY` | `25` | 在飞的昂贵请求数上限（全局） |
| `AI_TIMEOUT_BUDGET_MS` | `25000` | 单次 LLM 调用超时预算 |

### `UPSTASH_REDIS_REST_URL` / `TOKEN` — **强烈建议配置**

不配的话，限流退化为**每实例独立内存计数**。
Serverless 扩容到 N 个实例，实际额度就是设定值的 N 倍——
AI 接口背后是真实计费，等于账单被放大 N 倍。

两者必须成对配置，缺一个就当作未启用（不会半配置状态下白打 HTTP）。
Redis 故障时**自动降级放行**，不会因为 Redis 抖动把整站变 429。

Upstash 免费额度对本项目绰绰有余。

### `AI_MAX_CONCURRENCY` — 并发闸门

窗口固定 30 秒（略大于单次 AI 请求最大耗时），
"30 秒内启动的昂贵请求数"≈"同时在飞的数量"。

超出返回 **503 而不是排队**：排队只会让每个请求都耗到超时，
用户体验和成本都更差；直接拒绝让前端退避重试反而更快。

实现上没有"释放"动作——每条记录靠 TTL 自动消失。
这是刻意的：Serverless 进程随时可能被平台杀掉，
释放逻辑根本跑不到，信号量会永久泄漏、最终把所有请求挡在门外。

### `AI_TIMEOUT_BUDGET_MS` — 这是个**资金问题**

AI 消费是「调用前预扣 → 调用后结算，失败全额退」，
退款发生在 LLM 调用失败后的代码路径里。

若平台先到达路由的 `maxDuration` 把整个函数进程杀掉，
**退款代码根本没有机会执行**——用户没拿到结果，积分却被扣走了。

### 预算按路由算，不能取全局单值

站内 `maxDuration` 从 20s 到 60s 都有，所以预算**必须由调用方声明自己路由的
`maxDuration`**：

```ts
llmTimeoutMs(maxTokens, 60)  // 60 = 该路由的 export const maxDuration
```

规则：`预算 = maxDuration × 1000 - 5000`（5s 留给鉴权、查库、写库、响应）。

**为什么不能统一取一个值**：统一取 25s（迁就最严的 30s 路由）会让
`maxDuration=60` 的路由白白浪费 35s 可用时间，
`problemSolver` 的 7000-token 长方案会在 25s 处被自己掐断——功能回归。
反过来统一取 55s，30s 路由就会被平台硬杀，回到上面的账单事故。

未传参时兜底 25s（对应最严格的 `maxDuration=30`），
所以**不传不会出事故，只是长任务容易提前失败**。

`AI_TIMEOUT_BUDGET_MS` 是**运维总闸**：配置了就对一切生效，取 `min`
（只能收紧、不能放松），用于上游整体变慢时全局降载。平时不配。

已按路由声明预算的调用点：

| 调用点 | 路由 | 预算 |
|---|---|---|
| `problemSolver`（7000 tokens ×2） | `/api/problem-solve` (60) | 55s |
| `patchEngine` / `revisionPlan` / `intentClarifier` / `workAgentDialogue` | `/api/creative/patch`、`/work-agent/chat` (60) | 55s |
| `feedbackAlignment` | `/api/creative/alignment` (60) | 55s |
| `marketAnalyzer` / `inspirationAnalyzer` / `feedbackAnalyzer` | 30s 路由 | 25s（兜底） |

**新增 AI 调用时必须做**：查清所在路由的 `maxDuration`，把它传进
`llmTimeoutMs` 的第二参数。忘了传不会报错，只会让长输出任务莫名超时。

---

## 重试链路的请求级总预算（`withAiDeadline`）

上面管的是"单次调用别超时"，这一节管的是**多次调用加起来别超时**。

### 问题

重试循环里每次尝试都各拿一份完整预算，总和远超路由 `maxDuration`：

| 链路 | 重试次数 | 单次预算 | 路由 maxDuration | 最坏总耗时 |
|---|---|---|---|---|
| `problemSolver` | 3 | 55s | 60 | **165s** |
| `patchEngine` | 2 | 45s + 55s | 60 | **100s** |
| `marketAnalyzer` 等 | 3 | 25s | 30 | **75s** |

触发路径：第 1 次慢但成功返回了无效内容 → 第 2 次发起后必然被平台硬杀 →
**退款代码跑不到，预扣的积分退不回来**。

### 解法

整条请求共享一个 deadline（`lib/aiDeadline.ts`，基于 `AsyncLocalStorage`）。
每次 LLM 调用前先看剩余时间，不够就**直接放弃、不发起请求**。

★ 关键是放弃发生在**预扣之前**：一次都没扣，自然不需要退。
「扣了再退」依赖退款代码能跑到（进程被杀就跑不到），
「根本没扣」不可能失效——这是两种可靠性量级的差别。

### 接入方式

```ts
import { withAiDeadline } from '@/lib/aiDeadline'

export const maxDuration = 60

async function handlePost(req: Request) { /* 原 handler 主体 */ }

export const POST = withAiDeadline(60, handlePost)
```

两个 60 必须一致。未接入的路由 `remainingAiBudgetMs()` 返回 `null`（不限制），
行为同改造前——接入是渐进的，没改过的路由不会因此坏掉。

### 已接入清单

| 路由 | maxDuration | 链路 |
|---|---|---|
| `/api/problem-solve` | 60 | `problemSolver` 3 次重试 |
| `/api/creative/patch` | 60 | `patchEngine` 2 次 |
| `/api/creative/work-agent/chat` | 60 | 4 个能力串行，各带重试 |
| `/api/prompt-optimizer` | 60 | 工作分析 3 次 + 主生成 55s |
| `/api/creative/market/analyze` | 30 | `marketAnalyzer` 3 次 |
| `/api/creative/work-tags` | 30 | `workAnalysis` 3 次 |
| `/api/creative/inspiration/analyze` | 30 | `inspirationAnalyzer` 3 次 |
| `/api/creative/analyze-feedback` | 30 | `feedbackAnalyzer` 3 次 |

### ⚠ 已知副作用（必须知道）

30s 路由接入后，**重试实际上只有第 1 次能跑**（总预算 25s，跑完一次就不剩了）。
这是有意的取舍：宁可明确降级 + 退款，也不能让进程被硬杀导致钱退不回。

如果希望这些路由的重试真正生效，正确做法是**调高路由的 `maxDuration`**
（平台付费计划可到 300s），而不是去掉 deadline。

### 尚未接入

- `/api/creative/plan`、`/api/creative/blueprint`：**直连 `fetch`**，不走
  `callDeepSeekChat`，所以 deadline 对它们无效。要覆盖需先让它们改走
  `callDeepSeekChat`，或自行读 `remainingAiBudgetMs()`。
- `/api/ci/backfill-embedding`：后台批量任务，无用户计费，优先级低。

---

## 三、防刷：为什么必须开 "Confirm email"

注册赠送 20 积分（`point_config.REGISTER_BONUS_POINTS`）按 `user_id` 幂等发放，
**一人一次**。所以攻击路径不是"重复领"，而是"批量注册账号"。

`Confirm email` 开启后，每个账号都需要一个能收 OTP 的真实邮箱，
配合 Supabase 自带的注册限流（IP 10 次/10 分钟），批量注册的成本被显著抬高。
**若该开关没开**，`signUp` 会直接返回 session，注册无需任何验证——
这条路径等于敞开。

配置步骤见 `docs/runbooks/supabase-auth-config.md` 第 1 节（已列为必做）。

### 可选：严格模式（按邮箱验证状态拦截 AI）

本项目**默认不强制**校验邮箱验证状态，原因是存在 `email_confirmed_at` 为 null
的历史用户，一刀切会造成大面积功能中断。

鉴权结果已暴露该状态（`lib/apiAuth.ts` 的 `AuthResult.emailConfirmed`），
需要严格管控时，在 AI 路由里加一道前置即可：

```ts
const auth = await authenticateRequest(req)
if (!auth.ok) return auth.response
if (!auth.emailConfirmed) {
  return NextResponse.json(
    { error: '请先完成邮箱验证后再使用 AI 功能' },
    { status: 403, headers: { 'Cache-Control': 'no-store' } }
  )
}
```

开启前先确认历史用户状态：

```sql
select count(*) from auth.users where email_confirmed_at is null;
```

若数量不为 0，先执行 `supabase-auth-config.md` 第 4 节的补齐 SQL。

---

## 四、当前限流额度一览

**全局（middleware，按 IP）**

| 类别 | 覆盖路径 | 额度 |
|---|---|---|
| 昂贵 | `/api/creative/*`、`/api/prompt-optimizer`、`/api/problem-solve`、`/api/upload-image`、`/api/export-data`、`/api/materials/retrieve`、`/api/ci/*` | 60 次/分钟 |
| 普通 | 其余 `/api/*` | 180 次/分钟 |
| 并发 | 上述昂贵路径 | 同时在飞 25 个 |

新增接口自动受保护——这是把限流放在 middleware 而不是逐个路由写的原因。

**按用户（各 AI 路由 `guardRateLimit`）**

| 接口 | 额度 |
|---|---|
| `/api/creative/work-agent/chat` | 20 次/分钟 |
| `/api/creative/patch/decide` | 30 次/分钟 |
| `/api/creative/interview` | 30 次/分钟 |
| `/api/creative/work-agent/session` | 30 次/分钟 |
| `/api/creative/patch` | 10 次/分钟 |
| `/api/creative/alignment` | 10 次/分钟 |
| `/api/creative/blueprint` | 5 次/分钟 |
| `/api/creative/analyze` | 5 次/分钟 |
| `/api/creative/analyze-feedback` | 5 次/分钟 |

---

## 五、部署检查清单

- [ ] Supabase "Confirm email" 已开启（**防批量注册薅积分的关键**）
- [ ] Supabase 注册限流已配（60s 冷却 / 5 次邮箱 / 10 次 IP）
- [ ] `UPSTASH_REDIS_REST_URL` + `TOKEN` 已配到部署环境（否则限流只在单实例生效）
- [ ] `AI_MAX_CONCURRENCY` 按实际规格调整（小规格 Serverless 建议下调到 10~15）
- [ ] 各 AI 路由的 `maxDuration` 与 `AI_TIMEOUT_BUDGET_MS` 满足
      `预算 = maxDuration × 1000 - 5000`
- [ ] 压测：并发触发 AI 接口，确认超限返回 503 而不是全部排队超时

---

## 六、故障排查

| 现象 | 排查方向 |
|---|---|
| 大量 429 | 检查是否有共享出口 IP（公司/校园网）；确认 Upstash 是否配置（未配置时额度会按实例数放大，反而更容易触发单实例上限） |
| 大量 503 | `AI_MAX_CONCURRENCY` 调得太低，或确实到了上游并发上限 |
| 限流"时灵时不灵" | 未配置 Upstash，各实例独立计数 |
| AI 失败但积分被扣 | `AI_TIMEOUT_BUDGET_MS` ≥ 路由 `maxDuration`，进程被平台杀掉导致退款代码未执行 |
| Redis 报连接错 | 会自动降级放行，不影响业务；但限流会退化为单实例计数 |
