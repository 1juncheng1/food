# Creation Opportunity Engine Implementation Plan

> Status: APPROVED
> Source: .claude/artifacts/designs/creation-opportunity-engine.md（Status: ALIGNED，Q1–Q5 全部关闭）
> Mode: --deliberate（含生产 DB 权限变更、评分规则换版、用户反馈数据写入）
> Iterations: 2 / 3
> Author: 视界项目组（用户）+ AI 技术合伙人
> Last updated: 2026-09-19

## Requirements summary

把 dashboard「灵感推荐」从"模板卡片位"升级为 Creation Opportunity Engine：修复已建 CIP 引擎的运行时缺陷（D1/D2/D3/D5），接通推荐反馈全链路（曝光/点击/采纳/✕），扩展 Creative Profile，落地四维标签 Tag Vector，切换为用户指定评分公式 v2，build 时预制 AI 逐条推荐理由，卡片升级三段式，并预留外部热点协议。所有改动在现有 26 个引擎文件 + setup.sql §16 底座上增量完成（Q1 决策）。

## Acceptance criteria（继承 spec AC-1～AC-10）

- AC-1：游客/冷启动（事件<5）返回 `personalized:false` 且带 `degrade_reason`；qq 主账号（3c106467）保持 `personalized:true`；service_role 可查 style_profiles/generation_history；并发触发只产生 1 个 running build。
- AC-2：同一新用户连续 5 篇商业主题作品并 build 后，商业簇在队列候选中占比 ≥60%（引擎纯函数层可判定）。
- AC-3：删除全部商业作品并增量 build 后商业簇 weight 下降；无 ≥2 成员簇时队列被 supersede、接口诚实降级。
- AC-4：收藏 10 条科技素材（material_save×10）并 rebuild 后，科技簇进入画像且科技相关卡数量较基线明显增加（≥1 张）。
- AC-5：画像与队列未变时同 seed 连刷 10 次结果深相等；跨 seed（模拟跨日）允许 exploration 轮换；永不出现无画像依据的随机卡。
- AC-6：impression/click/adopt/dismiss 四类交互均在 creator_events 留幂等事件；dismiss 卡立即从 UI 与 active 队列消失，一次 build 后簇 weight 可观测下降。
- AC-7：`Score = InterestMatch×0.4 + RecentBehavior×0.2 + Trend×0.2 + Quality×0.1 + Explore×0.1`，权重仅存在于 config.ts；RULE_VERSION 升 `interest-rules-v2`；单测断言精确分值。
- AC-8：每条个性化卡返回 coreQuestion/whyRecommend/creationAngle/relatedKnowledge；whyRecommend 必须引用 evidence.facts 中真实事实；AI 不可用降级模板并标 `reason_source:'template'`。
- AC-9：存在 ExternalTrendData 标准类型与 registry 协议；Tavily 为唯一真实 adapter；抖音/B站/知乎为不发起真实调用的 stub；无外部数据时管线正常。
- AC-10：区块标题「AI 发现的创作机会」，卡片三段（标题/为什么适合你/可以怎么创作）+ ✕按钮；降级态文案为「大众创作方向」。

---

## Planner draft v2（v1 经 Architect/Critic 打回后修订）

### Principles

1. **最小代码**：每个 WF 只动闭环所必需的文件；已验证的 14 步 builder/事件账本/聚类/RLS/幂等一行不重写。
2. **单一管线增量演进**（Q1）：不建第二套推荐表/第二个 API；新能力全部挂到 `事件→build→预制队列→实时接口` 既有管线。
3. **魔法数唯一处铁律**：新评分权重只进 `lib/creative/interest/config.ts`；动权重 = RULE_VERSION 升版。
4. **AI 只在 build 时花钱**：四维标签、推荐理由全部 build 时预制落库；请求路径零新增 LLM 调用（用户第六阶段缓存要求）。
5. **诚实降级**：失败绝不伪装个性化；每条降级路径带机器可读原因码。
6. **事实约束 AI**：evidence 事实包仍是 LLM 唯一事实来源，理由/标签输出不合格即模板降级。

### Decision drivers

1. 用户已确认增量演进，拒绝重写（Q1）→ 方案必须能拆成独立可交付的 WF。
2. 生产成本敏感（已实测 1 次访问烧 6 个 build）→ DB 级互斥与预制缓存优先于实时计算。
3. 4 个规定测试是交付硬门槛 → 评分/画像/选择逻辑必须留在纯函数层可测，不引入 DB/LLM 依赖到评分路径。
4. 规则换版需可回溯（项目既有 rule_version 机制）→ v2 公式与 v1 并存痕迹保留在 build 记录。

### Viable options

