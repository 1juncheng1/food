# 兴趣引擎专线摘要（CIP / WF0–WF11）

> ⚠️ **本文件不再是全局接力入口。** 新会话请先读 [`CURRENT.md`](./CURRENT.md)（全局能力全景、
> 待办与铁律），本文件只覆盖「Creator Interest Profile 创作者兴趣模型」这一条功能线。
>
> 最后更新：2026-09-18（内容未同步 2026-09-24 之后的进展，读时注意时效性）
> 读本文件后，再读 `lib/creative/interest/` 源码。

---

## 1. 项目名称、目标、技术栈

### 项目
**视界**——AI 内容创作平台（Next.js 单体应用）。

### 本功能线要解决的核心问题
旧灵感推荐系统把"用户行为"错误等同于"用户兴趣"：
- 用户偶尔测试一次电影解说 → 系统判定喜欢影视 → 持续推送不需要的内容。

根因（架构性，非单个 bug）：
1. 用 9 个 category 枚举（内容形式）做推荐轴，而非开放语义主题；
2. 同项目多版本重复计票；
3. 软删除导致删稿后仍在推；
4. 无时间衰减；
5. 不区分行为原因（测试/被迫/真兴趣同权重）。

### 方案：Creator Interest Profile（CIP）
事件流账本（append-only）→ embedding 语义簇 → 确定性分层 → LLM 仅做原因分析与簇命名 → build 预制推荐卡队列 → API 分槽读取。

数学保证场景："10 篇 AI 商业 + 1 篇电影测试"
- 电影簇 ≈ 1 × 1.0 × reasonFactor(testing=0.1) × 衰减 ≈ **0.05**
- AI 簇（项目封顶后）≈ **1.0**，相差 20 倍，偶然行为无法反超。

### 技术栈
- Next.js **16.3.3**（注意：API 与约定可能不同于训练数据，写代码前读 `node_modules/next/dist/docs/`）+ React 19 + App Router + TypeScript
- Supabase：Postgres + **pgvector**（1024 维 bge-m3，HNSW 索引）；RLS；session 在浏览器 localStorage（非 cookie）
- LLM：DeepSeek（`deepseek-chat`，JSON 模式）；embedding：SiliconFlow bge-m3@1024
- 市场情报：Tavily → `ci_items` 跨用户共享缓存表（service-role-only）
- 测试：**vitest 2.1.9**（v3 与 Next16/React19 peer 依赖冲突，锁定 v2）
- Windows 环境，PowerShell（无 `head`，用 `Select-Object -First N`）

---

## 2. 已完成模块 & 代码文件清单

实施按里程碑推进：**M0 数据库 → M1 埋点 → M2a 纯函数引擎 → M2b build 编排 → M3 回填 → M4 新推荐逻辑**。代码全部完成，tsc 0 error、eslint 0 error、vitest 19/19 通过。

### 2.1 核心库 `lib/creative/interest/`（24 个文件）

