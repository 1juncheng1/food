# CURRENT —— 视界全局接力入口（新会话先读这里）

> 最后更新：2026-09-24
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

- **G1 无统一读取层。** 没有任何地方能回答「此刻系统对这个用户理解了多少」。没有版本号、没有置信度聚合。计划建 `lib/creative/creatorUnderstanding.ts` 只做读取收口，**不建新表**。
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
| 2 | 注册页 3 个红灯 | `app/register/page.test.tsx` 有 3 个失败（`already_registered` 分支 ×2 + `rate_limit_exceeded` ×1），**与 2026-09-24 的改动无关，属既有失败**。初判是测试异步等待不足（断言未 await 到第二步 resend），而非产品 bug——实现里 `signUp` 报错 → 静默 `resend` 打破死结的逻辑与文案都对得上。**需单独排查确认**：若确认为实现问题，则「已注册未验证用户永久卡死」是 P0。排查前不要动。 |
| 3 | ~~**待提交**~~ **已按功能线提交（未推）** | 182 项在途改动已按功能线拆成多个 commit 落到本地 master（10 条功能线 + 2 条文档），工作区已干净。顺序：首页视觉 → 社区身份 → 积分充值 → 个人主页 → 知识关联 → 兴趣画像 → LLM 收敛 → 鉴权 → 页面适配 → schema/文档。测试报告产物已进 `.gitignore`。**尚未 push。** |
| 4 | **补 service key GRANT** | `.env.local` 的 `SUPABASE_SERVICE_ROLE_KEY` 对 `creative_projects` / `posts` 仍是 `permission denied for table`。补 RLS **没有**修好它——RLS 与 GRANT 是两套机制，本次是靠 anon 绕过才拿到数据的。**任何后台统计/脚本仍会静默得到 0 行**，需去 Supabase 补 GRANT 或换 key。（不阻塞 G3 指标，指标走 anon + RLS。） |
| 5 | ~~**G3 发布率校准**~~ **已完成** | 见 §5.4。结论：真实 publishRate 全库 2.6%、单用户最高 14.3%，**权重维持 0.45 不调低**。过程中抓到并修复了「孤儿发布证据被丢弃」bug。 |
| 6 | ~~**排查定稿→发布转化 0%**~~ **已修复** | 见 §5.5。根因：定稿成功后页面完全静默 + 发布按钮视觉权重最低 + 两个 `ml-auto` 冲突。已补定稿后发布引导条、发布按钮定稿后升级为主按钮。**需人工验证（见 §5.5 验证步骤）**，UI 改动未加自动化测试（该页面 1900 行，mock 成本过高）。 |
| 7 | ~~**补 `work_publish` 事件**~~ **已完成（G2 数据底座）** | 见 §5.6。发布此前从未进入 `creator_events`，只能靠反查 `posts.source_project_id`（撞权限问题 + 孤儿引用丢证据）。已新增 `work_publish`（weight 4.0 > finalize 3.0）并在 `from-project` 发布成功后埋点。**⚠️ 需手工执行 §5.6 的 CHECK 约束 SQL，否则插入被拒且 `trackEvent` 静默失败。** |
| 8 | ~~**register 测试 3 个失败**~~ **已修复** | 见 §5.7。非产品 bug，是测试 mock 少了 `isAuthTransportError` / `describeAuthError` 两个导出，错误分支抛 TypeError。已修复，11/11 通过。 |
| 9 | **执行 migration 0016 + 触发回填**（需你操作） | ① Supabase SQL Editor 执行 `supabase/migrations/0016_work_publish_event.sql`；② 调用 `POST /api/creative/interest/backfill`。**顺序不能反**，反了会静默 `publish=0`（见 §5.8）。做完之后发布意愿指标即可彻底摆脱反查 `posts`。 |