**Option A：单一管线增量演进（favored）**
- 思路：WF0 点火 → WF1/2 反馈闭环 → WF3 画像扩展 → WF4 簇级四维标签 → WF5 公式 v2 → WF6 AI 理由预制 → WF7 前端 → WF8 协议 → WF9 测试。
- 改动文件：约 18 个（见下 Implementation steps，全部 cite 行号），新增 2 个文件（反馈端点、tagVector 模块），setup.sql 增 §16.10。
- Pros：无数据双写、无灰度一致性问题；复用 build 缓存/状态机/RLS；每 WF 独立可测可回滚；与 Q1 一致。
- Cons：builder 步骤继续变厚（14→约 16 步）；v2 换版影响全部现有用户（靠 RULE_VERSION + 手动 full build 控制）。

**Option B：推荐服务旁路重写（rejected）**
- 思路：新建 `rec_opportunities` 表与独立 `/api/recommendations` 管线，旧 CIP 仅当事件源；四维标签上四向量。
- 改动：新表/RLS/状态机/缓存/API 全套 + 双写迁移。
- Rejection rationale：①直接违反 Q1 已确认的增量演进；②队列状态机/supersede/14 天过期/RLS 全部重复一遍；③新旧两套 active 队列的一致性与回滚成本远高于收益；④四向量使存储与每次 build 的 embedding 成本 ×4，而簇级单标签向量已满足端到端贯通（见 WF4 局部选项）。仅当 Option A 被实测证明无法承载时才重估。

**Option C：只修闭环不升级模型（rejected）**
- 思路：仅做 WF0+WF1+WF7。
- Rejection rationale：不满足用户白纸黑字的 AC-7（指定公式）、AC-8（AI 理由五字段）、AC-9（外部热点协议），交付即缺三条验收；仅作为"如果中途叫停"的最小止损切片——WF0+WF1 单独上线也有独立用户价值。

**WF4 局部选项（Architect 要求显式列出）**
- A1 纯标签无向量：LLM 抽四维标签存 jsonb，匹配靠集合重合。最省，但不满足用户明确要求的「Tag Vector 向量表示」。**Rejected。**
- A2 标签 + 单 tag_vector（favored）：每簇 LLM 抽四维标签 jsonb，标签拼接文本过一次 bge-m3 得 `tag_embedding vector(1024)`，与语义 centroid 正交共存；打分时 InterestMatch 融合语义分与标签重合分。新增 embedding 次数 = 每簇 1 次（≤12 簇，build 时批量）。
- A3 每维一个向量（4×1024）：表达最细，但存储/计算 ×4、四维分库缺训练信号、无法证明优于 A2。**Rejected（过度设计，违反 50 行原则）。**
- 范围裁剪（v1）：四维标签先落**簇级与推荐卡级**；事件/作品级标签抽取列为 follow-up（搭 reasonAnalyzer 批解释顺风车的二期改造），不阻塞端到端验收。

### Implementation steps（行号基于 2026-09-19 工作区）

**WF0 点火与硬化（不改推荐语义，先止血）**
1. `supabase/setup.sql:1839-1843`（§16.8b）补两行：`grant select on public.style_profiles to service_role;` `grant select on public.generation_history to service_role;`（消除实测 42501；§16.10 新节统一承载本批远程变更，见步骤 5）。
2. `lib/creative/interest/interestRepo.ts:23` findRunningBuild 排序列 `created_at`→`started_at`（该表无 created_at，现状查询必静默失败，是 D5 并发根因之一）；补 error 分支（error 时 console.error 并返回 null）。
3. setup.sql §16.10 新增 running 互斥索引：`create unique index if not exists interest_builds_one_running_idx on public.interest_builds (user_id) where status='running';`；`lib/creative/interest/interestRepo.ts:118-140` createBuild 捕获 23505 冲突码 → 返回 null 并 console.info('build skipped: running exists')（runBuild `builder.ts:67-69` 现有 null 分支即跳过，语义正确）。
4. `app/api/inspirations/route.ts:45-53,60-68,127-136,191-199` 四处降级响应统一加 `degrade_reason`：`guest` / `auth_expired` / `cold_start`（!hasProfile）/ `empty_queue`（hasProfile 但无卡）/ `error`（catch 分支 L186-200 同时 console.error 带上 error.message，保留返回 200 不炸页面）。
5. setup.sql 文末新增 §16.10 节承载本计划全部远程 DDL（WF0 GRANT+互斥索引、WF4 两列、WF6 五列），全部 `if not exists`/`do $$` 幂等；远程执行方式 = 用户在 Supabase SQL Editor 粘贴执行（SQL Editor 内 auth.uid() 为 null，DDL 不涉及 RLS 评估，安全），执行后跑 §16.9 既有验证查询 + 本计划新增的 3 条验收查询。
6. 顺手字段名修正：`app/api/inspirations/route.ts:35` interface 与 `:153` 读取的 `market_flags` → `market_refs`（suggestionRepo `suggestionRepo.ts:64` select 与落库 `:104` 均为 market_refs；现状外部溯源恒 undefined；WF6 要真实返回该字段，属必改项，夹带说明仅此一处）。
7. 修正陈旧注释 `route.ts:86`「>6h」→「>1h」（对齐 config.ts:123 BUILD_MAX_AGE_HOURS=1）。

