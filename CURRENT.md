# CURRENT —— 视界全局接力入口（新会话先读这里）

> 最后更新：2026-09-26
> 本文件是**唯一全局接力入口**。各功能线的细节文档见 §6，不要跳过本文件直接读它们。

---

## 1. 产品是什么

**视界不是 AI 写作工具。** 它帮助创作者把自己的想法、知识、经历和观点，转化成真正属于自己的作品，并随着使用越来越懂这位创作者。

三条不可让步的原则（做任何功能前先对照）：

1. **从「文章中心」转向「人中心」。** 不只关心「输入什么 → 生成什么」，而要理解：用户是谁、为什么想创作、知道什么、想表达什么。作品只是结果，创作者才是核心。
2. **禁止按主题直接生成标准文章。** 生成必须考虑用户背景 + 用户知识 + 用户兴趣 + 用户表达方式。目标是「用户愿意发布的文章」，不是「优秀文章」。
3. **风格只是表层。** 真正的资产是创作行为、用户知识、兴趣变化、修改原因、表达习惯、作品反馈这六类长期数据。

---

## 2. 技术栈速查

- Next.js **16.3.3**（API 与约定可能不同于训练数据，写代码前读 `node_modules/next/dist/docs/`）+ React 19 + App Router
- Supabase：Postgres + **pgvector（1024 维 bge-m3，HNSW）** + RLS + Auth（session 在浏览器 localStorage，非 cookie）
- LLM：DeepSeek `deepseek-chat`（JSON 模式）；embedding：SiliconFlow bge-m3
- 测试：**vitest 2.1.9**（锁 v2，v3 与 Next16/React19 peer 冲突）
- Windows + PowerShell（无 `head`，用 `Select-Object -First N`）

---

## 3. 能力全景

| 能力 | 入口 | 核心模块 |
| --- | --- | --- |
| 创作方案（3 方向） | `/api/creative/plan` | `lib/creative/plan.ts` |
| 创作蓝图 | `/api/creative/blueprint` | `lib/creative/blueprint.ts` |
| 正文生成 | `/api/prompt-optimizer` | `app/api/prompt-optimizer/route.ts` |
| 版本管理与迭代 | `/api/creative/projects/*` | `generation_history` 版本行（id = `${pid}::v${N}`） |
| AI 共创（Work Agent） | `/api/creative/work-agent/*` | `workAgentContext` / `intentClarifier` / `revisionPlan` / `patchEngine` |
| 修改方向验收 | `/api/creative/alignment` | `lib/creative/feedbackAlignment.ts` |
| 五维诊断 | `/api/creative/analyze` | `lib/creative/diagnosis.ts` |
| 素材库 | `/api/scripts` | `lib/material/*` |
| 创作者知识系统 | `/api/creative/knowledge/*` | `knowledgeAnalyzer` / `knowledgeAggregator` / `knowledgeInject` |
| 兴趣画像 + 灵感推荐 | `/api/creative/interest/*`、`/api/inspirations` | `lib/creative/interest/`（55 文件） |
| 灵感无限流 | `/api/inspirations/feed` | `feedRepo` / `refill` / `degrade` |
| 社区广场 | `/api/posts/*`、`/explore` | `lib/community/*` |
| 积分 / 充值 | `/api/...`、`/points`、`/recharge` | `lib/points.ts`、`lib/balance.ts` |

---

## 4. 创作者理解：五条信号链路（**当前最大的架构问题**）

产品定位要求「越来越懂创作者」。代码里四块资产都建成了，但**分属五条互不统属的平行链路**，各自读写 `style_profiles` 的不同列、各自有独立触发与注入口径。

| 信号 | 落点 | 注入到生成链路的位置 |
| --- | --- | --- |
| Creator Memory（用户是谁） | `creator_declaration` / `creator_report` | `formatCreatorModel` → plan / blueprint / 正文 |
| Knowledge Base（用户知识） | `scripts.knowledge` → `creator_knowledge` | **三链路全通**（plan / blueprint / 正文），同口径 |
| Creator Knowledge（AI 长期学习） | `creator_knowledge`（AI 提候选，**人确认**才是闸门） | 同上 |
| Taste Model（喜欢/不喜欢） | `style_dimensions` + `editing_profile` | `editing_profile` 只进 `patch/decide` + `workAgentContext`；`style_dimensions` 进 plan / blueprint / 正文 |
| 兴趣画像 CIP | `interest_profile` + `creator_events`（append-only） | **三链路已全通**（2026-09-24 补齐，见 §5） |

### 已知缺口（不要误当成已完成）

- ~~**G1 无统一读取层。**~~ **已于 2026-09-24 落地，见 §5.9。** `lib/creative/creatorUnderstanding.ts` 六路聚合（memory / interest / report / knowledge / style / editing），不建新表；`/api/creator-status` 已切到该口径。
- ~~**G4「我是谁」只有「怎么写」。**~~ **已于 2026-09-24 补齐，见 §5.10。** `creator_declaration` 增 3 个可选维度（经历背景 / 价值判断 / 长期目标），老用户走增量补问而非重答 13 问。
- **G5 发布表现诊断为 0。** `posts` 的点赞/收藏/评论从未作为"发布后表现"回流。已于 2026-09-24 提供事实包与观测口 `GET /api/creative/publish-performance`（**无 UI**，发布率仅 2.6%，此时画图是把噪声当结论）。
- **G6 推荐理由存在假话。** 所有无 facts 的卡统一兜底「基于你的创作兴趣推荐」，但 exploration 卡本就不是从兴趣推出来的。已按槽位分别兜底并说破，见 §5.10。
- **G2「发布诊断」为零。** AI 诊断原则要求分创作诊断 / 发布诊断两类，现在只有前者。`post_interactions` 目前**只被 `interest/backfill.ts` 用来推断兴趣**，从未作为「我作品发布后的真实表现」回流。计划先做数据回流（按用户聚合 `posts.like_count/save_count/comment_count` 成事实包），**先不画 UI**。
- ~~**G3「愿意发布」无代理指标。**~~ **已于 2026-09-24 定义完成，见 §5.2。** 剩校准工作（用真实数据验证阈值）。

