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
| generation_history | 生成历史（embedding；版本列 project_id/version_number/blueprint/analysis/improve_direction/improve_note；版本行 id 为 `${pid}::v${N}`） | text（前端 UUID） | 用户只能读写自己的 |
| creative_projects | 创作项目（title/topic/status:active\|finalized/current_version） | uuid | 用户只能读写自己的 |
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