**WF1 推荐反馈闭环**
8. 新增 `app/api/inspirations/events/route.ts`：`POST {type:'impression'|'click'|'dismiss', rec_id}`。鉴权沿用 createServerClient(token)+getUser（仿 route.ts:56-70）；先查 interest_suggestions 校验归属并取 topic/cluster_code/title（RLS 自动限本人）。
   - impression：`trackEvent('recommend_impression',{targetType:'inspiration',targetId:rec_id,dailyKey:true,payload:{cluster_code,title}})`；**不调用 markImpressed**（现状 markImpressed 会把卡置 impressed 离开 active 队列，刷新即丢卡——见 Architect 质询，方案改为曝光只入事件流做 CTR 分母；在 `suggestionRepo.ts:140-151` markImpressed 加 @deprecated 注释保留不删）。
   - click：trackEvent('recommend_click', dailyKey:true)。
   - dismiss：先 `markDismissed`（suggestionRepo.ts:130），再用 suggestion.topic 调 generateEmbedding 后 trackEvent('recommend_dismiss', {embedding, topicExcerpt:title, payload:{cluster_code}})；成功后 `void runBuild(supabase,userId,'incremental')`（✕是画像变更操作，不等 5 脏事件阈值，立即重算）。
9. `app/api/creative/plan/route.ts:129` RequestBody 增 `rec_id?:string`（str 截断 100）；plan 成功返回前（该文件成功响应处）：校验 rec_id 对应 suggestion 归属 → generateEmbedding(topic) → trackEvent('recommend_adopt', {targetType:'inspiration',targetId:rec_id,embedding,topicExcerpt,interpret:'yes' 由 registry 决定}) + markConsumed（suggestionRepo.ts:119）+ fire-and-forget runBuild；rec_id 缺失/无效一律静默跳过（不阻断创作主流程）。
10. `app/(main)/dashboard/page.tsx:299-303` 跳转 URL 追加 `&rec_id=${ins.rec_id ?? ''}`（个性化卡有值，模板卡无值不追加）；onClick 同时 fire-and-forget POST events {type:'click'}（用 fetch keepalive，不阻塞 router.push）。
11. dashboard 卡片增加 ✕ 按钮（`:306-317` flex 行内右上角，stopPropagation）：POST events {type:'dismiss'}，乐观从 inspirations state 移除该卡；按钮 title 属性文案「不再推荐这类主题」（Q4 决策明示）。
12. 曝光上报：dashboard loadInspirations（`:53-68`）成功且 personalized 后，对 3 张卡逐张 POST {type:'impression'}（dailyKey 幂等保证反复刷新不重复入账；React 双调用/轮询均安全）。

**WF2 广场埋点 + 搜索预留**
13. `app/api/posts/[id]/interactions/route.ts`：POST 添加成功分支（`:134` incErr 处理后、返回前）查 posts 取 title/category，按类型 fire-and-forget trackEvent：like→post_like、save→post_save、style_resonate→post_style_resonate（targetType:'post',targetId:pid,topicExcerpt:title,category）；取消分支（`:103` decErr 后）发 post_unlike/post_unsave。DELETE 成功分支（`:211` 后）同样发撤回事件。已知缺口：style_resonate 关闭无对应撤回枚举（types.ts 无该事件），v1 关闭不记事件，列 follow-up。
14. topic_search：不新增 UI（Q3）；eventTracker 与 EVENT_REGISTRY（config.ts:69）已就绪，WF 内仅补一段 JSDoc 声明上报契约（未来搜索框直接调用），零业务代码。

**WF3 Creative Profile 扩展（纯函数为主）**
15. `lib/creative/interest/interestRepo.ts:258-265` getProfile 的 select 增加 creator_declaration（一次查询带回，不新增往返）；builder 步骤 11（`builder.ts:342` 附近 profile 装配处）把 declaration 传入 assembleProfile。
16. `lib/creative/interest/profileAssembly.ts:83-155` assembleProfile 输出增量四字段（旧字段全保留，schema_version→2）：
   - `topic_interest: [{name, weight, reason}]`：非负簇按 weight 取 top 8，name=label，weight=簇 weight（0-100 量纲：Math.round(weight*100)，对齐用户示例 90），reason=模板：`近30天 ${createCount} 篇相关创作` + 定稿/收藏事实（数据取 ClusterView 既有计数，零新查询）。
   - `creative_goals: string[]`：权威值读 creator_declaration.creator_goal（不存在=[]；AI 不推断填充，inferred 留空数组）。
   - `content_preference`：升级现有占位（`:145-149`），likes=core 簇 labels ∪ declaration 表达偏好；dislikes=负向簇 labels（dismiss 聚合，isNegative 视图已有）。
   - `recent_creation_direction: {code,name,weight,last_event_at} | null`：近 7 天事件归属的最强簇（events + ClusterView.topEvidence 计算，纯内存）。