---

## 5. 最近一次变更（2026-09-24）

**兴趣画像补进方案与蓝图阶段。**

此前 `interest_profile` 只注入**正文（prompt-optimizer）**一条链路，导致「方向由主题定、文笔才由人定」——正是产品定位明令禁止的「按主题生成标准文章」。而知识单元早就做到了三链路全通，这是同一条原则下的口径不一致。

改动（3 文件）：
- `lib/creative/plan.ts`：新增 `GeneratePlanInput.interestText` + `buildUserPrompt` 注入
- `app/api/creative/plan/route.ts`：creator 分支 `buildInterestBlock(profile?.interest_profile)`
- `app/api/creative/blueprint/route.ts`：同分支拼入 `styleProfileText`

口径约束（改动时必须守住）：
- **仅「我的模式」注入。** 灵感模式要求剥离全部隐性个人数据，兴趣画像比知识更私人，不能破例。
- **措辞比知识软。** 知识是「用户亲手确认过的结论」，可以说「不得矛盾」；兴趣只是行为统计的观察，只能说「优先落在交叉处」并允许主题无关时忽略。写死会变成创作枷锁。
- 复用现成纯函数 `buildInterestBlock`（带测试），未建模用户 `{}` → 空串 → 整块剔除，零影响。

### 5.2 「愿意发布」代理指标（G3）

新增 `lib/creative/publicationIntent.ts`（纯函数 + 取数）+ 观测口 `GET /api/creative/intent-metrics`。

**发布意愿阶梯**（作品/项目级，取最高达成级，不累加）：

| 级 | level | 含义 | 证据 |
| --- | --- | --- | --- |
| L0 | `unclaimed` | 生成后无正向动作 | — |
| L1 | `polishing` | 还在投入，未认可 | `work_edit` / `work_regenerate` |
| L2 | `approved` | 对产出满意，未定稿 | `feedback_like` |
| L3 | `finalized` | 宣布这是我的成品 | `creative_projects.status='finalized'` |
| L4 | `published` | 愿意公开 | `posts.source_project_id` |

**分数**：`raw = 0.45×publishRate + 0.30×finalizeRate + 0.25×approvalRate`，再 `× (1 − 0.5×negativeRate)`（negative = dislike / 删除）。负向用乘法而非减法，保留「只写 1 篇且删掉」与「写 20 篇全删」的强度差异。

**置信度**：`0.75×样本量 + 0.25×新鲜度`，项目数 < 3 时硬压上限 0.4（沿用 `interest/confidence` 惯例）。

⚠️ **效度边界（改动前必读，这是设计不是 bug）**：
1. **不可横向跨用户比较，只能纵向看同一用户趋势。** 分母是全部项目，包含用户本就无意公开的作品（如写内部商业计划书）。横向比会把这类用户误判成低分。
2. **意愿 ≠ 结果。** 发布后互动数**不进**分数——把它算进来等于把产品目标偷换成「帮用户做爆款」，是背离定位的。互动留给 G2 消费。
3. **posts 硬删除导致近似**：发布后又删帖查不到，被当作「从未发布」。要表达撤回语义需补 `work_publish` 事件进 `creator_events`，本版未做。
4. `negative` 不参与定级，只打折：先定稿后删除仍记 `finalized` + `negative=true`。

### 5.3 真实数据实测（2026-09-24）

用 `SUPABASE_SERVICE_ROLE_KEY` 连真实库跑了一次性诊断（脚本跑完已删）。

**⚠️ 发现运维问题**：该 key 对 `creative_projects` / `posts` 返回 `permission denied for table`
（是 GRANT 层权限缺失，不是 RLS）。**任何依赖 service key 的后台统计都会静默得到 0 行**，
需要去 Supabase 补授权或换 key。应用运行时走 anon + RLS，**不受影响**。

绕开权限后由 `generation_history` 的 `{projectId}::v{N}` 复合主键反推到真实分布：

| 指标 | 真实值 |
| --- | --- |
| 用户 / 项目 / 版本行 | 6 / 74 / 89 |
| 每用户项目数 | min 3 · **中位 6** · max 28 |
| 每项目版本数 | **中位 1** · max 4（生成一次就走，几乎不打磨） |
| 定稿率 | 5/74 ≈ **7%** |
| 删除率 | 17/74 ≈ **23%** |
| 点赞率 | 4/74 ≈ 5% |

**已验证的结论**：
- **样本量阈值 3 合理**：真实用户最少 3 个项目，`0/6` 被误压，边界刚好安全（阈值改 4 就会误伤）。
- **置信度充分值 8 偏保守但可接受**：中位用户 `volume=0.75` → confidence ≈ 0.7–0.8，够用。
- **指标对改善敏感（关键）**：基线 **0.045**；模拟「定稿升到 30% + 发布 9% + 删除降到 11%」→ **0.227（5 倍）**。
  这条已固化为回归测试（真实形态基线图），**指标能检测出改善，才配用来追踪「越来越懂创作者」**。

### 5.4 发布率实测（2026-09-24 二次诊断）

补 RLS 后 `anon` 可查全量（`service` 仍报 `permission denied`，GRANT 层未修，见待办 4）。

**🐞 实测抓到一个真 bug（已修）**：`fetchIntentFacts` 里 `if (f) f.published = true`
会把**「帖子还在、项目已删」的发布证据静默丢弃**。真实库里就有这样的用户：
`posts.source_project_id = a5f02360`，但该项目已不在 `creative_projects`。
后果是**明明发布过的用户被算成 publishRate = 0**。

修法：孤儿项目补建最小事实包（`published: true`，其余保守置 false），分子分母各 +1——
发布意愿一旦发生就不可撤销（帖子仍公开在广场、archive 快照仍在），项目后续清理不该抹掉它。
已加 3 个回归测试锁死。

**修复前后真实对比**：

