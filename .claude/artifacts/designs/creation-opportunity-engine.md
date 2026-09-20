# Creation Opportunity Engine（创作机会引擎）Spec

> Status: ALIGNED（WF0 诊断完成并回写 2026-09-19；Q1/Q2 已关闭，Q5 待用户回答后进入 dev-plan；Q3/Q4 可在 plan 中决）
> Author: 视界项目组（用户）+ AI 技术合伙人
> Last updated: 2026-09-19
> Mode: dev-grill-docs --deep｜Waves: 1（静态审计波）｜Final ambiguity: ~13%

## Background

用户感知：灵感推荐永远是"反转结局 / 悬疑片拆解 / 短剧反转套路"三条固定内容，与用户创作过的 AI/商业/科技主题完全无关，刷新不变化。

**静态审计推翻了初始假设**：仓库中并非"静态写死的推荐"，而是存在一套 2026-09-18 刚建成、已 E2E 实测通过、但**尚未 git 提交**的创作者兴趣引擎（CIP, Creator Interest Profile，M0–M4 里程碑，26 个 lib 文件 + 4 张新表 + 5 个 API 改动）。接力文档 `project-summary.md` 存在。用户看到的"固定三条"是该引擎的**冷启动降级模板**（三条文案逐字命中 `lib/creative/interest/fallbackTemplates.ts:19/23/39`），说明个性化链路在用户当前账号/环境下没有生效，或生效后仍有多处反馈断裂。

本 spec 第一职责：记录全链路数据流与断裂点（用户要求的第一阶段交付）；第二职责：把用户 8 阶段目标与现有 CIP 引擎对齐，形成后续 dev-plan 的范围契约。

## 全链路数据流图（静态代码实证，2026-09-19）

```
【展示层】唯一推荐位：app/(main)/dashboard/page.tsx
  挂载 init() (L136-151)
    └─ getSession() → token → GET /api/inspirations（Bearer）
       非个性化时：20s 轮询×5（L73-87）/ visibilitychange 补拉 / 删稿后 20s×6 内容比对补拉
  渲染 (L294-326)：title / description / reason 三字段，3 张卡
  点击 (L299-303)：router.push('/generate?category=..&topic=..')  ← 【断点F1】不带 rec_id
  无曝光埋点、无✕按钮、无"为什么适合你/怎么创作"结构
        │
        ▼
【接口层】app/api/inspirations/route.ts（dynamic = force-dynamic，每次刷新实时执行）
  ① 无 token / getUser 失败 → fallback 3 条（reason='平台推荐选题'）   ← 降级路径 D1
  ② getProfile(): style_profiles.interest_profile (jsonb)
  ③ 三触发 fire-and-forget runBuild（本次请求不等待、不返回新结果）：
       stale>1h → incremental；无画像且 creator_events≥5 → full；脏事件≥5 → incremental
  ④ getActiveSuggestions(limit 6) → selectSlots 分槽取 3
  ⑤ 无画像 或 队列为空 → fallback                                       ← 降级路径 D3/D4
  ⑥ 全程任何 throw → catch 静默吞掉 → fallback                          ← 降级路径 D2
        │（fallback = getFallbackInspirations：22 条模板池 Math.random 抽 3）
        ▼
【构建层】lib/creative/interest/builder.ts runBuild（14 步，30–60s）
  creator_events(全窗口≤2000)
    → embedding 补齐(bge-m3@1024, SiliconFlow)
    → LLM 批原因解释(DeepSeek, reasonAnalyzer)
    → 撤回裁决 + 加权评分 + 单遍余弦聚类(scoring/clustering, ≥2 成员成簇, Top12)
    → 跨期继承(sim≥0.72) + LLM 簇命名(naming)
    → 分层 core/exploration/temporary(layering) + 趋势(trends) + 置信度(confidence)
    → 装配 interest_profile 六层视图(profileAssembly)
    → 五源候选并行：S1 未兑现灵感 / S2 ci_market / S3 收藏素材 / S4 LLM 探索方向 / S5 活跃项目
    → hardFilter（30 天内写过 0.85 / 队列重复 0.88 / dismissed 0.70）
    → supersede 旧队列 + 候选↔簇三级匹配 + 五因子打分(ranking)
    → insertSuggestions 写 interest_suggestions + finishBuild upsert 画像
  任一步失败：interest_builds.status=failed，旧画像/旧队列继续服务（可能永久空队列→fallback）
        │
        ▼
【数据层】supabase/setup.sql §16（additive，需已在远程库执行）
  creator_events          append-only 行为账本，21 种事件类型，(user_id,idempotency_key) 幂等，vector(1024)+HNSW
  interest_builds         build 运行记录（running/done/failed，在途折叠）
  interest_clusters       语义簇（cluster_code 跨期身份 / layer / weight / centroid / status）
  interest_suggestions    预制推荐卡队列（slot 4 槽 / source 5 源 / status 状态机 / 14 天过期）
  style_profiles.interest_profile   画像 jsonb（空对象=未建模）
  ci_items                市场情报缓存（service-role-only，Tavily 适配器，lib/ci/registry 已预留 B站/抖音/知乎位）
  既有业务表：generation_history(作品版本行)+creative_projects / scripts(素材) /
             generation_feedback / posts+post_interactions / style_profiles 风格卡
```