| 文件 | 职责 |
| --- | --- |
| `types.ts` | 21 种 CreatorEventType、TargetType、EngineEvent、ReasonCode、InterestLayer |
| `config.ts` | **唯一允许出现权重/阈值数字处**；RULE_VERSION/ALGO_VERSION、EVENT_REGISTRY、全部阈值 |
| `normalize.ts` | 文本/向量/id 纯清洗函数 |
| `idempotency.ts` | 幂等键：`live:{targetType}:{targetId}:{eventType}[:{date}]`、回填用 `backfill:` 前缀 |
| `eventTracker.ts` | `trackEvent()` 服务端唯一写入口，**永不抛异常**，upsert 幂等 |
| `weights.ts` | effectiveWeight/reasonFactor/genuineShare/ageDays/recencyWeight/needsInterpret（从 scoring 拆出避免循环依赖） |
| `vectorMath.ts` | cosineSimilarity/weightedCentroid/dotProduct |
| `clustering.ts` | 单遍余弦聚类（阈值 sim≥0.72，时间正序，确定性） |
| `layering.ts` | detectBurst/initialLayer/decideLayer（含迟滞 downgrade_streak） |
| `trends.ts` | windowScores/slope/trendDirection/ewma |
| `confidence.ts` | 五维置信度；去重项目 <2 时硬上限 0.4 |
| `scoring.ts` | adjudicateWithdrawals（撤回裁决）+ scoreClusters（评分主入口）+ ScoredCluster |
| `profileAssembly.ts` | assembleProfile 纯函数 → interest_profile jsonb（六层视图） |
| `reasonAnalyzer.ts` | batchInterpret：DeepSeek 批量行为原因分析（失败置 failed 不阻断） |
| `naming.ts` | batchNameClusters：LLM 新簇命名（label/summary/keywords/slug） |
| `interestRepo.ts` | 三表读写；**finishBuild 用 upsert 写画像（曾因 update 新用户 0 行导致永久降级，已修）** |
| `builder.ts` | `runBuild` 14 步流水线（见 §4.4） |
| `backfill.ts` | runBackfill：projects→work_generate、feedback→like/dislike、post_interactions→post_like/save、**posts(source_project_id)→work_publish（刻意不 join 项目表，保住孤儿发布证据）** |
| `fallbackTemplates.ts` | 冷启动 7 分类模板池（从旧 /api/inspirations 搬迁，诚实降级不伪装个性化） |
| `candidates.ts` | Candidate 接口 + hardFilter + S1/S3/S5 取数（S5 已限 1 张、文案改新角度、带 projectId） |
| `suggestionSynthesizer.ts` | S2 ci_market（service role + 应用端相似度）+ S4 exploration（DeepSeek 生成 2 方向） |
| `ranking.ts` | scoreCandidate 五因子打分 + selectSlots 分槽 + 日种子稳定排序（mulberry32） |
| `suggestionRepo.ts` | interest_suggestions 读写 + 状态流转（active/impressed/consumed/dismissed/expired/superseded） |
| `interest.engine.test.ts` | 19 个种子测试（仅引擎层；**ranking/suggestionRepo 无测试**） |

### 2.2 API 路由
- `app/api/creative/interest/build/route.ts` — POST 触发 build（限流 3/10min，maxDuration=60）
- `app/api/creative/interest/backfill/route.ts` — POST 回填+自动 full build（限流 1/10min，maxDuration=60）
- `app/api/creative/interest/profile/route.ts` — GET 画像（SWR）
- `app/api/creative/works/[id]/route.ts` — **硬删除** API（项目版本行 409 拒单删；无项目老作品硬删除 + 发 work_delete）
- `app/api/inspirations/route.ts` — **完全重写**：读画像→读 active 卡→selectSlots→3 张；冷启动/空队列降级模板；画像过期 fire-and-forget build

### 2.3 M1 六处埋点接入
- `app/api/prompt-optimizer/route.ts` → `work_generate`
- `app/api/creative/projects/[projectId]/route.ts` → `work_finalize` / `work_unfinalize`（按天幂等）
- `app/api/feedback/route.ts` → `feedback_like`/`feedback_dislike`/`work_edit`/`work_regenerate`
- `app/api/scripts/route.ts` → `material_save`
- `app/api/scripts/[id]/route.ts` → `material_delete`
- `app/api/creative/works/[id]/route.ts` → `work_delete`

### 2.4 前端 & 其他
- `app/(main)/generate/page.tsx` — recId state + URL `rec_id` 参数 + 透传两个 fetch plan 请求 body
- `app/(main)/dashboard/page.tsx` — handleDeleteWork 同步调硬删除 API
- `lib/ci/store.ts` — `getServiceClient` 改为 export（供 synthesizer 复用）
- `supabase/setup.sql` 第 16 节（约 1552–1844 行）

### 2.5 实测已验证的结论（2026-09-18）
- backfill 成功：28 项目 → 30 事件（含 2 定稿），0 error
- full build 成功：修复"单成员簇也落库"后 cluster_count **23 → 2**
- `/api/inspirations` 返回 `personalized:true`，S4 LLM 探索卡质量高（例："被AI裁掉后，普通人靠什么重新赚钱？"，contentValue 0.85）
- 全链路技术闭环已跑通

---

## 3. 当前未完成任务清单（按优先级）