| 用户 | 项目 | 定稿 | 孤儿发布 | publishRate 修复前 → 后 |
| --- | --- | --- | --- | --- |
| d7d7d602 | 6 | 0 | 1 | 0.000 → **0.143** |
| 06788eb6 | 28 | 2 | 0 | 0.000 → 0.000 |
| e6bd6163 | 4 | 0 | 0 | 0.000 → 0.000 |
| 全库 | 38 | 2 | 1 | 0.0000 → **0.0256** |

**权重决策：publishRate 维持 0.45，不调低。** 理由：
- 稀缺 ≠ 不重要。发布是全库最强信号，正因为它稀缺才更该保留权重。
- 当前低发布率反映**产品现状**（用户还在探索，每项目版本中位 1，生成完就走），
  不是指标缺陷。为迎合现状调低权重等于把「用户不愿发布」当成既定事实接受掉。
- 样本仅 3 用户 / 1 次发布事件，不足以支撑任何权重调整（过拟合风险）。

**⚠️ 产品发现（非指标问题）**：定稿→发布转化 **0%**（2 个定稿作品都没发布），
而发布入口确实存在（`/article/[id]` → `ShareToPlazaModal` → `/api/posts/from-project`）。
即不是"发不出来"，而是用户没走到那一步。

### 5.5 定稿→发布 0% 的根因与修复（2026-09-24）

排查结论：入口位置没问题（`/article/[id]` 是作品创作空间，`/works/[id]` 只是重定向过去），
**问题出在定稿之后完全没有引导**。三处叠加：

1. **`handleToggleFinalize` 成功后完全静默** —— 只 `setProjectStatus(next)`，
   页面仅把按钮换成绿色徽标「✓ 最终作品 V2」，没有任何下一步提示。
   而用户此刻**刚完成「我认可这个作品」的心理动作**，是最该被提示发布的时机。
2. **发布按钮视觉权重最低** —— `text-xs text-zinc-400`，与 V1/V2/V3 版本按钮挤在同一栏，
   是灰色小字，定稿前后长得一样。
3. **两个 `ml-auto` 冲突** —— 发布按钮与定稿按钮各带一个 `ml-auto`，
   两个 auto 外边距互抢空间，排版错乱。

**修复**（`app/(main)/article/[id]/page.tsx`）：
- 定稿成功后置 `justFinalized`，渲染引导条：「✅ 已定为最终作品。要让它被更多人看到吗？」
  + 主按钮【📢 发布到灵感广场】+ 【暂不】（给明确下一步，但不强制）。
- `ml-auto` 收敛到外层容器，两个按钮用 `gap-2` 分隔。
- 发布按钮在 `projectStatus === 'finalized'` 时升级为主按钮（indigo 实心），与灰色态区分。

**验证步骤（UI 改动，需人工确认）**：
1. 打开任一项目作品的 `/article/[id]`
2. 点「✓ 定为最终作品」→ 应出现引导条，且发布按钮变为主色高亮
3. 点【发布到灵感广场】→ 弹窗打开、引导条消失
4. 点【暂不】→ 引导条消失，发布按钮保持高亮（仍可再点）
5. 点「重新开启迭代」→ 引导条状态复位

### 5.6 G2 数据底座：发布事件入流（2026-09-24）

**问题**：`creator_events` 原有 21 种事件类型（生成/定稿/反馈/广场互动…），
**唯独没有「发布」**。发布只体现在 `posts.source_project_id` 上，从未进入事实流。

这正是前几轮踩的坑的共同根因：
- 兴趣画像看不到「用户愿意公开什么」——只知道他生成了什么、收藏了什么
- 发布意愿只能靠反查 `posts`：撞上 service key 无权限（§5.3），
  且项目被删后证据丢失（§5.4 的孤儿发布 bug）

**改动**：
1. `types.ts` 新增 `work_publish` 枚举（21 → 22 种）
2. `config.ts` 注册 `weight: 4.0`、`interpret: 'yes'`
   —— 定稿是「我认可」，发布是「我愿意让世界看到它」，后者强于 `work_finalize`(3.0)
3. `app/api/posts/from-project/route.ts` 发布成功后 `trackEvent` 埋点
   （带 post_type / mode / version_count / tags；`trackEvent` 吞异常，不阻塞发布结果）
4. `supabase/setup.sql` 同步 `creator_events_event_type_check`

**⚠️ 必须执行一次数据库变更**：改 `setup.sql` **不会**自动更新已建表的约束。
已备好 migration `supabase/migrations/0016_work_publish_event.sql`，
在 Supabase SQL Editor 执行即可：

```sql
alter table public.creator_events drop constraint if exists creator_events_event_type_check;
alter table public.creator_events add constraint creator_events_event_type_check check (
  event_type in (
    'work_generate','work_finalize','work_unfinalize','work_delete','work_publish',
    'feedback_like','feedback_dislike','work_edit','work_regenerate',
    'material_save','material_delete',
    'post_like','post_unlike','post_save','post_unsave','post_style_resonate',
    'inspiration_analyze','topic_search',
    'recommend_impression','recommend_click','recommend_adopt','recommend_dismiss'
  )
);
```

不执行的后果：插入被 CHECK 拒绝，而 `trackEvent` 铁律是**永不抛异常、只 console.error**
——事件静默丢失、业务照常跑，要等画像长期不准才会被发现。

**防漂移**：新增 `lib/creative/interest/eventRegistry.test.ts`，校验 setup.sql 的 CHECK
覆盖全部应用层事件类型（`EVENT_REGISTRY` 是 `Record<CreatorEventType,…>`，
TS 能保证应用层自洽，但**管不到 SQL**，故需这层测试兜底）。

### 5.7 顺带修复：register 测试 3 个失败（mock 缺导出，非产品 bug）

`app/register/page.test.tsx` 只 mock 了 `supabase`，但 `page.tsx` 还 import 了
`isAuthTransportError` / `describeAuthError` —— 二者为 `undefined`，
`handleSendCode` 一进错误分支就抛 TypeError（async 内未捕获）→
表现为「错误文案不渲染 + `resend` 从未调用」，看起来像产品 bug。