## 行为数据闭环盘点（用户核心原则：每次行为都要进画像）

| 行为 | 记录位置（文件:行） | 事件类型 | 入画像 |
|---|---|---|---|
| 生成作品 | api/prompt-optimizer/route.ts:1050；api/creative/projects/[projectId]/route.ts:169 | work_generate | ✅ |
| 定稿/取消定稿 | projects/[projectId]/route.ts:179,266,275 | work_finalize / work_unfinalize | ✅ |
| 删除作品 | api/creative/works/[id]/route.ts:86；projects DELETE（撤回事件+立即增量重建） | work_delete + 撤回裁决 | ✅（2026-09-18 刚修复） |
| 收藏素材 | api/scripts/route.ts:117 | material_save(1.2) | ✅ |
| 删除素材 | api/scripts/[id]/route.ts:59 | material_delete(撤回) | ✅ |
| 作品点赞/差评 | api/feedback/route.ts:123,137 | feedback_like(+1.0)/dislike(−0.3) | ✅ |
| 编辑/重新生成 | api/feedback + prompt-optimizer | work_edit / work_regenerate(0.3) | ✅ |
| 广场点赞/收藏/共鸣 | 仅 lib/creative/interest/backfill.ts 历史回填 | post_like/save/style_resonate | ⚠️ 实时路由 posts/[id]/interactions **未接 trackEvent** |
| 搜索行为 | 无搜索入口、0 调用点 | topic_search(0.5) | ❌ 事件定义了但系统无搜索功能 |
| 推荐曝光 | 无 | recommend_impression(0) | ❌ markImpressed 已写，0 调用方 |
| 推荐点击 | dashboard 跳转不带 rec_id（断点F1） | recommend_click(0.15) | ❌ |
| 采纳创作 | generate/page.tsx:515,592 发 rec_id，但 /api/creative/plan **不接收**（断点F2） | recommend_adopt(1.5) | ❌ 双端皆断 |
| 明确不感兴趣 | 无✕按钮 | recommend_dismiss(−1.5) | ❌ markDismissed 已写，0 调用方 |

辅助结论：
- 三个画像管理接口 `/api/creative/interest/{profile,build,backfill}` **无任何前端调用方**，只能手工触发；普通用户的画像完全依赖 /api/inspirations 内的 fire-and-forget。
- `interest_builds` 表是现成的"推荐缓存 + profileVersion"机制（algo_version/rule_version/event_range/status），用户第六阶段要求大部分已具备。
- `trends.ts` 已计算簇趋势（rising/declining/dormant + EWMA），但**五因子打分未消费 trend**。

## 三个用户症状的根因判定