| # | 优先级 | 任务 | 说明 |
| --- | --- | --- | --- |
| 1 | **P0** | 重跑 full build + GET /api/inspirations 验证最新 3 项修复 | 见 §5.1，代码已改且测试通过但**尚未实测新效果** |
| 2 | P0 | M1 **实时埋点**实测 | backfill 路径已验证；真实操作路径（生成/点赞/定稿/删稿→creator_events）尚未验证 |
| 3 | P1 | 配置 `SUPABASE_SERVICE_ROLE_KEY` 到 `.env.local` | 缺它 S2 ci_market 候选静默降级（当前推荐少一类来源） |
| 4 | P1 | **M5 推荐解释能力** | evidence→中文解释模板（现在 reason 大量兜底"基于你的创作兴趣推荐"）；✕不感兴趣按钮（调 markDismissed）；前端曝光/点击埋点（markImpressed + recommend_impression/click/adopt 事件） |
| 5 | P2 | ranking 纯函数补单测 | scoreCandidate 归一化、selectSlots 自适应配额、stableOrder 日种子稳定性 |
| 6 | P2 | git 提交拆分 | 36 文件 +3827/−1304 全部未提交且多功能线混杂（CIP / 灵感分析器 / 登录门 / 星空UI / plan改版），需按功能线分 commit |
| 7 | P3 | ci_items 规模升级 | 超 ~10K 行后补 `match_ci_items` RPC 用 HNSW（当前应用端 Top200 余弦过滤） |
| 8 | P3 | `supabase/.temp/` 加入 .gitignore | 临时目录 |
| 9 | P3 | market_refs 脱敏审查 | S2 的 url 落 interest_suggestions.market_refs（API 未返回前端，但存在用户表） |

---

## 4. 关键决策、约束、数据库结构

### 4.1 用户已确认的产品决策
- **硬删除**（非软删除）
- 权重：impression=0（仅 CTR 分母）、dislike=−0.3（否定质量非主题）、dismiss=−1.5（唯一主题级负反馈）
- interest_suggestions 新表方案认可
- 槽位 C 自适应：最强 core 簇 weight≥0.8 时允许同核 3 张，但同簇 ≤2 张

### 4.2 核心算法参数（全部在 config.ts，改数字 = RULE_VERSION 升版）
- 权重公式：`w(e) = baseWeight × reasonFactor × 0.5^(ageDays/45)`（半衰期 45 天）
- reasonFactor：genuine_interest=1.0 / narrative_research=0.7 / social_follow=0.5 / work_assignment=0.3 / testing_feature=0.1 / accidental=0.05
- 项目封顶：同项目同簇 ≤3.0（PROJECT_CAP_PER_CLUSTER）
- 聚类：距离阈值 0.28（sim 门槛 0.72）、**CLUSTER_MIN_MEMBERS=2**、跨期继承 sim≥0.72、MAX_ACTIVE_CLUSTERS=12
- 分层：core 需 age≥30天 + ≥3项目 + ≥5事件 + weight≥0.55 + genuineRatio≥0.6；temporary 爆发窗口 7 天/宽限 14；exploration 晋升 21 天；连续 2 期不达标降级
- 五因子打分：interestFit **0.34** + contentValue **0.24** + purposeFit **0.16** + novelty **0.14** + timeliness **0.12**
- build 调度：脏事件 20 / 画像过期 6 小时（BUILD_MAX_AGE_HOURS）/ 原因批 20 条 / 窗口 90 天

### 4.3 数据库（setup.sql 第 16 节，additive + if not exists）
**4 张新表**：
- `creator_events` — 事件账本，只增不改不删；唯一约束 `(user_id, idempotency_key)`；embedding vector(1024) + HNSW
- `interest_builds` — build 运行记录（status: running/done/failed；在途折叠）
- `interest_clusters` — 语义簇（cluster_code/centroid/layer/weight/confidence/status:active|superseded；stats jsonb）
- `interest_suggestions` — 推荐卡队列（id 对外即 rec_id；slot/source/status 均有 check 约束；title≤40、description≤120、topic≤200；expires_at 默认 14 天；market_refs 内部溯源不返前端）

