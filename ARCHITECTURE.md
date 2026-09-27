# 视界 · 项目架构索引

> 本文件是代码导航地图。读代码前先看这里，按模块定位文件。
> 最后更新：2026-09-12（创作进化系统阶段 4）

---

## 技术栈

- **框架**：Next.js 16.3.3 (App Router, Turbopack)
- **语言**：TypeScript
- **数据库**：Supabase (PostgreSQL + pgvector + Storage + Auth)
- **AI 服务**：SiliconFlow (bge-m3 嵌入、Qwen3-VL-8B 视觉描述)、DeepSeek LLM (deepseek-chat)
- **UI**：Tailwind CSS 深色主题 (bg-zinc-900)
- **认证**：Supabase Auth（session 存 localStorage，服务端用 Bearer token）

---

## 目录总览

```
app/
├── page.tsx                  首页（服务端组件，未登录展示介绍）
├── layout.tsx                根布局（AuthProvider 包裹全局）
├── loading.tsx               路由切换骨架屏
├── login/page.tsx            登录页（客户端）
├── register/page.tsx         注册页（客户端）
├── (main)/                   路由组：带左侧导航栏的页面
│   ├── layout.tsx            Sidebar + main 内容区
│   ├── dashboard/            仪表盘：作品列表 + 灵感推荐
│   ├── generate/             生成作品（原 prompt-optimizer）
│   ├── explore/              灵感广场：信息流 + 互动
│   ├── publish/              发布灵感（文字/图片）
│   ├── profile/[userId]/     个人主页：风格卡 + 帖子 + 关注
│   ├── profile/me/           重定向到当前用户主页
│   ├── settings/             设置：风格卡编辑 + 隐私 + 导出
│   ├── style-profile/        风格卡独立页面
│   ├── works/[id]/           生成作品详情
│   ├── article/[id]/         文章详情（含反馈按钮）
│   ├── materials/            素材库列表
│   └── add/                  添加素材
└── api/                      API 路由（详见下表）

lib/                          工具库（详见下表）
components/                   UI 组件
├── sidebar.tsx               左侧导航栏
├── auth-provider.tsx         全局 Auth 状态 Provider
└── ui/                       shadcn/ui 基础组件

supabase/
└── setup.sql                 数据库一键脚本（表/RLS/RPC/索引）
```

---

## lib/ 模块索引