**问题 1（固定三条）—— WF0 已终判（2026-09-19 远程库直查 + 浏览器实测）**：三条文案逐字等于 fallback 模板（同源于 HEAD 旧版 `CATEGORY_TEMPLATES`，09-16 提交的纯模板池接口）。当前各降级路径的实证状态：
- D1 游客/僵尸 token：**仍存在**。无 token 实测 `GET /api/inspirations` → 200 `personalized:false` + 3 条随机模板（旧版此处是 401）；任何未登录/失效会话必中。
- D2 静默降级：**仍存在但形态已实锤**——`service_role` 对两张旧表缺表级 GRANT：`style_profiles`、`generation_history` 均返回 `42501 permission denied for table ... Grant ... TO service_role`（§16.8b 补授权时只覆盖 5 张新表，漏了旧表）。authenticated 主路径不受影响，但后台/运维/S2 链路及 catch-all 静默吞错（route L186-200）使任何权限/表故障在用户侧都表现为"模板三条"。
- D3 冷启动：**仍存在**。uid 95c9d6e7 仅 2 条事件（< FIRST_BUILD_MIN_EVENTS=5），无 build、无 active 卡 → 永久模板；任何新用户同理。
- D4 build 失败/空产：**历史成立现已自愈**——最新 build 全部 done（早期 2 条 failed "commitClusters 失败"已在 09-18 修复）；四组外部 key 齐备，排除 key 缺失。
- 主账号实证（浏览器登录态实测，邮箱 3546237582@qq.com = uid 前缀 3c106467，35 事件）：`personalized:true, stale:true`，返回 3 张个性化卡（创业 / 三国城池 / 小城青年游戏公会，簇 c_game_lit_social），连续两次刷新完全一致（日种子排序生效）。**即主账号当前看到的已是个性化推荐而非影视模板**；用户报告的固定三条只可能来自：游客/失效会话、事件 <5 的冷启动账号（如 95c9d6e7）、或旧提交版本的环境（待 Q5 用户确认访问环境与账号）。
- 补充：模板路径为 20+ 条池随机抽 3，高频撞见同几条；个性化路径同日刻意稳定——两种机制均能产生"刷新不变"感知。
- 新发现 D5（build 并发竞态）：一次浏览器访问在 41 秒内触发 **6 个并发 incremental build 并发且均 done**（06:27:39–06:28:40 UTC），缺数据库级互斥锁；每次 build 都调 embedding+LLM，构成成本放大（fire-and-forget 多请求同时看到"无 running"而各自插入）。

**问题 2（与用户无关）**：D1–D3 任一成立即无关；主账号个性化已生效但存在**画像方向偏差**——系统从 35 个事件（含 28 条 backfill 项目，大量游戏/文学测试主题）聚出 c_game_lit_social 簇，与用户自我认知的 AI/商业/科技方向不一致；且推荐侧反馈（点击/采纳/dismiss/曝光）全部断裂，引擎只能从"创作行为"单向学习，用户**没有任何手段当场纠偏**。《AI是否会取代普通人》所属账号待确认（generation_history 对 service_role 403）；uid 06788eb6 的 active 卡已呈 AI 创业主题（"被AI裁掉后普通人靠什么重新赚钱"等）。

**问题 3（无生命周期）**：生命周期机制实际存在且今日再次实证工作（stale 访问自动触发 incremental build 并 done，旧卡被 supersede），但对用户不可见且有竞态（D5）：build 异步 30–60s 靠前端轮询补拉；低活跃用户永久停留冷启动；build 失败无用户可见信号。

## 与用户 8 阶段目标的差距矩阵