17. `lib/creative/interest/interest.engine.test.ts` 同目录新增 profileAssembly 用例（或追加到现有测试文件，跟随项目惯例）：构造 3 簇+declaration 种子断言四字段。

**WF4 四维标签 Tag Vector（A2 方案）**
18. setup.sql §16.10：`alter table interest_clusters add column if not exists tag_dims jsonb not null default '{}'::jsonb; add column if not exists tag_embedding vector(1024);`
19. 新增 `lib/creative/interest/tagVector.ts`：`extractClusterTags(clusterViews)` 一次 LLM 批量调用（DeepSeek，输入每簇 label/summary/keywords+topEvidence 标题，输出 `{code, dimensions:{content:[],thought:[],emotion:[],craft:[]}}[]`，每维 ≤5 标签，prompt 红线：只许基于给定事实）；单簇解析失败 → 该簇 tag_dims={} 不阻塞；再对每簇标签拼接文本批量 generateEmbedding 得 tag_embedding（复用 lib/storage）。
20. `lib/creative/interest/interestRepo.ts:106` fetchActiveClusters select 增 tag_dims, tag_embedding；commitClusters（`:216-224`）新簇行写入两列；builder 步骤 7 命名之后（`builder.ts:139-181` 区间）插入「步骤 7.5 四维标签抽取」，失败按既有 LLM 降级哲学继续。
21. 评分消费（WF5 一并落地）：InterestMatch 内部融合 = 0.7×现有语义簇分 + 0.3×标签命中率（候选标签与簇 tag_dims 的命中数/候选标签数；候选侧标签在 WF6 与 AI 理由同次 LLM 调用产出，无标签时标签分按语义分兜底，权重 renorm）。

**WF5 评分公式 v2**
22. `lib/creative/interest/config.ts:15` RULE_VERSION → `'interest-rules-v2'`；文件尾部新增：
    `export const RANKING_WEIGHTS_V2 = { interestMatch:0.4, recentBehavior:0.2, trend:0.2, quality:0.1, explore:0.1 } as const`
    及因子内部常量（近因曲线天数断点、trend 映射 rising/stable/declining/dormant=1.0/0.7/0.3/0.15、explore 槽位分、标签融合 0.7/0.3）。
23. `lib/creative/interest/ranking.ts:15-20` 删除五个 W_ 常量改 import config；CandidateScoreInput（`:32-46`）增 `trend: TrendDirection`、`tagOverlapRatio: number`（缺省 1=按语义兜底）；scoreCandidate（`:71-137`）重写五因子：
    - interestMatch = 现有簇权重×置信度公式（:75-84）×0.7 + tagOverlapRatio×0.3；exploration 源固定 0.25 保留；
    - recentBehavior = 现 timeliness 近因曲线（:103-118 原样迁移）；
    - trend = config 映射，无簇 null→0.5；
    - quality = contentValue（现 :87）；
    - explore = exploration 槽 1.0 / core_gap 0.55 / evidence_followup 0.4 / continuation 0.2，再乘新颖系数（现 novelty 的 1−n×0.25 作为 0.7+0.3x 调节，而非独立因子）；
    - breakdown 键改 interestMatch/recentBehavior/trend/quality/explore；score 严格加权求和。
24. `builder.ts:467-475` 打分入参补 trend（matchedCluster.trend，ClusterView 已有）与 tagOverlapRatio（候选标签来自步骤 14.5，见 WF6；WF5 先传兜底值，WF6 接通真实标签）。
25. selectSlots（ranking.ts:177-249）与日种子机制不动（AC-5 稳定器）。

**WF6 算法 TopN + AI 理由预制**
26. setup.sql §16.10：interest_suggestions 增列 `core_question text, why_recommend text, creation_angle text, related_knowledge jsonb not null default '[]'::jsonb, reason_source text not null default 'template'`。
27. `lib/creative/interest/suggestionRepo.ts:21-49` SuggestionRow/SuggestionInsertInput 增五字段；insert（:91-106）写入；getActiveSuggestions select（:64）增五列。
28. builder 步骤 14 打分后（`builder.ts:435-510` itemsToInsert 装配后、:512 insertSuggestions 前）插入「步骤 14.5」：按 score 取 Top 6 → 一次 DeepSeek 批量调用（输入每条 title/topic/slot + evidence.facts 事实 + 该用户 S3 素材标题清单；输出每条 {coreQuestion, whyRecommend, creationAngle, relatedKnowledge}；红线：whyRecommend 必须复述某条 fact 的簇 label 与计数，输出后校验 `whyRecommend.includes(cluster_label)`，不合格该条降级；relatedKnowledge 只许从素材清单选，禁止编造）；AI 整体失败 → 全部走模板（buildReasonText 逻辑从 route.ts:204-226 移到 suggestionSynthesizer.ts 导出复用），reason_source='template'；成功 'ai'。同次调用顺带产出候选四维标签供 WF5 tagOverlapRatio。
29. `app/api/inspirations/route.ts:169-184` 返回增字段 core_question/why_recommend/creation_angle/related_knowledge/reason_source；reason 取 why_recommend ?? 模板（旧客户端不断）。