**3 个新列**：
- `generation_history.work_tags`
- `style_profiles.interest_profile`（画像 jsonb，空对象=未建模）
- `ci_items.embedding vector(1024)` + HNSW

**RLS**：4 表用户私有（select/insert/update 自己的，不可删）；ci_items 无任何 anon/authenticated 策略，仅 service role。

### 4.4 build 14 步流水线（builder.ts）
0 在途折叠 → 1 建 build 行 → 2 拉事件 → 3 embedding 补齐(≤50) → 4 原因批解释 → 5/6 撤回裁决+评分+聚类 →（**过滤 eventCount≥2 + Top12 截断**）→ 7 跨期继承+LLM 命名 → 8 分层 → 9 趋势 → 10 置信度 → 11 装配画像 → 12 commitClusters → **13 五源候选并行（S1/S2/S3/S4/S5）+ hardFilter → 14 supersede 旧队列 + 三级簇匹配 + 五因子打分 + insertSuggestions** → finishBuild(upsert 画像)。
任一步失败 build=failed，旧画像继续服务。

### 4.5 候选五源 & 簇匹配
- S1 own_inspiration（未兑现灵感分析）/ S2 ci_market（市场缺口，service role）/ S3 saved_material（沉淀素材）/ S4 exploration（LLM 相邻方向）/ S5 active_project（7天内活跃项目，仅 1 张）
- 簇匹配三级：①S4 首张强制绑种子簇且 slot 升级 core_gap → ②projectId 直连（回填数据可靠）→ ③embedding 余弦 ≥0.5 兜底
- selectSlots 槽位：A core_gap / B evidence_followup / C exploration / D continuation；首轮各取 1，补齐优先级 core_gap→evidence_followup→**exploration→continuation**；日种子（YYYY-MM-DD + mulberry32）同分跨日轮换

### 4.6 铁律/约束
- 业务代码禁止魔法数，只准引用 config.ts
- trackEvent 永不抛异常、不阻塞主业务
- evidence 是确定性事实包，**禁止 LLM 自由发挥写入**
- ci_items 的 query_hash/topic 不跨用户暴露，候选晋升前脱敏
- 最小 diff 修复；不随意重构；不引入无意义依赖

---

## 5. 已知 bug、待解决问题

### 5.1 【已实测通过】2026-09-18 第二轮质量修复（P0-1 验证完成）
基于实测"3 张卡：2 张 continuation + 1 张高质量 exploration 排第 3、全部 no_cluster"，已改：
1. `candidates.ts` S5：limit 2→**1**；描述从改稿建议改为新角度文案；Candidate 新增 `projectId` ✅实测生效
2. `ranking.ts` selectSlots 补齐优先级对调 ✅实测生效
3. `builder.ts`：S4 首张强制绑定种子簇并升级 core_gap ✅实测生效（但发现并修复了下方第 4 点）
4. 【本会话新增修复】`builder.ts` L391-394 **WeakMap 引用陷阱**：forceBind.set 绑在原始对象上、展开后新对象进入流水线导致 get 永远 miss → 全部 no_cluster。已改为绑定展开后的新对象，实测通过

**实测结果（2026-09-18 晚，21 项目 + 29 feedback 回填 → 33 事件 → 3 簇）**：
- core_gap 卡带真实簇 `c_game_lit_social` + facts（create×6）+ 簇名 reason ✅
- exploration 卡正常、continuation 仅 1 张（S5 新文案）✅
- 回填幂等键复用 live: 格式，重复回填不重复计票（52 次 upsert → 31 新行）✅
- M1 实时埋点已确认工作（live: work_generate + feedback_like 真实落库）

### 5.1g 【P1-3 完成 + 两个重大既有 bug 修复】service_role 授权缺失 + downgrade_streak 幽灵列（2026-09-18 晚）
**P1-3 落地**：用户提供 service_role key → 写入 `.env.local`（已被 .gitignore 覆盖）→ 发现 **setup.sql 全文没有任何 service_role GRANT**（RLS 只过滤行不授予权限，本项目默认权限也不含 service_role）→ 之前 getServiceClient/S2 ci_market 全部 "permission denied" 静默失败。已补 16.8b 节授权（5 张表 grant 给 service_role，用户在 SQL Editor 手工执行），service role 实测 5 表全通。