| # | 用户要求 | 现状 | 差距 |
|---|---|---|---|
| 1 | 全量数据流分析 | 本文件 | — |
| 2 | 5 类行为综合（创作/搜索/收藏/修改反馈/点击） | 创作✅ 收藏✅ 修改反馈✅ | 搜索❌（无功能）；推荐点击/曝光/采纳/dismiss❌；广场实时互动⚠️ |
| 3 | Creative Profile：topicInterest(name/weight/reason)、creativeGoal、contentPreference(喜欢/排斥)、recentCreationDirection | interest_profile 六层（core/exploration/temporary/domains/behavior_reason_summary/版本元数据），簇有 weight/confidence/trend | 缺 creativeGoal、喜欢/排斥显式结构、recentCreationDirection；reason 仅行为原因 mix |
| 4 | 四维标签 Tag Vector：内容/思想/情绪/创作方式 | 单一 bge-m3 语义向量 + content_domain 粗领域 + category 形式枚举 | 四维标签体系不存在（架构决策留 plan，建议与语义向量共存而非替代） |
| 5 | 评分公式 InterestMatch×0.4+RecentBehavior×0.2+Trend×0.2+Quality×0.1+Explore×0.1，权重可配 | ranking.ts 五因子 0.34/0.24/0.16/0.14/0.12（interestFit/contentValue/purposeFit/novelty/timeliness），权重是文件内常量 | 因子与权重均不同；Trend 已算未用；权重不在 config.ts（违反项目自身"唯一魔法数处"铁律） |
| 6 | 刷新实时调接口、移除硬编码 | force-dynamic 实时读；硬编码仅作冷启动降级（合理保留） | 核心是让个性化真正生效；降级模板应标"大众方向"而非伪装 |
| 7 | 画像变化才重算的缓存 | 三触发 + 预制队列 + build 版本 | 基本满足；失败可观测性需补 |
| 8 | 算法筛 TopN → AI 逐条生成 whyRecommend/creationAngle/relatedKnowledge | 算法筛选✅；理由是 evidence 模板拼接（buildReasonText，大量兜底"基于你的创作兴趣推荐"）；S4 只让 LLM 生成候选标题 | 逐条 AI 推荐理由不存在；输出字段需升级 |
| 9 | ExternalTrendData 标准结构（抖音/B站/知乎预留） | lib/ci 已有 Tavily adapter + registry 注释预留位 + ci_items 表 | 需抽象标准 ExternalTrendData 协议，外部平台 adapter 留 stub |
| 10 | 前端"AI 发现的创作机会"：标题→为什么适合你→怎么创作 | 标题+描述+一行 reason | 卡片信息架构与文案需升级 |
| 11 | 4 个规定测试 | interest.engine.test.ts 19 个引擎单测 | 规定的 4 个行为场景测试不存在（商业权重升降/删稿降权/收藏科技/刷新稳定性与探索） |

## In scope

- WF0 点火与硬化（诊断已完成，见根因判定）：① 补 `GRANT SELECT ON style_profiles, generation_history TO service_role`（setup.sql 同步 + 远程执行，消除 42501）；② build 数据库级互斥（running 唯一部分索引或 advisory lock）消除 D5 并发竞态；③ catch-all 静默降级改为结构化日志 + 响应携带降级原因码（用户侧不暴露细节，但链路可观测）；④ 冷启动模板诚实标注"大众创作方向"（UI 随 WF7 落地）；⑤ 用户确认报告账号/环境（Q5）后复验 AC-1
- WF1 推荐反馈闭环：卡片跳转携带 rec_id、plan 接口消费 rec_id（recommend_adopt + markConsumed）、曝光（impression+markImpressed）、点击（recommend_click）、✕不感兴趣（recommend_dismiss + markDismissed）
- WF2 广场 posts/[id]/interactions 实时埋点；搜索行为闭环（若产品确认无搜索入口则仅预留 topic_search 上报点）
- WF3 Creative Profile 视图扩展（topicInterest/creativeGoal/contentPreference/recentCreationDirection），声明式偏好与行为推断共存
- WF4 四维标签 Tag Vector（内容/思想/情绪/创作方式）的抽取、存储与向量化方案
- WF5 评分模型切换为用户公式并迁入 config.ts（RULE_VERSION 升版）
- WF6 算法 TopN + AI 逐条推荐理由（whyRecommend/coreQuestion/creationAngle/relatedKnowledge），evidence 事实包约束、随队列预制缓存
- WF7 dashboard 卡片升级为"AI 发现的创作机会"三段式
- WF8 ExternalTrendData 标准协议 + 现有 Tavily 适配 + 外部平台 stub（不实现真实第三方调用）
- WF9 4 个规定场景的自动化测试

## Out of scope

- 不推倒重写 CIP 事件账本/聚类/分层/RLS/幂等等已验证底座（待 Q1 用户确认演进策略）
- 不实现抖音/B站/知乎真实 API 对接与采购、数据合规评估
- 不做推荐位向 explore 广场/素材页等其他页面扩张（dashboard 为唯一消费位）
- 不重写风格向量（style_vector）体系与风格匹配 RPC
- 不做 A/B 实验平台、推荐效果大盘（仅预留统计字段）
- 不处理 project-summary.md §3 的 git 历史拆分（独立事务）

## Assumptions