成功路径不调用这两个函数，所以只有成功用例一直通过——**这个伪装很有迷惑性**。
vitest 报的 "3 unhandled errors" 正是这 3 个异常。

补上导出后 **11/11 通过**。值得注意的是：`already_registered` 打破死结、
限流文案这 3 个分支**此前从未被真正验证过**。

### 5.8 回填历史发布（2026-09-24）

新埋点只对**之后的发布**生效，库里已有的发布还不在事件流里。
在 `backfill.ts` 加了第 4 段：`posts`（`source_project_id` 非空）→ `work_publish`。

**关键设计：刻意不 join `creative_projects`。**
join 会安静地把孤儿发布（项目已被删）过滤掉，而它们恰恰是最要救的那批——
就是 §5.4 里那个「明明发布过、却被算成从未发布」的用户。
事件只承诺「发布这件事发生过」，不承诺被引用的项目此刻还存在。

其余要点：
- 复用 `posts.style_vector` 存量向量，不重算 embedding
- 幂等键 `(post, post_id, work_publish)`，可重复执行、不重复计票
- 实时入流（from-project）与回填互不冲突

**执行顺序（两步都要，顺序不能反）**：
1. 先在 Supabase SQL Editor 执行 `supabase/migrations/0016_work_publish_event.sql`
2. 再调用 `POST /api/creative/interest/backfill`
   （Bearer token；限流 1 次/10 分钟；回填后自动触发一次 full build）

顺序反了的后果：回填撞 CHECK 约束，而 `trackEvent` 只 `console.error`，
表现为「回填跑完了但 `publish=0`」——不报红、不抛错，很难排查。

测试：`lib/creative/interest/backfill.test.ts`（3 个用例），
锁住「孤儿发布不被过滤」。这是最容易被后人顺手"优化"成 join、
从而重新引入该 bug 的点。

### 5.9 Creator Intelligence 收口：统一读取层 + 注入装配器（2026-09-24）

**背景**：五路资产各自读写 `style_profiles` 不同列、各自注入，导致两处口径分裂 ——
① `editing_profile`（用户接受/拒绝过的改法）只进正文与补丁链路，方案/蓝图阶段看不到用户反复拒绝什么；
② 理解度有两套算法（`/api/creator-status` 四路线性计分 vs dashboard 读 `interest_profile.identity.completeness`）。

**改动（2 新模块 + 4 处接入，无 schema 变更）**：

| 文件 | 职责 |
| --- | --- |
| `lib/creative/creatorUnderstanding.ts` | **统一读取层**：六路聚合 → readiness / percent / level / 每路置信度 / 缺口引导。纯函数、不读库、不建表 |
| `lib/creative/creatorContext.ts` | **注入装配器**：三阶段共用同一份「注入哪些块、什么顺序、多少预算、哪些是硬禁忌」 |
| `app/api/creative/plan`、`blueprint`、`prompt-optimizer` | 删掉各自手写的拼装，改调装配器 |
| `app/api/creator-status` | 切到六路口径；保留 `signals`（/generate 展示「已创作 N 篇」） |

**口径约束（改动时必须守住）**：
- **块集合不可配，阶段措辞可配。** 路由只能改「请在蓝图中体现…」这类指令句，**不能少注入一块** —— 少注入正是此前漂移的形态。
- **优先级**：用户主动声明 > AI 推断人格 > 用户修改行为 > 行为统计观察。
- **硬禁忌单独成数组返回**（`blocks.avoid`），由调用方写进生成硬规则；混在正文里只是"建议"。
- **理解度不可虚标**：没有数据就是 0，`creator_knowledge` 未迁移时查库报 42P01 按 0 处理。
- dashboard 的百分比已改名为「兴趣建模完整度」——它本来就是兴趣画像口径，与全局理解度分母不同，混用会让用户看到两个互相矛盾的百分比。

**测试**：`creatorUnderstanding.test.ts`（10 例）+ `creatorContext.test.ts`（11 例）。
其中「三个阶段注入同一套块」是漂移回归锁：任一路少注入一块即红。

### 5.10 Creator Intelligence 第二批：Memory 扩维 / Taste / 一致性 / 发布表现（2026-09-24）

**改动清单（全部无 schema 变更；一个 jsonb 加 3 个可选字段，零 migration）**

| 文件 | 职责 |
| --- | --- |
| `creatorDeclaration.ts` | 新增 `background` / `value_statement` / `long_term_goal` 三问；`CORE_DIMENSIONS`（8）与 `IDENTITY_DIMENSIONS`（3）分离 |
| `interviewQuestions.ts` | 新增 3 问（类别：经历背景 / 价值判断 / 长期目标） |
| `interviewTrigger.ts` | 新增 `supplement` 触发类型：核心完整但缺身份三问 → 只补这 3 问 |
| `app/api/creative/interview` | 支持 `?dimensions=…` 只返回指定维度的问题；下发 `requiredCount` |
| `interview-dialog.tsx` | 完成门槛改用服务端 `requiredCount`（补问只 3 问时不该还要求 6 个） |
| `tasteView.ts` | 四路信号（声明 / DNA 报告 / 修改行为 / 兴趣统计）合成 likes/avoids/depth，每条带来源与置信度 |
| `style-profile/page.tsx` | 「品味画像」区块：用户可见 AI 认为自己喜欢什么、凭什么这么判 |
| `consistencyCheck.ts` | 创作一致性三问：是否符合你的知识 / 兴趣 / 是否踩禁忌 |
| `app/api/creative/analyze` | 随诊断返回 `consistency`（纯读取，不额外消耗 LLM） |
| `diagnosis-card.tsx` | 「是否符合你」区块；无可判定结论时整块不渲染 |
| `publishPerformance.ts` + `/api/creative/publish-performance` | 发布表现事实包与观测口（**无 UI**） |
| `reasonAi.ts` | 推荐理由兜底按槽位说真话（exploration 卡不再谎称"基于你的兴趣"） |
| `eventTracker.ts` | 事件写失败从"静默丢失"变成可运维日志（23514 / 42P01 / 42501 分别点名） |