**WF7 前端三段式**
30. `app/(main)/dashboard/page.tsx:18` Inspiration interface 增 why_recommend/creation_angle/core_question/related_knowledge/reason_source?/degrade_reason?。
31. `:285` 区块标题「灵感推荐」→「AI 发现的创作机会」；卡片（:306-313）改三段：h3 标题；「为什么适合你」小字 why_recommend（模板/降级显示 reason）；「可以怎么创作」creation_angle（有才显示）；降级卡 tag 文案改「大众创作方向」（route.ts 三处 reason 文案同步改）。relatedKnowledge 以「关联素材：x、y」一行淡显（空则不渲染）。
32. 卡片点击与✕逻辑同 WF1 步骤 10-11 同文件落地。

**WF8 ExternalTrendData 协议 + stub**
33. `lib/ci/types.ts` 新增标准类型 `ExternalTrendData {platform:'douyin'|'bilibili'|'zhihu'|'tavily'|string; externalId; url; title; excerpt; dimensions?; trendScore:number(0-1); fetchedAt:string}` + adapter 返回该类型的映射约定；`lib/ci/registry.ts:13-20` 注册三个 stub adapter（douyin/bilibili/zhihu，方法直接返回 [] 并 console.info 一次「stub: 未接入」，永不发网络请求），Tavily 保持唯一真实源。
34. synthesizer S2（suggestionSynthesizer.ts:35-103）出口把 ci_items 行映射为 ExternalTrendData 后再转 Candidate（协议层一次转换，未来平台接入只写 adapter）。

**WF9 规定测试与验收**
35. 新增 `lib/creative/interest/ranking.v2.test.ts`：五因子精确分值（含权重和=1）、trend 四档、explore 槽位、边界 clamp；同 seed selectSlots×10 深相等、跨 seed exploration 可轮换（AC-5/AC-7）。
36. 新增/扩展引擎场景测试（复用 interest.engine.test.ts 现有种子 harness）：商业×5 占比断言（AC-2）、删除撤回降权+空簇降级（AC-3）、material_save×10 科技簇（AC-4）。
37. tagVector/profileAssembly 解析降级用例（LLM 失败 → 空标签/模板，不抛错）。
38. 全量 `npm test`（vitest run，基线现有 19 测试必须全绿）+ `npm run build` 类型检查；浏览器按 Verification steps 跑 AC-1/AC-6/AC-10。

### Workspace setup

- 当前分支 master，工作区 dirty：CIP 26 文件 + setup.sql §16 均未提交（用户已明确在 dirty master 上继续，Q1）。**不建 worktree**（worktree 无法携带未提交底座，会在旧代码上施工）。
- 开工前 `git status --short` 存档清单；每个 WF 完成后作为一个检查点向用户汇报，由用户决定 commit 时机（助手不主动 commit）。
- 远程 DDL（§16.10）在 WF0 开工时一次性给用户 SQL 片段，用户在 Supabase SQL Editor 执行回贴结果；WF4/WF6 的列虽后期才用，随 WF0 一次执行（纯加列，对旧代码透明）。

### Open questions（实施中默认按下列口径，不阻塞）

- 事件级四维标签（每篇作品）不做，v1 仅簇级/卡级 → follow-up（搭 reasonAnalyzer 批处理）。
- post_style_resonate 撤回无枚举值 → follow-up（加枚举要同步 CHECK 约束，单独变更）。
- 远程无 CI migration 机制，setup.sql 单文件 + SQL Editor 手工执行是项目既有方式，沿用。

---

## Architect challenge

### Steelman against favored option（最强反驳）

「Option A 把 6 个新职责（互斥锁/反馈端点/画像字段/标签/新公式/AI 理由）全塞进同一个 builder 管线和同一次远程 DDL，一旦 v2 公式或标签抽取质量差，影响面是**全用户的唯一推荐位**，没有旁路灰度；Option B 至少能让新旧 API 并行、按账号切流。」

如果反驳成立，plan 应改成：新公式先以 shadow 模式计算（score_breakdown 同时写 v1/v2 两套分，serving 仍按 v1 排序），人工对比 qq 账号一批结果后再切 serving 权重。**采纳一半**：WF5 落地时 score_breakdown 写 v2 五因子，但 serving 排序切换不需要 shadow——selectSlots 只按 score 排序，而 RULE_VERSION 升版后旧卡仍由 supersede 批量替换、build 是手动/行为触发而非自动全量回刷（现有用户卡片在下次自然 build 时才换），天然形成渐进切换；额外加一条保险：WF5/WF6 合并在 qq 账号手动 full build 验收通过后才算完成（见 Verification），等价于单账号灰度。不建 shadow 双写（违反最小代码，且 jsonb 写两套分增加 builder 复杂度无长期价值）。