- 继续使用 Next.js 16 + 现有 Supabase 实例（pgvector 可用）、DeepSeek、SiliconFlow bge-m3
- 冷启动模板保留，作为新用户/构建失败的诚实降级，但 UI 文案明确区分"大众创作方向"与个性化
- 画像构建仍为异步预制（30–60s），前端保留轮询补拉；不引入实时同步等待
- 四维标签与 bge-m3 语义向量为正交共存关系（最终架构在 dev-plan 定稿）
- 用户 0.4/0.2/0.2/0.1/0.1 公式为 v2 规则版本，旧规则可回溯（rule_version 机制已具备）

## Solution sketch

"事件账本 → Creative Profile → 四维标签向量 → 可配置评分 → TopN → AI 理由 → 预制队列 → 实时接口读取"单一管线，在现有 CIP 上增量演进：先点火（WF0）让用户当场看到个性化恢复，再补反馈闭环（WF1/2），然后画像与标签升级（WF3/4），评分与理由替换（WF5/6），卡片与外部协议收尾（WF7/8），每阶段独立交付+测试（WF9）。详细 ADR、任务分解与风险预案在 dev-plan --deliberate 产出。

## Edge cases & risks

| Category | Notes |
|---|---|
| Boundary | 新用户零事件→大众方向；事件 <5 不首建；删光作品→空簇 supersede+空画像（已处理）；游客→模板且不轮询 |
| Failure modes | D1–D4 四降级路径；build 失败用户无感知；LLM/embedding 服务商限流或 key 缺失；serverless 30–60s 超时 |
| Risks | ① 远程库与 setup.sql §16 漂移（最高危，WF0 必须先验）；② 四维标签引入双层向量的复杂度与一致性成本；③ AI 理由延迟与成本（必须随队列预制不能实时调）；④ 规则换版需全量 rebuild；⑤ dismiss −1.5 误点伤害画像（需确认交互） |
| Mitigation | build 状态对管理接口/日志可观测；AI 失败回退模板理由；标签抽取失败不阻塞 build（同现有 LLM 降级哲学）；新规则 RULE_VERSION 升版 + 手动 full build 切换 |

## Acceptance criteria

- AC-1（诊断）：对报告问题的账号，能在 interest_builds/creator_events/interest_suggestions 给出数据证据，明确其命中 D1–D4 中哪条；修复后 GET /api/inspirations 返回 `personalized:true` 且 3 张卡全部命中该用户兴趣簇（带非空 evidence.facts）。
- AC-2（测试1）：同一新用户连续生成 5 篇商业主题作品并完成一次 build 后，推荐队列中商业相关簇候选占比相对首建基线显著提升（具体阈值在 plan 定为可判定值，如 ≥60%）。
- AC-3（测试2）：删除该用户全部商业作品并触发增量 build 后，商业簇 weight 下降，最终无 ≥2 成员簇时队列被 supersede、接口诚实降级且不带商业个性化卡。
- AC-4（测试3）：收藏 10 条科技类素材（material_save×10）并 rebuild 后，科技簇进入画像且科技相关推荐卡数量较基线明显增加。
- AC-5（测试4）：画像与队列未变时连续刷新 10 次，结果稳定（日种子机制，不随机跳动）；跨 build 或跨日后存在受规则控制的探索位变化（exploration/core_gap 槽位），永不出现无画像依据的随机内容。
- AC-6（反馈闭环）：曝光/点击/采纳/dismiss 四类交互均在 creator_events 留下对应事件（幂等），且一次增量 build 后能在画像/队列中观察到影响；dismiss 卡立即不再展示。
- AC-7（评分）：评分实现严格等于 Score=InterestMatch×0.4+RecentBehavior×0.2+Trend×0.2+Quality×0.1+Explore×0.1，权重仅存在于 config.ts，改动权重=RULE_VERSION 升版；单测覆盖各因子边界。
- AC-8（AI 理由）：每条个性化卡返回 title/coreQuestion/whyRecommend/creationAngle/relatedKnowledge 五字段；whyRecommend 必须引用 evidence 中的真实行为事实；AI 不可用时降级为事实模板且标记来源。
- AC-9（外部趋势）：代码中存在 ExternalTrendData 标准类型与 registry 协议，Tavily 为唯一真实 adapter，抖音/B站/知乎为不发起真实调用的 stub；无外部数据时整条管线正常。
- AC-10（前端）：卡片区块标题为"AI 发现的创作机会"，三段结构（标题/为什么适合你/可以怎么创作）+ ✕按钮；游客与降级态文案诚实区分。