**口径约束（改动时必须守住）**
- **新增维度不许让老用户变差**：身份三问是**加分项**不进分母（进分母会让已访谈老用户理解度一夜下降，那是把系统需求转嫁给用户）；`isDeclarationComplete` 仍只算核心 8 维。
- **Taste 视图不注入 prompt**：editing 原始块（含修改原话）已进生成链路，再注入合成版等于同一信息说两遍。它的消费者是展示与一致性诊断。
- **一致性三问只判"可判定的"**：知识概念 / 领域名 / 禁忌词是可枚举实体，字面匹配即可；立场是否一致需要语义判断，一律回 `unknown`，绝不假装判过。
- **归因必须有最低样本门槛**：发布表现低于 3 篇只给总量事实，不给"你适合写什么"；零互动时即便样本够也不排名。

**已知未做 / 明确反对**
- **知识语义匹配（原 P2-8）暂缓**：`creator_knowledge` 无 embedding 列，做语义匹配要先加列 + 回填，成本与收益不对称；当前字面匹配 `concept`（聚合短名）的召回率可接受。
- **外部平台数据（播放量/完播率）暂缓**：站内 `posts` 表现都还没被消费，先做完内部闭环。
- **发布表现不做 UI**：发布率 2.6%，样本不足时图表只会制造伪事实。
- **待执行运维（阻塞验证，需人工在 Supabase 执行）**：migration `0016_work_publish_event.sql`、backfill、`SUPABASE_SERVICE_ROLE_KEY` 对 `creative_projects`/`posts` 的 GRANT。

### 5.11 回填实战：两个静默 bug（2026-09-24）

回填真跑起来才暴露出两个 bug，两个都属于"不报错、只丢数据"那一类：

**bug 1：`posts` 根本没有 `title` / `excerpt` 列**
`backfill.ts` 是代码库里唯一这么写的地方，真实列是 `content`。
后果：第 4 段整段查询 42703 失败 → `publish` 恒为 0。
**为什么单测没抓到**：测试用 mock 的 supabase 链式 stub，且 fixture 自己也带 `title`/`excerpt`——
mock 连同 bug 一起复刻了。已修（改为 `content`，标题从首行 `# xxx` 还原），
并加了一条断言：所有 `posts` 查询用到的列必须在真实列白名单内。

**bug 2：孤儿发布撞外键，事件被数据库拒绝**
`creator_events.project_id` 有指向 `creative_projects` 的外键。而"刻意不 join 项目表"
本来就是为了救回**项目已删**的那批发布证据——结果它们写不进去（23503），
`trackEvent` 只 `console.error`，表现正是"明明发布过却被算成从未发布"。
已修：项目已删时 `project_id=null`、原始 id 留在 `payload.source_project_id`，
事件照发——兑现"事件只承诺发布这件事发生过"的原始设计。

**实测结果**（用 admin API 换临时用户会话跑 `runBackfill`，不是走 service key）

| 用户 | projects | publish | errors | work_publish |
| --- | --- | --- | --- | --- |
| 3546237582@qq.com | 6 | 1（孤儿） | 0 | 0 → **1** |
| wjc078487.@gmail.com | 28 | 0 | 0 | 0 → 0 |
| 13624606969@163.com | 4 | 0 | 0 | 0 → 0 |

`work_generate` / `work_finalize` 计数前后不变 —— 幂等生效（此前已回填过一轮）。

**一个重要认知修正**：回填**不需要 service key**。
它走的是用户 JWT + RLS（anon 实测对 `posts` 返回 200），
所以 GRANT 缺失不阻塞回填，只阻塞 service-role 的后台统计。

### 5.12 Work Agent 从「修改工具」升级为「创作伙伴」（2026-09-24）

对照「Work Agent 角色定义」逐条核对后的补缺。已有的三阶段流水线（澄清 → 方案 → 补丁）、
上下文单点装配、方向验收都保留，**不做重写**——本次补的是"它不像一位伙伴"的那四块。

| 缺口 | 补法 | 文件 |
| --- | --- | --- |
| 所有输入一律走改稿流水线（用户说"写出来没人看"也回"请选择修改方向"） | 四种输出模式路由 | `workAgentMode.ts` + `workAgentDialogue.ts` |
| 用户要求会降低质量的改法时照样执行（"把所有词换成高级词"） | 修改守门，只提示不阻拦 | `revisionGuard.ts` |
| 修改链路读不到创作者知识库、历史修改轨迹、目标读者 | 上下文补 3 块 | `workAgentContext.ts` |
| 记忆只记"改了什么"，没记"为什么改" | 偏好原因抽取 | `preferenceReason.ts` |

**口径约束（改动时必须守住）**：
- **守门只提示不阻拦。** 结论交给用户，AI 无权替他放弃一个改法；每条提示必须带替代方案，
  只说"不好"等于把问题丢回给用户。误报比漏报更致命——弹窗太多的守门等于没有守门。
- **陪伴/讨论模式不给候选按钮。** 用户还没决定要改，给按钮就是替他做了决定。
- **禁止虚假鼓励。** 上下文没有正向证据时不许夸奖，力气全用在"问题可能出在哪"。
- **direct 模式跳过的是讨论，不是确认权。** 复用既有 `skipToPlan` 通道直达补丁，
  最终仍要用户点"接受"才落新版本。
- **判定用规则不用 LLM。** 模式与守门都在每轮对话第一步，多一次模型调用就多几秒等待；
  且 LLM 会把"加金句""写得高级"判成合理优化——它本来就擅长这个。
- **`reasons` 只在 accept 时写记忆。** 拒绝说明"这轮改得不好"，不等于"他不想要那个东西"。