**清理完成**：5 条测试噪音事件（753f975f 撤回×3 + 505f238c generate/finalize×2）已用 service role 删除，复核归零。

**修复 full build 失败引出的两个既有 bug**（手动 full build 报 "commitClusters 失败" 定位过程发现）：
1. **`fetchActiveClusters` select 了不存在的 `downgrade_streak` 列**（该值实际存于 stats jsonb）→ PostgREST 每次报错返回空数组 → **supersede 从未执行、跨期继承从未生效**（生产实锤：全表 0 条 superseded 行、单用户 active 簇堆积 48 个）。修复 [interestRepo.ts](lib/creative/interest/interestRepo.ts)：移除该列 + error 时打日志
2. **`commitClusters` 只返回布尔**，真实 DB 错误被吞 → failBuild 只会写"commitClusters 失败"。已改为返回 `string | null`（错误信息），builder 透传写入 interest_builds.error

---

## 6. Work Agent（作品智能协作体）（2026-09-22 新增）

把「继续优化」从「一句反馈 → AI 全文重写」重构为「上下文驱动的 AI 共创伙伴」。**定位变更**：从"AI 生成文章工具"迈向"用户与 AI 共同完成作品的创作伙伴"。

**核心原则（改动前必读）**：AI 不是聊天机器窗口，而是**携带完整作品上下文的编辑伙伴**；每一步都必须用户点选才推进，AI 无权跳过阶段直接改文章。

### 三阶段流程
```
say            → 2-4 个候选含义（每个带 evidence 依据）
select_intent  → 2-3 个修改方案（含 preserveItems "不动什么"承诺）
select_plan    → 段落补丁预览 → 用户接受 → decide 服务端融合 → V(N+1)
                 rewrite 策略 → 明确告知后走 handleImprove 全文重写
```

### 新增文件
| 文件 | 职责 |
|---|---|
| `app/api/creative/work-agent/session/route.ts` | 会话生命周期（创建/恢复/放弃） |
| `app/api/creative/work-agent/chat/route.ts` | 三阶段状态机 |
| `lib/creative/workAgentContext.ts` | **上下文装配唯一出口**（7 类上下文 + `formatContextForPrompt`） |
| `lib/creative/intentClarifier.ts` | 阶段 1 意图候选 |
| `lib/creative/revisionPlan.ts` | 阶段 2 修改方案 |
| `components/creative/work-agent-chat.tsx` | 对话式前端（替换 `work-feedback-panel.tsx`，后者保留回滚） |

### 数据库
`setup.sql` 第 18 节：新增 `work_agent_sessions` / `work_agent_messages`；`generation_history` 加 `session_id`、`revision_plan`。

### 本次修掉的"AI 文风"根因
改造前 `patchEngine` 只拿到「用户一句话 + 正文」——**全系统唯一一处改用户文章却不知道这是谁写的 LLM 调用**。现注入：诊断 / 原始创作目标（blueprint.problem_understanding）/ Creator Profile / 编辑偏好 / 个人素材库 / 外部知识（预留接口）。

### 状态
tsc --noEmit 0 error。尚未在 Supabase 执行第 18 节 SQL，也未做端到端实聊验证。
3. 13:25 失败真因推断：fetchActiveClusters 坏 → 无继承 → LLM 对相同主题再次生成与现存 active 簇相同的 slug → 撞唯一索引 `interest_clusters_active_code_idx`（(user_id, cluster_code) where active）。修复后 supersede 先释放 code，继承插入无冲突

**修复后 full build E2E（c48d25e7）**：status=done、35 事件、9 旧簇全部 superseded、3 新 active，**`c_game_lit_social` 稳定码跨期继承成功**（此前每次随机新码）；推荐队列 3 张新卡（continuation 创业 / core_gap 数字归隐 / exploration 三国谋士）正确替换旧队列 ✅
质量门：tsc 0 / vitest 19/19；一次性脚本（清理+4 个检查脚本）已删除。