## Open questions

- ~~Q1（演进策略）~~：**已关闭（用户决策）= 增量演进**，保留事件账本/聚类/分层/RLS/幂等等已验证底座，按 WF0–WF9 改造。
- ~~Q2（远程库诊断授权）~~：**已关闭（用户授权直查，2026-09-19 完成）**。实例为官方 Supabase 国际版 `rqnjpiijnnytlyjqqkbo.supabase.co`；§16 四表齐备有数据；creator_events 78 条（work_generate 57 / like 10 / dislike 5 / finalize 4 / delete 2）；interest_builds 最新全 done；interest_suggestions 三用户 active；四组外部 env 齐备；缺陷实锤见根因判定 D2/D5（service_role 缺两张旧表 GRANT；build 并发竞态）；ci_items 当前 0 行（S2 暂无料，WF8 前不影响主链路）。
- ~~Q3（搜索入口）~~：**已关闭 = 暂无搜索入口，topic_search 仅做事件协议 + 上报点预留**（WF2），未来加入口自动回流画像。
- ~~Q4（✕语义）~~：**已关闭 = 隐藏本卡 + 降低该主题权重**（沿用现设计：dismiss 事件 −1.5 负权 + markDismissed 立即隐藏，WF1 实现时卡片 tooltip 明示"将减少此类推荐"）。
- ~~Q5（问题环境）~~：**已关闭 = 未登录态或另一个低行为账号**，即命中 D1（游客/失效会话模板）或 D3（事件 <5 冷启动永久模板），与远程证据完全一致。WF0 验收聚焦：游客/冷启动诚实降级文案 + 登录并积累 ≥5 事件后自动恢复个性化；《AI是否会取代普通人》归属不再阻塞，WF3/WF1 完成后用 qq 账号实测画像纠偏即可验证。

## Core entities (ontology)

| Entity | Type | Key fields | Relationship |
|---|---|---|---|
| CreatorEvent | DB row（事实，append-only） | event_type(21种)/target_type/target_id/embedding/interpretation/occurred_at/idempotency_key | 多事件→1 簇；撤回事件按 target_id 裁决 |
| InterestBuild | DB row（构建运行/缓存版本） | trigger/algo_version/rule_version/event_range/status/error | 一次 build 产出多簇+一批推荐卡 |
| InterestCluster | DB row（兴趣方向） | cluster_code/centroid(1024)/layer/weight/confidence/trend/status | 跨 build 由 code+质心继承身份 |
| CreativeProfile | style_profiles.interest_profile jsonb | core/exploration/temporary/domains/behavior_reason_summary（拟扩展 creativeGoal/contentPreference/recentCreationDirection） | 簇的用户可读视图 |
| Suggestion（推荐卡/创作机会） | DB row interest_suggestions | slot/source/title/topic/score/score_breakdown/evidence/status/expires_at（拟增 coreQuestion/whyRecommend/creationAngle/relatedKnowledge 或其预制存储） | 多卡→1 簇；状态机 active→impressed→consumed/dismissed→expired/superseded |
| TagVector（拟新增） | 派生结构 | dimensions:{content,thought,emotion,craft}/vector | 从事件与作品内容 LLM 抽取，与语义簇正交 |
| ExternalTrendData（拟新增） | 适配器协议 | platform/url/title/excerpt/tags/trendScore/fetchedAt | adapter→ci_items→S2 候选 |

## Interview metadata

- Mode: --deep
- Waves: 1（静态审计波；第 2 波为 Scope 决策提问）
- Final ambiguity: ~13%（Goal 0.9 / Scope 0.85 / AC 0.9 / Context 0.7）
- Status: ALIGNED（Q1/Q2 已关闭；Q3/Q4 留 plan 决策；Q5 为诊断收尾问题，不阻塞 plan 启动但影响 WF0 复验顺序）

### Clarity breakdown
| Dimension | Score | Weight | Weighted |
|---|---|---|---|
| Goal | 0.90 | 0.40 | 0.360 |
| Scope | 0.85 | 0.25 | 0.213 |
| AC | 0.90 | 0.25 | 0.225 |
| Context | 0.70 | 0.10 | 0.070 |
| Ambiguity | | | 13.2% |