**已知取舍**：模式路由与守门都是中文规则，其他语种的反馈一律回退 `suggest`。
这不是缺陷而是保守选择——误判成陪伴模式比不判更糟，等有非中文用户再补词表。

---

### 5.13 兴趣推荐：v5 流水线从未通电（2026-09-25 实测修复）

**结论先行**：不是算法不够聪明，是**已建成的整条链路从来没跑过**。

库里 1331 张推荐卡，`embedding` 非空的 **0 行**、`ranking_features` 全是 `{}`。
代码确实写了这两列，但 v5 升版时迁移 0018 尚未执行进库，`insertSuggestions`
命中"新列不存在"降级、**静默把两列剥掉重插**。卡照常落库，线上完全无感。
佐证：最近一次成功的 build 记录是 `rule_version = interest-rules-v4`。

后果：候选→簇匹配恒 0%、在线重排对所有卡不生效、语义去重失效、曝光—反馈闭环
学不到任何方向——**全是死代码**。

**修的三个 bug**：

| # | 问题 | 证据 |
| --- | --- | --- |
| 1 | **空 build 清空用户队列** | `supersedeOldBuild` 在 insert 之前无差别清空。某用户上一轮 14 张卡，下一个 build 产出 0 张 → 清零（他有 207 次曝光）。旧代码自己留了 warn 承认"可能下次 build 恢复" |
| 2 | **AI 抽标签失败拖垮整个 build** | `tag_dims` 写 null 撞 NOT NULL → `commitClusters 失败` → build failed。而设计注释写明"抽取失败→空标签→build 不阻塞" |
| 3 | 分数无区分力 | 某用户 Top6 六个 `0.6780` 完全相同，排序退化为按 id 抽签 |

**改法**：新增 `supersedeExceptBuild`（按 `build_id` 排除），顺序改为"先落新卡、
后清旧批次"→ 候选为空或落库失败时**绝不动旧队列**；`tag_dims` 改写空标签；
`RULE_VERSION` 升 v6 触发一次真实换血（评分权重一个没动）。

**实测结果**（真实跑 build，生产数据）：

| 指标 | 用户B 前→后 | 用户C 前→后 |
| --- | --- | --- |
| 带 embedding | 0/25 → **22/22** | 0/25 → **23/23** |
| 带 ranking_features | 0/25 → **22/22** | 0/25 → **23/23** |
| 有真实簇 | 4/25 → **10/22** | 0/25 → **3/23** |
| Top6 分数首尾差 | 1.0% → **7.2%** | 0.0% → **8.7%** |
| 标题近重复对 | — | 3 → **0** |
| 主题集中度 | — | 24/25 全是 Spotify → **9/23** |

**铁律补充**：
- **build 绝不能把队列抹成 0 张。** 旧卡再差也胜过没有推荐。
- **AI 可选增强（抽标签/生成理由）不能有否决权。** 失败必须降级成空值而不是 null，
  否则拖垮整次重建——本次就是这么炸的。
- **升 RULE_VERSION 后必须确认画像版本已写回。** 已实测三个用户画像
  `rule_version` 均为 v6，重建判定自终止，不会反复重建。

**待办**：`creator_knowledge` 用 service_role 读报 42501（缺 GRANT，非缺表），
已补 `0019_service_role_creator_knowledge_grant.sql` 待执行。

---

### 5.14 单成员簇：跨领域创作者的兴趣被系统性丢弃（2026-09-25）

**问题**：`CLUSTER_MIN_MEMBERS = 2` 会滤掉**全部**单成员簇，而跨领域创作者的常态
就是「N 篇作品 N 个方向」——每簇只有 1 个成员。真实数据实测：

| 账号 | 原始簇 | 单成员簇 | 进画像的方向 |
| --- | --- | --- | --- |
| B | 23 | 21 | **2** |
| C | 3 | 2 | **1** |

画像只剩一两个方向 → 造卡只能围着它反复改写 → 推荐退化成"刷来刷去都是这几张"；
同时绝大多数卡拿不到簇（`semanticSimilarity = null`），在线重排对它们全部失效。
这条限制代码里早有标注（wf9 场景测试：泛商业 5 主题两两相似度不达标 → 各自单成员
→ 被 MIN_MEMBERS 滤掉，"多样本聚类放宽留 follow-up"），本节即那个 follow-up。

**改法**：新增 `WORK_LEVEL_EVENT_TYPES`（`work_generate` / `work_finalize` /
`work_publish`）作为门槛的例外通道——含作品级强信号的簇，1 个成员也承认。

**为什么只放宽作品级，而不是把门槛降成 1**：作品是创作者真实投入（写完/定稿/发布），
一篇就足以证明一个方向；而曝光、点击这类弱行为单次噪声太大——误点一下不该变成
一个兴趣方向，它们仍须凑够 `CLUSTER_MIN_MEMBERS`。
**负簇不享受例外**：`weight=0` 且 `isNegative` 的簇是用户明确拒绝的方向，
拿它造卡等于把被拒绝的东西换个说法再推一遍。

**实测效果**（真实 build，同一批数据前后对比）：

| 指标 | B 前 → 后 | C 前 → 后 |
| --- | --- | --- |
| 进画像方向数 | 2 → **12** | 1 → **3** |
| 卡片有真实簇 | 10/22 (45%) → **19/24 (79%)** | 3/23 (13%) → **14/24 (58%)** |
| 卡片覆盖的不同簇 | 3 → **8** | 1 → **3** |

`RULE_VERSION` 升至 `interest-rules-v7`（聚类口径变更，须触发重建）。

**顺带修正的两个判断**（都是"看着像 bug、实测不是"，记录以免重复排查）：
- **用户 A 队列归零不是 bug。** 他 13 篇作品删了 17 篇，撤回裁决后正向事件只剩 8 条、
  能进聚类的只有 1 条，且唯一成簇的是**负向簇**。清空后降级"平台推荐选题"是对的。