### 5.1f 【已修复+E2E 通过】项目作品删除链路断裂（§5.1e 缺陷的完整闭环）
用户痛点："删除一条内容后灵感推荐还是不变"。根因三层叠加：
1. dashboard 删除项目作品 → DELETE /works/{uuid} 必 404（本地 uuid ≠ 服务端版本行 id）→ 静默失败
2. DELETE /api/creative/projects/[id] 根本不存在（works 409 保护注释指向死路）
3. 即便删除成功，单条 work_delete 也够不着 BUILD_DIRTY_EVENT_COUNT(20) → 推荐队列不会更新

修复（3 文件，无 schema 变更）：
1. `app/api/creative/projects/[projectId]/route.ts` 新增 **DELETE** handler：loadOwnedProject 鉴权 → 先删版本行再删项目行（generation_history.project_id FK 是 **on delete set null 非 cascade**，必须显式删，否则版本行孤立）→ 画像撤回（finalized 先 work_unfinalize，再对每版本行 work_delete，撤回匹配按 target_id）→ 立即 fire-and-forget 增量重建
2. `app/(main)/dashboard/page.tsx` handleDeleteWork 按 `work.projectId` 路由（项目作品→/projects/{id}，无 projectId 老作品→/works/{id}）+ confirm 文案区分；删除成功 60s 后自动补拉灵感（等增量重建完成）
3. `app/api/creative/works/[id]/route.ts` 独立作品删除后同样触发增量重建

**⚠️ 关键陷阱（23403/23503）**：撤回事件**不能带 projectId**——creator_events.project_id 有 FK（on delete set null），事件行指向刚删除的项目会 23503 违规 → trackEvent 静默失败 → 撤回 0 入账。不带 projectId 等价于"先插后删、FK 自动置 null"终态，且 scoring 撤回匹配按 target_id 不依赖 project_id 列。

E2E（REST 直测，2026-09-18）：造 finalized 项目 + 2 版本行 → DELETE → `200 / versionsDeleted:2 / 版本行归零 / 项目归零` → 3 条撤回事件（work_delete×2 + work_unfinalize）全部入账、project_id=null ✅
**新发现**：creator_events 是 append-only（RLS 仅 select/insert，**无 delete 策略**，设计如此）→ 合成测试事件无法用用户 token 清理，残留 5 条噪音事件需 service key（P1-3）后清理。
质量门：tsc 0；eslint 本次引入问题清零（loadInspirations/scheduleInspRetry 改 useCallback 稳定引用 + retry 递归改闭包内具名函数，修掉本次引入的 exhaustive-deps 警告；L108 setFilter 既有错误未动）；vitest 19/19。
待用户拍板：qq 账号 4 条幽灵独立作品（topic '2'/'000'×2/《我的世界》）是否顺手删除；5 条测试事件清理需 P1-3 service key。