| 文件 | 导出 | 职责 | 被谁用 |
|---|---|---|---|
| [constants.ts](file:///lib/constants.ts) | `CATEGORIES`, `Category`, `toCategory` | 内容分类枚举（电影解说、短剧解说…） | dashboard, generate, publish, scripts, inspirations, upload-image |
| [supabaseClient.ts](file:///lib/supabaseClient.ts) | `supabase`, `getValidSession` | 前端 Supabase 客户端单例 + token 刷新 | 几乎所有客户端页面 |
| [supabaseServer.ts](file:///lib/supabaseServer.ts) | `createServerClient` | 服务端 Supabase 客户端（接收 Bearer token） | feedback, inspirations, prompt-optimizer, style-profile |
| [storage.ts](file:///lib/storage.ts) | `authenticateWithToken`, `extractBearerToken`, `validateImageFile`, `uploadImageToStorage`, `cleanupFile`, `generateImageDescription`, `generateEmbedding` | 公共函数：鉴权、图片上传/校验/清理、视觉描述、嵌入生成 | posts, follows, profile, comments, interactions, export-data, upload-image, scripts |
| [styleVector.ts](file:///lib/styleVector.ts) | `parseVector`, `averageVectors`, `updateUserStyleVector` | 风格向量解析、平均、加权更新（0.8*old + 0.2*new） | posts, scripts, style-profile, posts(route GET) |
| [styleMemory.ts](file:///lib/styleMemory.ts) | `getMemoryEntry`, `setFavorite`, `clearMemory`, `buildMemorySummary` 等 | 前端 localStorage 风格记忆（收藏/偏好记录） | generate, article, works |
| [works.ts](file:///lib/works.ts) | `GeneratedWork`, `makeWorkId`, `getWorks`, `getWork`, `saveWork`, `patchWork`, `deleteWork` | 前端 localStorage 作品持久化（含版本归属/诊断/improveNote） | dashboard, article, generate |
| [generationTask.ts](file:///lib/generationTask.ts) | `GenerationParams`, `GenerationTask`, `getTask`, `startGenerationTask` | 跨页面生成任务状态管理（轮询作品落盘；improve 定向迭代模式） | generate, article |
| [scrollMemory.ts](file:///lib/scrollMemory.ts) | `saveDashboardState`, `consumeReturnNavigation`, `restoreDashboardScroll`, `backToDashboard` | 素材库列表滚动位置记忆（sessionStorage + popstate 判定 + rAF 精确恢复） | dashboard, article, works(重定向页) |
| [creative/styleLearning.ts](file:///lib/creative/styleLearning.ts) | `applySignals`, `formatStyleDimensions`, `recordVersionSignal`, `recordDirectionSignal` | 个人风格五维画像加权增量均值（仅服务端，失败静默） | prompt-optimizer, feedback, creative/projects |
| [creative/creatorUnderstanding.ts](file:///lib/creative/creatorUnderstanding.ts) | `readCreatorUnderstanding`, `LAYER_WEIGHTS`, `understandingLevelMeta` | **Creator Intelligence 统一读取层**：六路（memory/interest/report/knowledge/style/editing）聚合出 readiness/percent/level + 每路置信度 + 缺口引导。纯函数、不读库、不建表 | creator-status, （未来的统一读者） |
| [creative/creatorContext.ts](file:///lib/creative/creatorContext.ts) | `buildCreatorContextBlocks`, `CreatorContextBlocks` | **生成链路注入装配器**：方案/蓝图/正文三处共用同一份「注入哪些块、什么顺序、多少预算、哪些是硬禁忌」 | plan, blueprint, prompt-optimizer |
| [creative/tasteView.ts](file:///lib/creative/tasteView.ts) | `buildTasteView`, `TASTE_SOURCE_LABEL` | **Taste 合成视图**：声明 / DNA 报告 / 修改行为 / 兴趣统计四路合成 likes/avoids/depth，每条带来源与置信度（noisy-OR 合并）。**不注入 prompt**（editing 原始块已注入） | style-profile |
| [creative/consistencyCheck.ts](file:///lib/creative/consistencyCheck.ts) | `checkConsistency`, `CONSISTENCY_VERDICT_META` | **创作一致性三问**：是否符合你的知识 / 兴趣 / 是否踩禁忌。字面匹配 + 硬门槛，判不了的一律回 `unknown` | analyze, diagnosis-card |
| [creative/publishPerformance.ts](file:///lib/creative/publishPerformance.ts) | `computePublishPerformance`, `fetchPublishFacts` | **发布表现事实包**：posts 点赞/收藏/评论聚合，样本不足时给 caveat 而非空排名 | publish-performance（无 UI） |
| [creative/creatorModel.ts](file:///lib/creative/creatorModel.ts) | `formatCreatorModel`, `PersonalizationEvidence` | Creator Model → prompt 人格块（9.6 DNA 报告优先、9.5 散列回退；手动人格名优先于 AI 命名；排斥硬禁忌）+ 个性化证据结构 | prompt-optimizer, creative/blueprint, article |
| [creative/creatorReport.ts](file:///lib/creative/creatorReport.ts) | `parseCreatorReport`, `buildStatsBrief`, `parseLlmDraft`, `assembleCreatorReport`, `computeConfidence`, `formatCreatorReportForPrompt` | 版本化创作 DNA 报告：主/副人格、主题/叙事 DNA（AI 标签必须引用真实样本，权重按引用篇数服务端重算）、语言 DNA、置信度 | style-profile/summarize, creatorModel |
| [creative/languageStats.ts](file:///lib/creative/languageStats.ts) | `toneTagCounts`, `openingCounts`, `detectPace`, `computeBasicStats` | 确定性语言特征统计（语气命中/节奏/开头/均长），风格卡与 DNA 报告共用同一口径 | style-profile, creatorReport |
| [creative/styleProfileRepo.ts](file:///lib/creative/styleProfileRepo.ts) | `fetchCreatorStyleProfile` | style_profiles 生成链路统一读取入口；9.6 列缺失（42703）自动旧列降级，迁移顺序不阻断生成 | prompt-optimizer, creative/blueprint |
| [identityTemplates.ts](file:///lib/identityTemplates.ts) | `IDENTITY_TEMPLATES`, `identityToPrompt`, 自定义身份 CRUD | 生成页身份模板选择 + prompt 组装 | generate |
| [rateLimit.ts](file:///lib/rateLimit.ts) | `rateLimit` | 服务端请求限流（按 key + 时间窗口） | scripts, posts, upload-image |
| [utils.ts](file:///lib/utils.ts) | — | 占位文件（目前无有效导出） | — |

---

## app/api/ 路由索引

| 路由 | 方法 | 职责 | 关键依赖 |
|---|---|---|---|
| [/api/prompt-optimizer](file:///app/api/prompt-optimizer/route.ts) | POST | 生成系统提示词 + 范文；含风格向量检索、generation_history 写入 | supabaseServer, identityTemplates, storage |
| [/api/feedback](file:///app/api/feedback/route.ts) | POST, GET | 反馈提交（调用 submit_feedback RPC 事务）；GET 恢复反馈状态 | supabaseServer |
| [/api/scripts](file:///app/api/scripts/route.ts) | POST | 保存文案素材 + embedding + 风格向量更新 | constants, rateLimit, storage, styleVector |
| [/api/scripts/[id]](file:///app/api/scripts/[id]/route.ts) | DELETE | 删除指定素材 | supabaseServer |
| [/api/upload-image](file:///app/api/upload-image/route.ts) | POST | 上传图片到 Storage media 桶 | constants, rateLimit, storage |
| [/api/posts](file:///app/api/posts/route.ts) | GET, POST | GET 风格推荐信息流；POST 发布灵感（文字/图片→视觉描述→embedding→入库） | storage, styleVector, rateLimit |
| [/api/posts/from-project](file:///app/api/posts/from-project/route.ts) | POST | 作品→广场分享（work/inspiration/archive 三模式）：服务端从项目+版本行构建档案快照后入库（防伪造），复用 embedding 推荐链 | creative/archive, storage, rateLimit |
| [/api/posts/[id]](file:///app/api/posts/[id]/route.ts) | GET, DELETE | GET 帖子详情（get_post_detail RPC，含 archive 快照/作者名/互动态）；DELETE 删本人帖（含图片清理） | storage |
| [/api/posts/[id]/interactions](file:///app/api/posts/[id]/interactions/route.ts) | POST, DELETE | 点赞/收藏 toggle（乐观计数 RPC） | storage |
| [/api/posts/[id]/comments](file:///app/api/posts/[id]/comments/route.ts) | GET, POST | 评论列表 + 发表评论 | storage |
| [/api/follows](file:///app/api/follows/route.ts) | POST, DELETE | 关注 / 取消关注 | storage |
| [/api/profile/[userId]](file:///app/api/profile/[userId]/route.ts) | GET | 个人主页数据（调用 get_user_profile RPC） | storage |
| [/api/style-profile](file:///app/api/style-profile/route.ts) | GET, POST | GET 自动统计/返回风格卡；POST 手动编辑、向量更新或 `{recompute:true}` 确定性重算语言事实（不碰人格/画像） | supabaseServer, storage, styleVector, languageStats |
| [/api/style-profile/summarize](file:///app/api/style-profile/summarize/route.ts) | POST | 手动触发「AI 重新理解我」→ 版本化创作 DNA 报告（统计包+AI 归纳+证据校验+权重服务端重算）；在途请求折叠、错误码分型、限流 3/10min | supabaseServer, creatorReport, languageStats, styleLearning |
| [/api/inspirations](file:///app/api/inspirations/route.ts) | GET | 推荐选题（分类模板 + 素材参考） | supabaseServer, constants |
| [/api/export-data](file:///app/api/export-data/route.ts) | GET | 导出用户全部数据为 JSON 下载 | storage |
| /api/creative/blueprint | POST | 创作蓝图（仅登录）：DeepSeek JSON 模式输出 10 维蓝图 | creative/blueprint |
| /api/creative/analyze | POST | AI 五维诊断（仅登录/本人作品）：写回 generation_history.analysis，幂等 + force | creative/diagnosis |
| /api/creative/projects/adopt | POST | 老作品纳入持续创作（仅登录）：用现有内容建 creative_projects + V1 行，幂等（已归属则直接返回） | supabaseServer |
| /api/creative/projects/[projectId] | GET/PATCH | GET 版本列表（含 blueprint/analysis/improve_direction/improve_note）；PATCH {status} 定稿/重开（定稿记强风格信号），仅本人 | creative/diagnosis |

---

## 功能模块 → 文件映射

### 1. 内容生成（核心流程，创作进化系统阶段 2：两阶段）
```
用户在 /generate 填表
  → lib/generationTask.ts startGenerationTask() 发起异步任务（同 id 再调会 abort 旧任务）
  → 【登录用户】① POST /api/creative/blueprint → lib/creative/blueprint.ts
      DeepSeek(json_object) 生成创作蓝图（定位/观众/结构/情绪/Hook/冲突/升华/策略/人格）
      结果页 /article 立即展示蓝图，默认不停顿自动续写；「换个方向」replanGeneration() 中断重构思
    【游客/蓝图失败】跳过此步，降级旧路径
  → ② POST /api/prompt-optimizer（携带 blueprint）
    → 查 style_profiles 获取风格向量 + 维度
    → SiliconFlow bge-m3 生成 topic embedding
    → 混合 0.7*topic + 0.3*style_vector
    → match_scripts RPC 检索参考素材
    → DeepSeek LLM 两次调用（蓝图注入两次 prompt，正文必须按蓝图结构/Hook/冲突/升华）
    → 写 generation_history（含 embedding + blueprint jsonb）
  → lib/works.ts saveWork() 落盘 localStorage（含 blueprint）
  → 跳转 /article/[id] 展示（/works/[id] 已收缩为 router.replace 重定向兼容层，老链接不失效）
```
关键文件：lib/creative/blueprint.ts（类型+LLM+prompt 拼装）、components/creative/blueprint-card.tsx（蓝图卡片）
任务状态机：pending（构思/撰写中）→ blueprint（蓝图就绪续写中）→ writing → done/error
结果页轮询：进行中任务优先于 localStorage 旧作品（否则再来一版 thinking 会卡死），reloadTick 可重启轮询

### 1a-bis. 个人数据注入：唯一装配口径（改动前必读）

三处生成入口**禁止各自手拼个人数据块**，一律调 `buildCreatorContextBlocks()`：

```
style_profiles（单表多列）
  → lib/creative/creatorContext.ts buildCreatorContextBlocks({ stage })
      · styleText     风格统计 + 五维画像
      · creatorText   人格（DNA 报告优先）→ 用户声明 → 修改偏好记忆
      · interestText  长期关注领域（行为统计观察，软参考）
      · avoid[]       硬禁忌合集（人格排斥 + 声明排斥 + 高置信拒绝过的改法）
  → plan（stage='plan'）/ blueprint（stage='blueprint'）/ prompt-optimizer（stage='article'）
```

三条铁律：
1. **块集合不可配，阶段措辞可配。** `stage` 只影响指令句，不影响注入哪些块 ——
   此前 `editing_profile` 只进正文就是这么漂移出来的。
2. **优先级**：用户主动声明 > AI 推断人格 > 用户修改行为 > 行为统计观察。
3. 素材 / 知识这类需要异步检索的块**不进装配器**（召回口径本就不同），仍由各路由处理。

「AI 有多懂这个用户」只有一个答案：`readCreatorUnderstanding()`（六路加权），
由 `/api/creator-status` 对外暴露；dashboard 展示的是兴趣画像口径，已改名避免混淆。

**扩维时的两条硬规则**（2026-09-24 新增身份三问时定下）：
1. 新增维度是**加分项不进分母** —— 进分母会让已访谈老用户理解度一夜下降。
2. 老用户走**增量补问**（`interviewTrigger` 的 `supplement`）而不是全量重访。

**「这篇像不像我」与「这篇好不好」分开**：三镜头诊断回答后者，
`checkConsistency()` 回答前者；判不了的三问一律 `unknown`，不编造结论。

### 1b. 创作进化系统（建设中，分阶段）
```
阶段 2（已完成）：创作蓝图生成 + 自动续写 V1 + 换个方向
阶段 3（已完成）：creative_projects + generation_history(project_id, version_number) 版本管理
  · 有蓝图+登录：新建项目并 INSERT V1（行 id = `${projectId}::v1`）；再来一版带 projectId → INSERT V2/V3，旧版本绝不覆盖
  · 无蓝图/项目写库失败：降级旧模式 upsert 单行
  · GET /api/creative/projects/[id] 返回版本列表；/article 页版本 tab，旧版本只读
  · localStorage 作品新增 projectId/versionId/versionNumber（versionId 才是 generation_history 真实行 id，反馈接口用它）
阶段 4（已完成）：analysis jsonb：五维诊断（定性为主）+ Next Creative Actions 卡
  · 正文落盘后前端自动 POST /api/creative/analyze（仅登录）；结果写 generation_history.analysis + 回填 localStorage
  · 五维 opening/structure/emotion/style_fit/virality：1-5 级信号条 + 突出/良好/中规中矩/偏弱/待提升（无百分制）
  · 优势/问题/建议各 2-4 条 + 6 类方向卡 hit/style/emotion/depth/video/script
  · 幂等：已有诊断直接返回；force=true 重新计费；历史版本手动诊断；游客/无库行 404 静默隐藏
阶段 5（已完成）：持续迭代闭环 + 个人风格学习
  · 点方向卡 → generationTask improve 模式（跳过蓝图）→ prompt-optimizer improve 分支从 fromVersionId 行
    继承全部参数+蓝图+诊断，按 direction 重写 INSERT 新版本（generation_history.improve_direction 记方向）
  · 7 类方向：hit/style/emotion/depth/video/script（AI 诊断推荐）+ custom（用户一句话指令，最高优先级；
    不记风格维度信号）；custom 必须带 instruction，否则 400
  · improve_note：迭代写作走 JSON 模式 {article, improveNote}，"AI 为什么这样修改"与正文分离落库
    （improve_note 列）；LLM 不遵守 JSON 时降级纯文本正文，不阻断版本生成
  · PATCH /api/creative/projects/[id] {status: finalized|active}：定稿最终作品（status 已有列），版本 tab 徽标/方向卡禁用
  · 最新版诊断五维与上一版对比（↑↓→ 箭头）；版本 tab 带迭代方向 emoji；版本元信息条展示版本名/时间/方向/修改说明
  · 历史版本可直接作为迭代来源（fromVersionId 指向旧版，新版本仍线性追加链尾，不做分叉，旧版本永不覆盖）
  · lib/creative/styleLearning.ts：style_profiles.style_dimensions = {dims,samples} 加权增量均值
    信号：like ×1 / dislike ×0.5 反向 / 定稿 ×2 / 选方向 ×0.5 拉升目标维；样本<2 不注入
    注入点：blueprint API + prompt-optimizer（formatStyleDimensions）；feedback API 写 like/dislike 信号
素材库链路（阶段 5 收尾）：
  · dashboard 作品统一跳 /article/[id]；/works/[id] = replace 重定向兼容层
  · POST /api/creative/projects/adopt：老作品（无 projectId）纳入持续创作——建项目+V1 行（blueprint=null），
    幂等；纳入后自动触发该版五维诊断，版本/迭代/定稿链路全部激活，无老作品专属 UI 分支
  · lib/scrollMemory.ts：列表→详情跳转前存 scrollTop+筛选（sessionStorage），仅 popstate 返回挂载恢复；
    rAF 按最新 scrollHeight 校验恢复（不用固定延迟）；详情页 backToDashboard 双模（back / push）
完整链路：灵感(topic) → creative_projects → generation_history V1/V2/V3…（每版 analysis + 7 方向 + improve_note）
         → 可基于任意旧版继续迭代 → finalized 最终作品
```

### 1c. Work Agent（AI 共创协作体）

> 把「继续优化」从「一句反馈 → AI 全文重写」升级为「加载上下文 → 多轮对话 → 用户点选 → 局部修改 → 落新版本」。
> 前端入口 `components/creative/work-agent-chat.tsx`（已替换 `work-feedback-panel.tsx`，后者保留供回滚）。

```
用户输入想法
 → POST /api/creative/work-agent/chat  action=say
     assembleWorkContext() 装配 7 类上下文
     clarifyIntent()         → 2-4 个候选含义（每个带 evidence）
     用户点选
 → action=select_intent
     proposeRevisions()      → 2-3 个修改方案（含 preserveItems 承诺）
     用户点选
 → action=select_plan
     strategy=patch   → generateEditPatches()（已注入全上下文）→ 补丁预览 → 用户接受
     strategy=rewrite → 回前端走 handleImprove('custom', instruction) 全文重写
     接受后 → /api/creative/patch/decide  → 服务端 applyPatches → INSERT V(N+1)
                                          → 回写 session_id / revision_plan
                                          → 会话 status=applied
```

| 文件 | 职责 |
|---|---|
| `app/api/creative/work-agent/session/route.ts` | 会话生命周期（创建/恢复/放弃）；刷新后对话不失忆 |
| `app/api/creative/work-agent/chat/route.ts` | 三阶段状态机（say / select_intent / select_plan） |
| `lib/creative/workAgentContext.ts` | 上下文装配唯一出口 + `formatContextForPrompt()` 文本化 |
| `lib/creative/workAgentMode.ts` | **输出模式路由**（纯规则）：companion / discuss / suggest / direct |
| `lib/creative/workAgentDialogue.ts` | **讨论 / 陪伴模式回应**（只分析 + 提问，不给候选按钮） |
| `lib/creative/revisionGuard.ts` | **修改守门**（纯规则）：识别会伤害作品的改法并给替代方案 |
| `lib/creative/preferenceReason.ts` | **"为什么改"抽取**：「不要太像新闻」→ 避开新闻口径 + 偏好个人观点 |
| `lib/creative/intentClarifier.ts` | 阶段 1：模糊反馈 → 候选含义 |
| `lib/creative/revisionPlan.ts` | 阶段 2：已确认意图 → 多个修改方案 |
| `lib/creative/patchEngine.ts` | 阶段 3：段落补丁（已改造为接收 `contextText` + `plan`） |
| `lib/creative/workAgent.ts` | 全部纯类型 + 清洗函数 + DB 行映射（前端可安全引用） |

**输出模式路由（改动前必读）**：不是所有输入都是修改指令。
`say` 阶段先由 `detectInteractionMode()` 判定模式，再决定走哪条路：

| 模式 | 触发示例 | 走向 |
| --- | --- | --- |
| `companion` | 「写出来没人看」「不知道写什么了」 | 陪伴回应：接住处境 + 基于真实上下文分析 + 一个最小动作，**不催改稿** |
| `discuss` | 「你觉得这篇最大的问题在哪」 | 讨论回应：我的理解 / 可能原因 / 建议方向 / 一个待确认问题 |
| `direct` | 「别问了直接改」 | 复用 `skipToPlan` 通道直达补丁（**跳过的是讨论，不是确认权**） |
| `suggest` | 「开头太平了」 | 既有三步流水线 |

判定顺序即优先级：`direct > companion > discuss > suggest(兜底)`。
未命中一律回退 `suggest`，保证只会更贴合、不会让既有链路退化。

**AI 必须携带的上下文**（`assembleWorkContext` 产出，三个阶段共用同一份，避免口径漂移）：
`work`（是哪篇）· `diagnosis`（现在什么毛病）· `goal`（用户最初想写什么，来自 blueprint.problem_understanding）
· `audience`（写给谁看，修改取舍的裁决依据）· `knowledge`（用户亲手确认过的知识单元）
· `revisionHistory`（这个作品前一版改了什么、依据哪句反馈）
· `creator`（谁写的，防统一 AI 文风）· `editing`（历史接受/拒绝偏好）· `materials`（用户自己的素材）· `external`（外部知识预留接口）

`knowledge` 必须与生成链路同一口径（复用 `buildKnowledgeInjection`）：
生成时遵守的主张，改的时候被改掉，等于替用户说了他不认同的话。
`revisionHistory` 只是三个轻字段（direction/note/feedback），目的是避免 AI 在同一轮里重提刚被否决的改法。

关键约束（改动前必读）：
- 任一步 LLM 失败都必须返回**可见**的降级提示，不静默跳到下一阶段
- 降级顺序：补丁失败 → 提示用户确认后改走全文重写；**绝不偷偷重写**
- 素材优先于 AI 编造；上下文中没有真实案例时，禁止编造具体数据
- 历史对话**不进** prompt（阶段输出已是用户确认过的结论）
- **守门只提示不阻拦**：`revisionGuard` 给出"我不同意"而不是"我不干"，用户坚持要改 AI 照改
- **禁止虚假鼓励**：陪伴/讨论模式下上下文没有正向证据时不许夸奖——空洞夸奖会削弱用户自己的判断力

**方向验收（Feedback Alignment）——改完必须核对「到底改没改对方向」**：

此前这条链路是单向的：生成出新版本就默认"改好了"，用户只能自己通读全文才能发现
AI 根本没按他说的改，或者顺手改掉了要求保留的部分。验收层把闭环补上。

| 文件 | 职责 |
|---|---|
| `lib/creative/feedbackAlignment.ts` | 验收核心：确定性预检 + LLM 逐条核对 + 结论由代码裁定（含测试 23 例） |
| `app/api/creative/alignment/route.ts` | 取服务端权威正文 → 核对 → 返回报告；校验不可用时返回 `report: null`，**不报错**（新版本已落库，验收只是锦上添花） |

判定规则（一律由 `verdictOf()` 裁定，不采信 LLM 自评）：
修改点全命中 + 保持项未破坏 + score ≥ 70 → `aligned`；任一保持项被破坏 → 最多 `partial`；score < 40 → `off`。

两条接入点：补丁链路（共创面板 accept 拿到 versionId 后自行发起）· 全文重写链路（父组件落盘后回传结果，复用同一张卡展示）。

**防卡死（改动前必读，这几条都踩过坑）**：
- `stage` 的语义只能是「**有请求在飞行中**」，绝不能用来表示「等待用户点选」——
  恢复会话时把 stage 设成 `propose`/`patch` 会让界面永久转圈且输入框禁用，而实际上没有任何请求在跑
- 对话请求带 90s 超时 abort；生成链路带 150s 超时并写回 error 终态
  （`AbortError` 由新任务主动中断时除外——那种情况不写 error，避免旧链路覆盖新任务状态）
- 前端轮询（300ms）必须有收敛上限，且**每个失败分支都要复位 `improvingDirection`**，
  否则共创面板与方向卡会永久停留在"进行中"
- 服务端降级（没能拆出候选 / 没能给出方案）必须能继续推进：
  缺候选时用用户原话构造 custom 意图、缺方案时用保底方案，
  **不能 400**——那会把用户晾在"我没能拆成候选"这句提示上，界面等同卡死

### 1d. 语言一致性（Language Consistency）

> LLM 输出语言跟随用户输入，而不是全部硬编码成中文。

```
用户在文本框写的东西 ──► detectLanguage() ──► resolveTargetLanguage()
                                                      │
                     ┌────────────────────────────────┘
                     ▼
            languageDirective(lang) 注入 system prompt
                     ▼
            callDeepSeekChat 发起请求
                     ▼
            checkLanguageConsistency(输出) ──不一致──► 剩余预算内自纠偏重试一次
```

| 文件 | 职责 |
|---|---|
| `lib/languageConsistency.ts` | 检测 / 指令 / 守卫三层纯函数（含测试 `lib/languageConsistency.test.ts`） |
| `lib/llm.ts` | LLM 网关层统一接管：注入指令 → 校验输出 → 自纠偏重试 |

三层缺一不可：
- **检测**：Unicode script 统计（含 URL/代码/数字剥离、简繁字表、拉丁语系特征词），确定性、不烧 token
- **指令**：替换原先散落的「所有内容用中文」；显式豁免技术字段（`intent_type` / `strategy` / `modification_area` / `slug` / `content_type`），否则「请用中文输出」会把下游 switch 依赖的枚举值本地化
- **守卫**：跑偏时在剩余预算内重试一次；预算不足或调用方关闭重试时保留首次结果——语言瑕疵好过内容丢失

**语言裁决权重按链路而异**（这是最容易搞错的一点）：

| 链路 | 语言以谁为准 | 理由 |
|---|---|---|
| `patchEngine` 局部修改 | **成稿正文** > 反馈 | 英文反馈要求改中文稿时，补丁必须仍是中文 |
| `diagnosis` 五维诊断 | **成稿正文** > topic | 点评一篇英文稿却给中文结论无法对照使用 |
| `plan` / `prompt-optimizer` 生成 | **用户 topic** | 创作者亲笔写的表达最能代表期望语言 |
| `feedbackAnalyzer` / `intentClarifier` / `revisionPlan` | **用户即时反馈** | 对话式回应应跟随用户此刻的发言 |

未传给网关 `language` 参数的调用点行为与改造前逐行等价，不产生回归。

### 2. 反馈系统
```
/article/[id] 四个反馈按钮（乐观更新 + 失败回滚；like/dislike 再点取消；单按钮精准 pending）
  → /api/feedback POST { feedbackType, generationId, ... }
  → submit_feedback RPC（原子事务：补建历史 → 插反馈 → 更新状态；同类型再提交 = toggle 置 null，事件日志仍 append-only）
  → /api/feedback GET 按版本行 id 对账恢复按钮状态（含 null；POST 飞行中不覆盖乐观态）
  → like/dislike 成功后记风格信号（取消不记）
```

### 3. 风格向量
```
触发更新的三个场景：
  a. 发布帖子 → /api/posts POST → lib/styleVector.ts updateUserStyleVector()
  b. 保存素材 → /api/scripts POST → 同上
  c. 手动更新 → /api/style-profile POST updateVectorFromText

GET /api/style-profile → 从 scripts + generation_history embedding 求平均
  → 存入 style_profiles.style_vector
```

### 4. 社交平台
```
发布：/publish → /api/posts POST（图片走 Storage + 视觉模型）
  作品分享：/article/[id] → ShareToPlazaModal → /api/posts/from-project
    模式 work/inspiration = moment 帖；archive = 创作档案帖
    posts 扩展列：post_type(moment|archive) / archive(jsonb 发布时只读快照) / source_project_id
    广场 archive 帖走 ArchivePostCard 创作卡 → /post/[id] 叙事详情（get_post_detail RPC）
浏览：/explore → /api/posts GET（get_recommended_posts RPC 按风格相似度排序）
互动：/api/posts/[id]/interactions（toggle）+ /api/posts/[id]/comments
关注：/api/follows POST/DELETE
主页：/profile/[userId] → /api/profile/[userId] GET（get_user_profile RPC）
```

### 5. 认证流程
```
前端：supabaseClient.ts supabase.auth → session 存 localStorage
  → components/auth-provider.tsx 监听 onAuthStateChange 全局管理
服务端：请求头 Authorization: Bearer <token>
  → lib/storage.ts extractBearerToken + authenticateWithToken
  → 或 lib/supabaseServer.ts createServerClient(token)
```

---

## 数据库表索引（详见 setup.sql）

| 表 | 用途 | 主键 | RLS |
|---|---|---|---|
| scripts | 素材库（含 embedding 向量） | uuid | 用户只能读写自己的 |
| generation_history | 生成历史（embedding；版本列 project_id/version_number/blueprint/analysis/improve_direction/improve_note/user_feedback/edit_patches/session_id/revision_plan；版本行 id 为 `${pid}::v${N}`） | text（前端 UUID） | 用户只能读写自己的 |
| creative_projects | 创作项目（title/topic/status:active\|finalized/current_version） | uuid | 用户只能读写自己的 |
| work_agent_sessions | Work Agent 共创会话（project_id/base_version_id/status:active\|applied\|abandoned/phase:clarify\|propose\|apply\|done） | uuid | 用户只能读写自己的 |
| work_agent_messages | Work Agent 对话轨迹（role/kind/payload/selected_index；selected_index 记录用户挑了第几个，是偏好分析的核心信号） | uuid | 只能读自己的，仅可 insert（不可篡改历史） |
| generation_feedback | 反馈记录 | uuid | 用户只能读写自己的 |
| style_profiles | 风格卡（style_vector + style_dimensions 五维画像）与 Creator Model（creator_personality/topic_preferences/favorite_elements/avoid_elements 用户声明；ai_creator_summary/model_meta AI 归纳） | user_id | 用户只能读写自己的 |
| posts | 社交动态（style_vector；post_type=moment\|archive，archive 存创作档案快照，source_project_id 溯源） | uuid | 公开帖可读，只能改自己的 |
| post_interactions | 点赞/收藏记录 | uuid | 全部可读，只能增删自己的 |
| comments | 评论 | uuid | 全部可读，只能增删自己的 |
| follows | 关注关系 | uuid | 全部可读，只能增删自己的 |
| user_style_matches | 风格相似度缓存 | uuid | 只读与自己相关的 |

### RPC 函数索引

| 函数 | 职责 | 类型 |
|---|---|---|
| match_scripts | 向量相似度检索素材 | SECURITY INVOKER |
| submit_feedback | 反馈事务（补建历史+插反馈+更新状态） | SECURITY INVOKER |
| get_posts_with_authors | 帖子列表（join auth.users） | SECURITY DEFINER |
| get_recommended_posts | 风格推荐帖子列表 | SECURITY DEFINER |
| get_post_comments | 评论列表（join auth.users） | SECURITY DEFINER |
| get_user_profile | 个人主页完整数据 | SECURITY DEFINER |
| increment_post_count | 帖子计数+1 | SECURITY DEFINER |
| decrement_post_count | 帖子计数-1（不低于0） | SECURITY DEFINER |

---

## 约定速查

- **鉴权**：客户端 `Authorization: Bearer ${session.access_token}`；服务端 `authenticateWithToken()` 或 `createServerClient(token)`
- **限流**：文本 10 次/分钟，图片/LLM 5 次/分钟（`lib/rateLimit.ts`）
- **向量维度**：统一 1024（bge-m3 模型）
- **事务**：跨表写操作用 Postgres RPC 函数（Supabase JS 客户端无跨表事务）
- **布局**：内页用 `.inner-page` + `.inner-container`，max-width 800px 居中
- **分类字段**：所有 Supabase 操作必须包含 `category` 字段
- **localStorage 去重**：`getWorks()` 读取时按 id 去重

---

## Creator Knowledge System（创作者知识系统）

> 一句话：**AI 负责「归纳」，人负责「确认」** —— 只有用户亲手确认过的知识，才允许参与生成。
> 这套系统把「创作者知道、但 AI 不知道」的东西，变成 AI 写稿时真正拿来用的论据。

### 三层数据结构（责任边界严格分离）

| 层 | 落点 | 谁写 | 含义 |
| --- | --- | --- | --- |
| 素材理解 | `scripts.knowledge`（6 维标签 + `claims`） | AI | 「这条素材具体说了什么」 |
| 知识单元 | `creator_knowledge`（跨素材归纳） | AI 提候选，**人确认** | 「创作者总体上持什么主张」 |
| 生成注入 | plan / blueprint / prompt-optimizer 的 prompt 块 | 运行时 | 「这次创作实际用上了哪些主张」 |

### 四个阶段

1. **理解** —— `/api/creative/analyze-knowledge` → `knowledgeAnalyzer`：抽取单条素材的 6 维标签与 claims
2. **归纳** —— `/api/creative/knowledge/build` → `knowledgeAggregator`：跨素材分组，LLM 归纳成「候选」单元
   - 只 upsert 自己历史上产生的单元，**用户人工编辑过的单元永不被 AI 覆盖**
   - 同一 `source_item_id` 只计一次证据（`mergeSources`），重复素材不重复加权
3. **确认** —— `/api/creative/knowledge/[id]` PATCH：用户在 `/knowledge` 把候选提升为「已确认」
   - **这是唯一的授权闸门**，AI 侧没有任何路径绕过
4. **注入** —— Phase 3：`knowledgeInject` 在生成时读取「已确认 + 置信度 ≥ 0.6」的单元，
   已在**三条链路**全部接通（见下节）

### 注入口径（关键设计）

迁移 0005 原本设想「`domain_scope` 数组 `&&` 重叠粗筛 + LLM 仲裁」，但落地时 `domainScope`
的值是 LLM 从用户素材里提炼的**自由文本**（并非受控词表），对着自由文本做数组等值重叠
几乎必然落空。因此改为沿用 `lib/material/retrieval.ts` 已有的「主题词字面交集」口径：

- 权重：`concept` 命中 3 分，`domainScope` 每个命中词 2 分
- 同一词条出现在多个字段时**只计一次**，避免同一信号重复加权、挤掉真正相关的单元
- 长度 < 2 的词不参与匹配（中文单字必然误命中）
- 排序「相关度 → 置信度 → id」三级兜底，**同输入必得同输出**，便于复现与回归
- 单次最多注入 `MAX_INJECT_UNITS`（5）条

这条选择同时守住了迁移里更硬的一条原则 —— **不为知识单元再建一套向量检索**：
打分是纯函数、零额外 token、可单元测试，不存在「人类查 TK、AI 另有一套 ESA」的口径分裂。

### 注入点：三条链路，同一口径

| 链路 | 文件 | 注入位置 | 回传 |
| --- | --- | --- | --- |
| AI 创作方案 | `app/api/creative/plan/route.ts` | `GeneratePlanInput.knowledgeText` → `buildUserPrompt` | `usedKnowledgeUnits` |
| 创作蓝图 | `app/api/creative/blueprint/route.ts` | 追加进 `styleProfileText` | `usedKnowledgeUnits` |
| 正文生成 | `app/api/prompt-optimizer/route.ts` | 拼接进写正文的 system prompt | `usedKnowledgeUnits` |

**为什么方案阶段就要注入，不能只留给正文**：方案决定「写什么、从哪个角度写」，
正文只决定「怎么写」。若只有正文侧知道这些命题，AI 可能早在方案阶段就定了一个
与该创作者已知结论相悖的方向，等正文再补救已经晚了——方向一旦错了，
文笔再贴合也是替他说了不认同的话。

方案阶段的 prompt 因此额外约束：**推荐方向优先采纳相关命题作为论述支点，
三个方向均不得与这些命题相矛盾**。

蓝图链路仅在 `plan.mode === 'creator'` 时注入，与风格卡完全同口径：
灵感模式要求剥离全部隐性个人数据，而知识单元是用户多条素材的交叉归纳，
比风格卡更私人，这里不能破例。

### 用户侧可见性

「AI 到底有没有用上我的知识」以前无从核对（`/knowledge` 上的「注入生成中」徽标
只画在 UI 上，生产链路无人调用）。现在方案态直接给出答案：

- `/generate` 方案态 → `PlanPanel` 顶部「本次参考了你的 N 条知识」卡片
- 展示 `concept` / `kind` / `claim` 原文，可一键跳转 `/knowledge` 管理
- **空数组时不渲染任何东西** —— 没用到就是没用到，不给假的「注入中」提示
- 前端只用 `import type` 引入 `InjectedUnitSummary`，编译后被完全擦除，不增加浏览器包体积
- 刻意不回传 `sourceItemIds`：那是素材溯源信息，属于内部债务追踪，没有理由出现在给浏览器的响应里

### 注入留痕：历史作品可复盘（`generation_history.used_knowledge`）

响应里的 `usedKnowledgeUnits` 只活在当次 HTTP 请求里，刷新即消失——于是历史版本
永远答不上来「这一版当时是拿着哪几条知识写的」。迁移 `0006_generation_used_knowledge.sql`
补上这最后一环：知识单元快照随版本行落库，成为可读的教育尚可的一部分。

- **写入**：`prompt-optimizer` 的 `versionRow.used_knowledge`。`versionRow` 被项目新版本 /
  新建项目 V1 / 降级 upsert 三个分支共用，改一处即覆盖全路径；
  与响应里的 `usedKnowledgeUnits` 取同一个 `summarizeInjectedUnits` 结果，
  避免「页面当时说参考了 3 条、历史里只剩 2 条」的口径分裂
- **读出**：`GET /api/creative/projects/[projectId]` → 每版本 `usedKnowledge`
  （经 `normalizeInjectedUnits` 校验）
- **展示**：`/article/[id]` 的「本次参考了你的 N 条知识」卡片，随版本切换展示该版本当时的依据；
  查看历史版本时额外提示「记录可能与现在的知识库已有出入」
- **空值语义**：空数组一律存 `null` —— 区分「确实没参考知识」与「该行早于本列上线」
- **JSONB 快照而非关联表**：快照是「生成当时的事实」，用户之后改 claim 措辞、撤回确认、
  标为已过期，都不应改写历史。外键 join 会让历史随当前行漂移
- **不可信输入**：jsonb 里躺什么形状取决于写入那天的代码版本，回读一律走
  `normalizeInjectedUnits` 逐字段校验；缺 `concept`/`claim` 的条目直接丢弃
  （宁可少展示一条，也不把 `undefined` 渲染给用户）

### 降级约定

知识是增强项，不是主链路的必经节点。表未迁移（42P01）、查询报错、数据异常时
一律返回空并跳过注入，**绝不阻断生成**；灵感模式与游客也读不到任何知识单元。

---

## 登录态稳定性：为什么禁止裸调 getSession()

曾经有一类难以复现的故障：用户在 `/generate` 停留一段时间后点「生成文章」，
或切到某个页面时突然 401「登录已过期」。根因不是会话真的失效，
而是**保护写了却没铺开**：

- `getValidSession()` 具备完整防过期能力（提前 120 秒刷新、并发共享同一次刷新、
  刷新失败不直接判未登录），但它一度只在 `add` / `materials` / `knowledge` 三处使用；
- 其余调用点直接裸调 `supabase.auth.getSession()` —— 它**只读 localStorage 缓存、
  不做任何刷新**。SDK 的 `autoRefreshToken` 在标签页休眠、被浏览器节流或内部 tick
  失败时并不保证执行，于是停留超过 JWT 有效期后，这些点取到的就是过期 token。

**约定：客户端取会话一律走 `getValidSession()`，禁止裸调 `getSession()`。**

### 网络故障 ≠ 未登录：为什么服务端不许把「查不动网络」翻译成 401

与上面并列的第二类「假掉线」，根因在**服务端的错误翻译**：

`supabase.auth.getUser()` 在网络故障时**不抛异常**，而是把
`AuthRetryableFetchError`（`name='AuthRetryableFetchError'`、`status=0`、
`message='fetch failed'`）作为 error 原样返回。若沿用
`if (error || !user) return 401`，一次网络抖动就被判定成「登录已过期」，
前端拿到 401 又普遍处理为「踢回 /login」——用户看到的是莫名其妙被登出，
而回到登录页后登录请求走的还是同一条网络，于是彻底登不进去。
浏览器侧的 `Failed to fetch` 与服务端的 401 常常是同一个根因的两种表现。

**约定：服务端一律用 `authFailureResponse()`（`lib/apiAuth.ts`）翻译鉴权失败。**

- 传输故障（`AuthRetryableFetchError` / `status=0` / 网络类错误信息）→ **503 + `retryable: true`**
- 真正的凭证失效（`AuthApiError` 且带 4xx 状态码，说明请求**到达了**服务端）→ 401

**前端对称约定：只有 401 才允许 `router.push('/login')`；503 必须提示重试，
不许当作未登录处理。** 参考实现见 `app/(main)/inspiration-feed/page.tsx`。
护栏测试在 `lib/apiAuth.test.ts`：「任何网络类错误都不得再返回 401」。

配套禁忌：**服务端不得参与 token 轮换**。Supabase 的 rotation 语义是
「一次刷新成功后，旧 refresh_token 立即作废」，浏览器下一次刷新即
`Invalid Refresh Token`，表现同样是"莫名掉线"。因此服务端创建 Supabase 客户端
必须走 `createServerClient()`（显式关闭 `persistSession` / `autoRefreshToken`），
禁止在 API 路由里直接 `createClient()`。

但逐个替换几十处调用点无法根治（必然漏），所以 `AuthProvider` 额外加了一层根部保鲜：

- 定时器对齐到「过期前 5 分钟」触发一次 `getValidSession()`，而非盲目轮询；
- `visibilitychange`（可见）与 `window.focus` 时立即验活并重算调度 ——
  「切回页面就 401」正是这个场景：离开期间错过刷新窗口，回来时本地 session 已过期，
  而 UI 仍停留在已登录状态。

这层保鲜让既有的全部调用点自动受益：session 一直是新的，无论谁去读都不会读到过期值。
重耗时链路（如 `generationTask` 的生成流程）则仍应在出发那一刻显式调用
`getValidSession()`，因为「请求正在飞行途中过期」是根部保鲜覆盖不到的窗口。

### 涉及的表

| 表名 | 用途 | 主键 | RLS |
| --- | --- | --- | --- |
| `creator_knowledge` | 创作者知识单元（跨素材归纳；status：候选 / 已确认 / 已拒绝 / 已过期） | uuid | 用户只能读写自己的 |

### 涉及的路由

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/api/creative/analyze-knowledge` | POST | 素材理解：6 维标签 + claims |
| `/api/creative/knowledge` | GET | 列出知识单元（可按 status 过滤） |
| `/api/creative/knowledge/build` | POST | 跨素材聚合归纳，产出「候选」单元（绝不改写已确认） |
| `/api/creative/knowledge/[id]` | PATCH | 改 status（确认 / 拒绝 / 撤回）或修正 claim |
| `/api/prompt-optimizer` | POST | Phase 3 注入点：拼入知识块，并回传 `usedKnowledgeUnits` |

前端页面：`app/(main)/knowledge/page.tsx`

### 涉及的模块

| 模块 | 主要导出 | 作用 |
| --- | --- | --- |
| `lib/creative/knowledgeAnalyzer.ts` | `analyzeKnowledge`、`reAnalyzeKnowledge`、`normalizeAnalyzeResult` | 素材理解（含澄清提问） |
| `lib/creative/knowledgeItem.ts` | `CLAIM_KINDS`、`KnowledgeClaim`、`normalizeClaims` 等 | 素材级 claims 的结构定义与清洗 |
| `lib/creative/knowledgeUnit.ts` | `KNOWLEDGE_STATUSES`、`CreatorKnowledgeUnit`、`normalizeKnowledgeUnit`、`isUnitInjectable`、`needsReconfirmation`、`mergeSources` | 知识单元状态机 + 清洗 + 注入门槛判定 |
| `lib/creative/knowledgeAggregator.ts` | `groupClaims`、`UnitGroup`、归纳主流程 | 跨素材分组与候选归纳 |
| `lib/creative/knowledgeInject.ts` | `buildKnowledgeInjection`、`relevanceScore`、`selectUnitsForPrompt`、`formatKnowledgeForPrompt`、`summarizeInjectedUnits`、`normalizeInjectedUnits` | Phase 3：注入生成链路（确定性打分，零 token）+ `used_knowledge` jsonb 回读校验 |