### Tradeoff tensions

1. **反馈即时性 vs 成本**：dismiss/adopt 立即触发 build（30-60s、含 LLM/embedding）可能被连点放大。取舍：互斥索引（WF0-3）保证同用户同时只有 1 个 build；dismiss 端点 UI 乐观移除、build fire-and-forget，连点 10 次也只跑 1 个，其余 duplicate 返回。
2. **标签表达力 vs 成本/可测**：A2 单标签向量牺牲了「情绪维独立检索」能力，但换来与现存储同构、评分纯函数可测；情绪维的价值在 v1 由标签命中率参与 InterestMatch，已可观测。
3. **曝光准确性 vs 队列稳定性**：严格的 impressed 状态机会让卡片首曝即离队（刷新丢卡，直接违背 AC-5）。取舍：曝光只入 append-only 事件（CTR 分母），状态机只认 consumed/dismissed；markImpressed 弃用。
4. **AI 理由个性化 vs 幻觉风险**：理由越自由越像人写的，越可能编造。取舍：输出后做事实包含校验，不合格即模板——宁可模板味，不可说假话（项目既有 evidence 红线）。

### Principle violations（deliberate 必查）

- v1 Planner 草稿曾把「顺手修 market_flags 字段名」列为可选项——违反外科手术原则的论证义务；v2 已论证其为 WF6 必改前置（不修则外部溯源永空），保留并显式说明。
- v1 曾计划在曝光时调 markImpressed——违反 AC-5（刷新稳定性）与最小改动（会波及 supersedeOldBuild 只处理 active 的语义）；v2 改纯事件流。
- WF4 事件级标签被砍——表面违反用户「为每一条内容生成 Tag Vector」字面要求；v2 显式列为范围裁剪 + follow-up，簇级/卡级端到端贯通先交付验收，实施前需用户知晓（见本计划呈阅）。

---

## Critic verdict

| 维度 | 状态 | 备注 |
|---|---|---|
| Principle-option consistency | ✓ | Option A 与 Q1 增量演进、最小代码一致；B/C 均有 invalidation rationale |
| Fair alternative exploration | ✓ | A/B/C 异质真实；WF4 另列 A1/A2/A3 |
| Risk mitigation clarity | ✓ | 每条 risk 有对应动作（互斥索引/事实校验/幂等/渐进换版） |
| AC testability | ✓ | AC-2/3/4/5/7 全部二值化（60%、≥1 张、深相等、精确分值）；AC-1/6/10 浏览器可验 |
| Verification concreteness | ✓ | 给出 npm test/npm run build/具体 PostgREST 校验查询/浏览器步骤 |
| File/line coverage | ✓ | 38 步骤中 36 条 cite 具体文件:行号（>80%） |
| Pre-mortem present | ✓ | 4 场景（换版洗牌/误点负反馈/AI 幻觉/DDL 漂移） |
| Expanded test plan present | ✓ | unit/integration/e2e/observability 四段齐 |
| Workspace setup | ✓ | dirty master 处置、检查点策略明确 |

### Verdict: APPROVED（v2；v1 被 REVISE 一次）

v1 拒收原因：①曝光沿用 markImpressed 会破坏刷新稳定性；②缺 build 互斥的 DB 级方案，只修 findRunningBuild 挡不住并发；③WF4 范围未显式裁剪，有偷偷扩张到事件级 LLM 改造的风险；④降级路径无原因码，AC-1 不可机器验证。v2 四条均已修复。

### Reservations（即使通过仍保留）