### 5.1e 【P0-2 完测】M1 实时埋点四类事件全部实测通过（2026-09-18 晚）
UI 全链路（TRAE 浏览器，qq 账号）：生成测试作品"埋点验证测试：早起"→ 自动建项目 → AI 诊断完成 → 点"定为最终作品"：
- ✅ `work_finalize`：落库，幂等键 `live:project:{id}:work_finalize:2026-09-18`（按天幂等），project_id 完整，creative_projects.status→finalized
- ✅ `work_delete`：API 路径实测（删幽灵独立作品 topic='1'）→ 事件落库 + payload.topic_excerpt 保留；幂等键无日期（每作品仅可删一次，设计正确）
- 结合此前 work_generate / feedback_like，**四类埋点全部证实工作**。测试残留（project 505f238c + 版本行）已用 REST 清理
**⚠️ 实测暴露重大产品缺陷：项目作品删除链路断裂**
- dashboard 删除项目作品：本地 id（uuid）≠ 服务端版本行 id（`{projectId}::v1` 格式）→ DELETE /works/{uuid} 服务端 404 → handleDeleteWork 对 404 静默 → UI 移除但**云端项目+版本行永久残留**（幽灵作品持续污染画像）
- 即便 id 正确也会撞 409 版本行保护（[works/[id]/route.ts#L64](文件) 设计注释称"项目级删除是另一条产品路径"）——但 **DELETE /api/creative/projects/[id] 根本不存在**（route.ts 仅 GET/PATCH），"在项目内管理"是死路
- 结论：现在所有作品都是项目作品（生成即建项目），用户**没有任何路径**真正删除项目作品；work_delete/画像撤回对新作品 100% 不可达；5 条老幽灵独立作品（topic '1'/'2'/'000' 等）已顺带清理 1 条，余 4 条可后续清理
- 修复方向（待拍板）：补 DELETE /projects/[id]（删项目+级联版本行+发 work_delete 事件撤回画像）+ dashboard 对项目作品改调项目删除或提示；属 M5 范围或单独任务 → **已修复，见 §5.1f**

**遗留新问题**：
- live 路径的 work_generate 事件 project_id 为 NULL（生成时项目尚未关联）→ S5 projectId 直连对当天新项目失效（回填事件不受影响）；低优先级，M5 时顺带评估

### 5.1d 【已修复+多场景 E2E】"build 完成后页面不自动刷新"（前端单次取数）
根因：dashboard 仅挂载时 fetch 一次 /api/inspirations；build 是 fire-and-forget（30-60s 完成），完成前后端无推送、前端无轮询 → 用户必须手动二次刷新才能看到个性化卡（"刷两次"体验）。
修复 `app/(main)/dashboard/page.tsx`：① 未个性化时每 20s 自动补拉（最多 5 次/100s），拿到 personalized:true 即停（游客无 token 不补拉——build 不会触发，补拉无意义）；② visibilitychange 回到页面时立即补拉一次；③ 卸载清理定时器。卡片状态更新即自动重渲染，无需手动刷新。
**算法功能完整性盘点（2026-09-18）**：
- ✅已实现且已呈现：个性化 3 卡队列、槽位排序、reason 文案（badge 展示）、游客/异常降级、首建+脏事件+stale 三触发链
- ⚠️服务端已返回未消费：`slot` 字段（前端 interface 未定义；语义已由 reason 文案带出，样式区分归 M5）
- ❌未实现（=M5 计划范围）：✕不感兴趣按钮+dismiss API、曝光/点击埋点（当前点卡片只跳转不落账）、trends（config 有 TRENDS_* 无消费方）
**多场景 E2E**：游客→personalized:false+平台模板 ✅；qq→true+三槽位卡 ✅；163（新用户毕业）→截图证实个性化卡已出 ✅；浏览器实测 qq dashboard 渲染正常 ✅；tsc 0/vitest 19-19 ✅
遗留：`dashboard/page.tsx` 有 1 个 HEAD 既有的 eslint react-hooks 错误（L100 setFilter 同步 setState in effect，滚动恢复时序依赖，勿轻动）——本次未修，建议单独评估

### 5.1c 【已修复+回归通过】新用户永远"平台推荐选题"（build 自动触发链断裂）
系统性定位（2026-09-18）：前端带 token/渲染均正常；实锤截图 3 张卡与 fallbackTemplates 模板池逐字一致（冷启动降级输出）。根因在**后端调度层**：`/api/inspirations` 唯一自动触发点被 `if (hasProfile)` 挡死 → 无画像用户永远无人为其跑 build。设计文档 §4.2 的"脏事件≥20 触发"是死常量（BUILD_DIRTY_EVENT_COUNT 全库 0 引用）。另一账号 163（无画像）必现，qq 账号因本会话手动 backfill+build 而个性化——线上所有真实新用户均复现。
修复（方案 1+2，约 15 行）：
1. `app/api/inspirations/route.ts` 三分支：stale>6h→incremental（原有）；`!hasProfile` 且事件≥FIRST_BUILD_MIN_EVENTS(5)→full 首建；有画像未 stale→脏事件（上次 build 末事件后新增）≥BUILD_DIRTY_EVENT_COUNT(20)→incremental。均 fire-and-forget + 在途折叠保护，本次响应不变，build 下次进页生效
2. `lib/creative/interest/config.ts` 新增 FIRST_BUILD_MIN_EVENTS=5
3. 【顺手修复既有 bug】`interestRepo.ts getLastBuild` 按 `created_at` 排序——interest_builds 表只有 started_at/finished_at（setup.sql L1582），错列名静默报错返回 null → 增量游标从未生效。已改 order('started_at') 并注释
验证：tsc 0 / eslint 0 / vitest 19-19；qq 账号回归 personalized:true+3 卡正常（有画像路径无回归）；**163 账号首建实测待用户操作**（刷新 dashboard 触发首建 → 等 1 分钟 → 再刷新应出个性化卡）
注意：首建/脏事件触发无限流（builder 在途折叠兜底 + hasProfile 后自动止步）；build 完成前多次进页只消耗 1 次有效 build

### 5.1b 【已修复实测】僵尸会话问题（"为什么灵感推荐还是平台推荐选题"）
根因：`supabase.auth.getSession()` 只读本地缓存不验服务端。服务端会话被注销后（如他端 global 登出），本地死 token 仍骗过 AuthGuard/UI → 所有 API 401 → `/api/inspirations` 静默降级"平台推荐选题"、定稿静默失败。游客看到的是"我以为登录着"。
修复（方案 A：核心创作动作强制登录 + 中心化清场）：
1. `components/auth-provider.tsx` — 挂载时 getSession 后补 `getUser()` 服务端验活，失效即 `signOut({scope:'local'})` 清本设备（不用 global，避免误杀其他设备真实会话）
2. `app/(main)/generate/page.tsx` — isLoggedIn 判定前同样验活（防两 effect 竞态放行游客）
3. 服务端 API 本就全量强制鉴权（Bearer + getUser），无需改动
E2E：注入假 token → 刷新 → 自动清场回游客态 ✅；tsc 0 / eslint 0 ✅
注意（后续变更）：游客模式已下线——`/generate` 白名单取消，`(main)` 下所有页面强制登录，LoginGate 组件已删除，登录入口统一收在首页 `/`；后端可选鉴权的 4 个接口（analyze-feedback / work-tags / problem-solve / inspirations）也改为强制鉴权。用户侧退出登录仍是 global scope（他端全踢），是否改 local 待产品决策

### 5.2 操作注意事项（踩过的坑）
- **Supabase SQL Editor 中 `auth.uid()` 返回 NULL**（postgres 超级角色无登录上下文）。查表不要带 `where user_id = auth.uid()`，或先 `select auth.uid();` 确认；用具体 uuid 过滤
- interest_builds 时间列是 `started_at`（**无 created_at**）
- Console 执行 fetch 后若 Next Fast Refresh 会打断 Promise、看不到结果——等热重载稳定再执行
- backfill/build 限流分别 1、3 次/10 分钟；full build 多次串行 LLM 调用需 30–60 秒
- 浏览器 localStorage key：`sb-rqnjpiijnnytlyjqqkbo-auth-token`，取 token：
  `JSON.parse(localStorage.getItem('sb-rqnjpiijnnytlyjqqkbo-auth-token')).access_token`

### 5.3 其他风险
- S4/S2 LLM 或 service 失败均静默降级（不阻断 build），线上需监控 LLM 成功率；无 explore 卡时先查 DEEPSEEK_API_KEY 与服务端日志
- hardFilter 阈值偏严（written 0.85 / queue 0.88 / dismissed 相似度 0.70），M5 接 dismiss 真实信号后再调
- 28 个历史项目主题高度分散，仅 2 个簇达 ≥2 成员门槛——属数据特性；若用户长期创作仍簇过少，需复查 bge-m3 向量质量或阈值 0.72
- `app/api/prompt-optimizer/route.ts` 481–583 行有 4 个既有 any lint error（非本功能线引入，未动）
- 画像 upsert 只传 interest_profile+updated_at，其余列依赖 DB 默认值（已避免覆盖 tone_tags 等风格卡字段）

---

## 6. 新会话接续动作（建议顺序）
1. 读本文件 → 读 `lib/creative/interest/config.ts` 与 `builder.ts`
2. 执行 §5.1 验证脚本，确认第二轮修复的实际推荐效果
3. 引导用户做 M1 实时埋点实测（真实生成 2–3 篇同主题作品 + 点赞 + 定稿）
4. 效果达标后进入 M5（解释模板 + ✕按钮 + 曝光点击埋点）