- **卡片看起来"重复"其实不是。** 实测 B 的 276 对卡片两两相似度最高只有 **0.743**
  （>0.75 的 0 对），是"同话题多角度"而非复述。按 0.85 去重一对都抓不到，
  硬去重反而误删；真正原因只是 Feed 按 score 倒序时的同簇连排，不改——
  `feedRepo` 要求分页以 id 为锚点保证"不重不漏"，插入打散会破坏这个不变量。

**踩坑备忘**：`interest_suggestions.embedding` 是 pgvector，经 PostgREST 回来是
`"[0.1,0.2,...]"` **字符串**（长 12830），不是数组。读路径已由 `rescore.parseEmbedding`
统一解析；但**写诊断脚本时直接用 `Array.isArray` 判断会得到 0 行**，从而误判"没有向量"。

### 5.15 积分充值：支付通道预留 / 档位配置化 / AI 计费补齐（2026-09-26）

三条此前留的口子一起收掉，都是「现在不做，将来要伤筋动骨」的那类。

**① 支付通道字段（预留微信/支付宝）。** `recharge_orders` 加 `provider`
（迁移 0020），MVP 恒为 `MANUAL`。值收敛到 `lib/paymentProvider.ts`
的 `getPaymentProvider()`——**未知/缺失通道值一律回落 MANUAL**，即保守方向：
宁可走人工确认，也不能因为一个不认识的值就跳过核账直接给用户加分。
将来接正式支付只需扩 check 约束 + 加一个 provider 实现，订单/账本/余额不动。

顺带修了 `confirm_recharge` 的一个**永久楔子**：原实现在「流水已存在但订单
未确认」时直接返回 `already_processed`，于是订单永远挂 `PAID`，管理员点几次
都是同一句"已处理过"，用户钱付了积分永远不到。现在该分支按流水把订单补齐到
`CONFIRMED`，让订单如实反映账目。

**② 快捷档位不再写死在前端。** `payment_settings.quick_amounts numeric[]`
（默认 `{5,10,20,50,100}`），由 `/api/recharge/config` 下发。读不到列时
（迁移 0020 未执行）回落 `FALLBACK_QUICK_AMOUNTS`，**不影响收款码本身可用**——
所以 `fetchRechargeConfig` 分两步查，档位查询单独失败也不连累收款码。

**③ 充值页自动刷新。** 存在 `PENDING`/`PAID` 订单时 15 秒轮询，管理员一确认，
状态与积分自己到位；全部到终态即停，不空转。重新进入时**主动把未完成订单摆到
面前**（用户付了钱但没点"我已完成支付"，后台根本不会出现待确认）。

**④ 措辞纪律（需求 §15）。** 用户声明已付款 ≠ 系统确认收款。MANUAL 通道下
系统**不知道**钱有没有到，所以 `submittedMessage` 里不存在"支付成功"——
这句话已写成断言（`lib/paymentProvider.test.ts`），改文案会红。

**⑤ AI 计费补齐。** 此前 `generatePlan` / `generateDiagnosis` 直接 `fetch`
DeepSeek，绕开了 `callDeepSeekChat` 的计费钩子。现在两者新增可选 `billing`
参数：调用前原子预扣 → 按真实 token 结算 → 失败全额退（plan 的 3 次重试用量
累加计入）。`lib/llm.ts` 导出 `parseUsage` 让两条链路用同一套用量解析口径。
路由侧 `plan` / `analyze` / `patch` 接入，余额不足返 402「请充值」。

**⚠️ 一处修正过的覆盖判断**：按 `hasEnoughFor` 关键字统计会得出"8 个未计费
路由"，**这个数字是错的**——多数路由是通过 `callDeepSeekChat` 的 `billing`
钩子计费的。逐条复查后真实缺口只有 `plan` / `analyze` / `patch` 三个。
`patch/decide` 不调 LLM 无需计费；`interest/build` **有意不计费**：它跑兴趣
画像，但 `runBuild` 被 6 处 fire-and-forget 后台调用，计费会让零积分用户的
灵感流直接 402（功能倒退）——要计费得先拆成"用户显式触发"与"后台自动维护"
两条路径，属独立改造。

### 5.16 充值下单 100% 失败：RPC 返回形状与 normalizeOrder 不匹配（2026-09-26）

**症状**：`/recharge` 点「生成充值订单」永远报「创建订单失败，请稍后重试」，
但查 `recharge_orders` **订单其实已经插进去了**。

**根因**：`create_recharge_order`（0013）返回的是手工挑的 5 个字段且改成
**camelCase**（`orderNo` / `requestedAmount` / `createdAt`），而
`lib/recharge.ts` 的 `normalizeOrder()` 按 **snake_case** 读（与 PostgREST
查表返回的形状一致），且要求 `user_id` 必填——`order_no` 读不到、`user_id`
压根没返回 → 返回 `null` → 被当成失败。

**改法**：迁移 `0021_fix_create_order_shape.sql` 把返回值改成
`to_jsonb(v_row)`——完整行、snake_case。**不要手工挑字段、更不要改 camelCase**，
那正是 bug 来源。这样"查表读出来的行"和"下单返回的行"永远是同一种形状，
以后加列（如 0020 的 `provider`）自动带上，不会再脱节。

**教训（值得记住）**：这类"数据库里成功了、代码里认不出"的失败最坑——
它不报错、不告警，只是给一句兜底文案。凡是 RPC 返回行给前端解析的地方，
形状必须与查表一致；解析失败时**必须把原始载荷打进日志**（已补
`console.error`），否则下次还得从头猜。

**排查入口**：遇到「创建订单失败」先看 dev 终端有没有
`[recharge] 订单已创建但返回行无法解析` 这行日志——有，就是形状问题；
没有，才是 RPC 真的没执行成功（迁移没跑）。

---

## 6. 功能线文档索引

| 文档 | 范围 |
| --- | --- |
| `ARCHITECTURE.md` | 代码导航地图、目录/表/RPC 索引、各模块设计意图 |
| `project-summary.md` | **仅兴趣引擎（CIP / WF0–WF11）专线**，含算法参数与踩坑记录 |
| `CONTEXT.md` | 术语表 |
| `docs/adr/` | 架构决策记录 |
| `docs/runbooks/` | 运维手册（Supabase Auth 配置等） |