1. **WF4 范围裁剪需用户明示同意**：用户原话「为每一条内容生成 Tag Vector」，本计划 v1 只做簇级+推荐卡级，事件级列 follow-up。若她坚持事件级，WF4 工时与 LLM 成本估计需重估（每个 pending 事件搭 reasonAnalyzer 调用，约 +1 次批量 LLM/批）。
2. **`builder.ts:512-515` 插入 0 行只 warn 不 failBuild**：WF6 若 AI 理由批量解析全挂导致 items 被意外过滤，可能出现「build done 但空队列」；mitigation 是步骤 14.5 失败必须保留无理由卡（理由降级而非丢卡），实施时要 code review 此分支。
3. **dismiss 触发即时 build 的 serverless 时长**：events 端点 fire-and-forget 在 Vercel/托管平台函数返回后可能被冻结杀死（本地 dev 无问题）。当前项目部署形态不明（无 .vercel 配置）；若未来上 serverless，需改由事件脏阈值或 edge cron 触发——本计划注释标注，不提前实现。
4. 远程 DDL 依赖用户手工在 SQL Editor 执行，无迁移版本表；第二次环境搭建时易漏——§16.10 全部幂等可重跑，但仍建议未来引入 migrations（follow-up）。

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| v2 公式全用户换版观感突变 | RULE_VERSION v2 留痕；不批量回刷，随自然 build 渐进替换；qq 单号 full build 先验（Architect 折中） |
| 一次访问 N 个并发 build（D5 实锤） | running 唯一部分索引（DB 兜底）+ findRunningBuild 修列（应用双保险） |
| ✕误点连环负反馈 | 单簇作用、hardFilter dismissed 阈值 0.30 保守、tooltip 明示、后续正分事件可自然恢复（append-only） |
| AI 理由编造行为事实 | 仅喂 evidence.facts；输出 includes(cluster_label) 校验；relatedKnowledge 闭集选择；失败模板降级 |
| service_role GRANT 遗漏再现 | §16.10 与 §16.8b 并列注释；验收查询显式覆盖两张旧表 |
| 曝光风暴/重复上报 | dailyKey 幂等（同卡同日 1 条）+ impression weight=0 不入兴趣分 |
| 标签 LLM 拖垮 build | 单簇失败隔离、整体失败 tag_dims={} 继续；embedding 失败置 null（既有哲学） |
| 冷启动账号永远模板 | FIRST_BUILD_MIN_EVENTS=5 自动首建已在（route.ts:88-97）；WF7 文案诚实化；不隐藏状态 |

## Verification steps

- AC-1：① SQL Editor：`select has_table_privilege('service_role','public.style_profiles','SELECT')` 等两表返回 true；② 浏览器无 token 访问 /api/inspirations 见 `degrade_reason:'guest'`；③ 连续两次刷新 qq dashboard，查 `select count(*) from interest_builds where user_id='<qq>' and status='running'` ≤1（且历史不再出现同秒并发组）；④ qq 保持 personalized:true。
- AC-2/3/4/5/7：`npm test` 全绿（新 ranking.v2 + 引擎场景测试）；权重断言 `Object.values(RANKING_WEIGHTS_V2).reduce((a,b)=>a+b)===1`。
- AC-6：浏览器 qq 账号点✕ → 卡片立即消失；`select * from creator_events where event_type='recommend_dismiss'` 有 1 条（连点✕幂等）；`interest_suggestions` 该 id status=dismissed；build done 后簇 stats 可观测降权；从卡片跳 /generate → creator_events 出现 recommend_adopt 且卡 status=consumed。
- AC-8：`select why_recommend,reason_source from interest_suggestions where user_id='<qq>' and reason_source='ai' limit 3`，why_recommend 均含该卡 evidence 的 cluster_label；断网 DeepSeek（临时改 key）再 build → reason_source='template' 不报错。
- AC-9：`npm test` 含 stub 用例：三平台 adapter 返回 [] 且无网络调用（spy fetch 未触发）。
- AC-10：dashboard 截图核对标题/三段/✕/降级文案。
- 全量门禁：`npm test`（vitest run，基线 19 + 新增用例全绿）、`npm run build`（Next.js 类型检查通过）。

## Pre-mortem（deliberate）

1. **Scenario：v2 上线后推荐集体「洗牌」，用户熟悉的卡片全没了。**
   Trigger：WF5 合并后任意 build 用 v2 权重量产，explore 0.1 + trend 0.2 让 exploration 卡挤掉 continuation。
   Mitigation：serving 无 shadow 但有渐进替换（不批量回刷）；qq 单号 full build 人工对比三卡质量再宣告 WF5/6 完成；explore 槽位受 selectSlots 配额上限 1 张约束（ranking.ts:223），不可能霸屏；RULE_VERSION 允许一键把 config 权重改回（代码回滚即旧规则）。
2. **Scenario：用户误点✕或试探性连点，AI/商业主题被 −1.5 打崩。**
   Trigger：dismiss 事件 embedding 偏题或连点不同卡。
   Mitigation：幂等键按 rec_id 去重（同一卡连点 1 条）；负分只影响对应簇、hardFilter dismissed 阈值 0.30 高门槛；正向创作权重 1.0/定稿 3.0，两篇新稿即可恢复；UI tooltip 明示；不提供「撤销✕」按钮（follow-up 候选，避免本期膨胀）。
3. **Scenario：AI 推荐理由幻觉，出现用户没做过的行为陈述。**
   Trigger：LLM 不遵守 prompt 或 evidence.facts 为空时自由发挥。
   Mitigation：prompt 仅给事实；输出后 includes(cluster_label) 与数字计数校验，不合格→模板；facts 为空直接模板（不调用 LLM）；why_recommend 落库可审计（interest_suggestions 行级）。