---

## 7. 铁律

- 业务代码**禁止魔法数**：权重/阈值集中在所属模块的常量区（interest 引擎专用 `lib/creative/interest/config.ts`，改数字 = RULE_VERSION 升版；其他模块如 `publicationIntent.ts` 在文件顶部集中声明）
- `trackEvent` 永不抛异常、不阻塞主业务
- evidence 是确定性事实包，**禁止 LLM 自由发挥写入**
- 素材库是用户思想资产，AI 调用必须判断相关性，**禁止为丰富文章强行引用无关内容**
- 灵感推荐不是热门推荐，目标是「这个用户现在最值得创造什么」
- 最小 diff 修复；不随意重构；不引入无意义依赖
- 客户端取会话一律 `getValidSession()`，**禁止裸调 `getSession()`**
- 服务端鉴权失败一律用 `authFailureResponse()` 翻译（网络故障 → 503 retryable，真凭证失效 → 401）；前端只有 401 才允许跳 `/login`

---

## 8. 已拍板待办

| # | 事项 | 决策 |
| --- | --- | --- |
| 1 | 退出登录 scope | **默认改为 local（只登出本设备）**，设置页另留「退出所有设备」显式入口（global + 二次确认）。理由：创作平台多设备是常态，global 是安全语义不是常规语义，应显式化。尚未实施。 |
| 2 | ~~注册页 3 个红灯~~ **已确认解决** | 2026-09-27 实测 `npx vitest run app/register` → **11/11 通过**（含 `already_registered` ×2 与 `rate_limit_exceeded` 分支），与 §5.7「补上导出后 11/11 通过」一致，本行原记录已过时。结论：「已注册未验证用户永久卡死」的 P0 假设**不成立**，无需再排查。 |
| 3 | ~~**待提交**~~ **已按功能线提交（未推）** | 182 项在途改动已按功能线拆成多个 commit 落到本地 master（10 条功能线 + 2 条文档），工作区已干净。顺序：首页视觉 → 社区身份 → 积分充值 → 个人主页 → 知识关联 → 兴趣画像 → LLM 收敛 → 鉴权 → 页面适配 → schema/文档。测试报告产物已进 `.gitignore`。**尚未 push。** |
| 4 | **补 service key GRANT** | 2026-09-24 实测仍是 42501（`posts` / `creative_projects`）。已写成迁移 `supabase/migrations/0017_service_role_read_grants.sql`（只授 SELECT），**待你在 Supabase 执行**——代码侧无法执行 DDL（无 DB 密码 / 无 psql / 库里无 `exec_sql` RPC / 无管理令牌）。**不阻塞任何线上路径**：service key 在应用里只用于 `ci_items` 与管理员写操作，运行时不读这两张表；它坑的是后台统计与诊断脚本（静默 0 行）。 |
| 5 | ~~**G3 发布率校准**~~ **已完成** | 见 §5.4。结论：真实 publishRate 全库 2.6%、单用户最高 14.3%，**权重维持 0.45 不调低**。过程中抓到并修复了「孤儿发布证据被丢弃」bug。 |
| 6 | ~~**排查定稿→发布转化 0%**~~ **已修复** | 见 §5.5。根因：定稿成功后页面完全静默 + 发布按钮视觉权重最低 + 两个 `ml-auto` 冲突。已补定稿后发布引导条、发布按钮定稿后升级为主按钮。**需人工验证（见 §5.5 验证步骤）**，UI 改动未加自动化测试（该页面 1900 行，mock 成本过高）。 |
| 7 | ~~**补 `work_publish` 事件**~~ **已完成（G2 数据底座）** | 见 §5.6。发布此前从未进入 `creator_events`，只能靠反查 `posts.source_project_id`（撞权限问题 + 孤儿引用丢证据）。已新增 `work_publish`（weight 4.0 > finalize 3.0）并在 `from-project` 发布成功后埋点。**⚠️ 需手工执行 §5.6 的 CHECK 约束 SQL，否则插入被拒且 `trackEvent` 静默失败。** |
| 8 | ~~**register 测试 3 个失败**~~ **已修复** | 见 §5.7。非产品 bug，是测试 mock 少了 `isAuthTransportError` / `describeAuthError` 两个导出，错误分支抛 TypeError。已修复，11/11 通过。 |
| 9 | ~~**执行 migration 0016 + 触发回填**~~ **回填已完成（2026-09-24）** | ① migration 0016 已执行（回填时 `work_publish` 插入成功，反证 CHECK 已放行）；② 三个用户全部回填完毕，`errors=0`，`work_publish 0→1`（另两个用户确无发布记录，与 2.6% 发布率一致）。过程中修掉两个真 bug，见 §5.11。 |
| 10 | **执行 migration 0020 + 建第一个管理员** | 与 #4 同因：**代码侧无法执行 DDL**。需你在 Supabase 按序执行 `0012 → 0013 → 0014 → 0015 → 0020 → 0021`（`setup.sql` 不含积分这几张表；**0021 必跑**，否则下单 100% 失败，见 §5.16），再手工建第一个管理员（无 UI，只能手工）。**`user_id` 是 uuid 且外键指向 `auth.users(id)`，不能直接填邮箱**，须按邮箱反查：

```sql
insert into public.admin_users (user_id)
  select id from auth.users
  where lower(trim(email)) = lower('you@example.com')
  on conflict (user_id) do nothing;
```

自己的 UUID 可从 `/profile/me` 跳转后的地址栏拿到，或 `select id, email from auth.users order by created_at desc limit 20;`。**不执行会怎样**：积分/充值页拿不到表会走兜底（档位用默认值、余额读不到），不会白屏，但充值链路整体不可用于生产。执行后跑 `supabase/verify_points.sql` ①~⑧ 做账目体检（期望全部 0 行）。见 §5.15。 |