4. **Scenario：§16.10 DDL 在线上执行部分失败，应用与远程 schema 漂移。**
   Trigger：SQL Editor 网络中断/语句顺序问题。
   Mitigation：全部 `if not exists`+`do $$` 幂等可整段重跑；应用对新列全部 nullable/有默认值（缺列时 insert 报错被 failBuild 捕获→旧画像继续服务，不炸页面）；执行后立即跑 4 条验收查询再进行 WF4/WF6 代码联调。

## Expanded test plan（deliberate）

- **Unit（vitest，纯函数）**：ranking.v2 五因子精确分/边界 clamp/权重和；selectSlots 同 seed 10 次深相等+跨 seed 轮换；profileAssembly 四字段（含 declaration 缺失/负向簇/近 7 天无事件）；tagVector LLM JSON 解析五路径（正常/缺维/空数组/非 JSON/抛错）；模板理由 buildReasonText 事实拼接；hardFilter 三阈值；trackEvent 幂等键构造（idempotency 既有测试保持）。
- **Integration（mock supabase client）**：builder 步骤 14→14.5 联调：AI 成功写 reason_source='ai' 五列；AI 失败卡不丢仅降级；dismiss 端点：markDismissed+trackEvent+runBuild 触发顺序与归属校验（他人 rec_id → 404/不写事件）；plan route 带/不带 rec_id 两分支不影响主流程。
- **E2E（浏览器+真实远程，qq 账号）**：AC-1 四状态、AC-6 全链路、AC-10 视觉；冷启动用 95c9d6e7（2 事件账号，不额外造脏数据）验证 degrade_reason:'cold_start' 与「大众创作方向」。
- **Observability**：所有降级带 degrade_reason（前端可埋点统计各原因占比）；console 统一前缀 `[interest]`；interest_builds.error 落库（既有）；新增验收查询监控 running 并发数与 reason_source 分布。

## ADR

- **Decision**：在现有 CIP 单管线上增量交付 WF0–WF9；四维标签采用「簇级/卡级标签 jsonb + 单 bge-m3 tag_embedding」；评分切换 config 驱动的五因子 v2（RULE_VERSION interest-rules-v2）；AI 推荐理由在 build 步骤 14.5 批量预制落库，请求路径零新增 AI 调用；反馈闭环以 append-only 事件 + suggestions 状态机（仅 consumed/dismissed 改状态）实现；外部热点走 ExternalTrendData 协议 + 三平台不触网 stub。
- **Drivers**：Q1 增量演进决策（决定性）；生产 AI 成本（互斥+预制）；四测试要求纯函数可判定；规则可回溯；serverless 下不引入实时长任务。
- **Alternatives considered**：B 旁路重写 rejected（违 Q1、双写成本、重复状态机）；C 仅修闭环 rejected（缺 AC-7/8/9）；WF4-A1 纯标签 rejected（不满足 Tag Vector 要求）；WF4-A3 四向量 rejected（×4 成本无收益证据）；曝光 markImpressed 状态机 rejected（破坏 AC-5）。
- **Why chosen**：每一步复用已实测底座（事件账本/聚类/分层/supersede/RLS/幂等/日种子），新行为以加列/加字段/加一个端点承载，旧客户端契约不断；风险集中点（换版/AI 幻觉/并发）各自有独立、可提前验证的闸门。
- **Consequences**：builder 步骤增至 ~16 步、interest_suggestions/interest_clusters 各加列（jsonb+vector+5 文本列）；所有现有用户在下次自然 build 后迁移到 v2，v1 分值不保留（jsonb breakdown 自然过期）；画像 schema_version→2，消费方需容忍旧结构（getProfile 各字段均有兜底）。
- **Follow-ups**：事件级四维标签（搭 reasonAnalyzer 批处理）；post_style_resonate 撤回事件枚举；recommendation dismiss 撤销按钮；migrations 版本化；serverless 化时的 build 触发改造（edge cron/脏事件扫描）；ci_items 充料与 WF8 真实平台采购评估。

## Review trail

- Planner draft v1：单管线 WF0–WF9 全量步骤。
- Architect challenge v1：①steelman 主张旁路灰度；②曝光状态机与刷新稳定性矛盾；③D5 只修应用锁不够需 DB 级；④WF4 范围模糊。
- Critic verdict v1：REVISE——4 条拒收（markImpressed 伤 AC-5/缺 DB 互斥/WF4 未裁剪/降级无原因码）。
- Planner draft v2：曝光改纯事件流弃用 markImpressed；running 唯一部分索引 + 23505 捕获；WF4 显式 A1/A2/A3 + 范围裁剪；四处 degrade_reason；补 adopt/dismiss 即时 build 的连点防护与 serverless reservation。
- Architect challenge v2：追问换版灰度（采纳单号 full build 先验，拒绝 shadow 双写）与 AI 理由闭集约束（已写入步骤 28）。
- Critic verdict v2：APPROVED with 4 reservations（WF4 裁剪需用户知情/插 0 行分支/serverless 冻结/手工 DDL）。
- Final iterations: 2 / 3
