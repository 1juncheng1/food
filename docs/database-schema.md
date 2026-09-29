# 数据库表结构速查（视界 Vision）

> 生成依据：`supabase/setup.sql` + `supabase/migrations/0001~0023`，共 **28 张业务表**，全在 `public` schema。
> 除标注外，几乎所有用户表都外键 `auth.users(id)` 并 `on delete cascade`（删号即清数据）。
> 标记「**后补**」的字段，是建表之后用 `ALTER TABLE ADD COLUMN` 追加的——排查问题时最容易漏的就是它们。

---

## 0. 按意图速查

| 我想找… | 去这张表 |
|---|---|
| 某个用户有多少积分 | `user_balances` |
| 积分是怎么来的、谁改的 | `point_ledger` |
| 汇率 / 充值门槛 / 注册赠金 | `point_config` |
| 充值订单（用户提交了、还没确认） | `recharge_orders` |
| 收款码配置 | `payment_settings` |
| 谁是管理员 | `admin_users` |
| 用户上传的素材 | `scripts` |
| AI 生成的解说稿 / 作品版本 | `generation_history` |
| 用户对稿子赞了还是改了 | `generation_feedback` |
| 知识库条目 | `creator_knowledge` |
| 社区帖子 | `posts` |
| 点赞 / 收藏 | `post_interactions` |
| 评论 | `comments` |
| 谁关注了谁 | `follows` |
| 这个创作者的画像 | `style_profiles` |
| 用户创建的角色卡 | `user_characters` |
| 兴趣聚类结果 | `interest_clusters` |
| 给用户的创作建议 | `interest_suggestions` |
| 用户行为埋点 | `creator_events` |
| AI 工作台会话 / 消息 | `work_agent_sessions` / `work_agent_messages` |
| 外部素材抓取缓存 | `ci_items` |

---

## 1. 用户、权限与画像

### `admin_users` — 管理员白名单

| 字段 | 类型 | 说明 |
|---|---|---|
| `user_id` | uuid | **PK** → `auth.users(id)` cascade，等于 auth 里的用户 ID |
| `created_at` | timestamptz | 授予管理员的时间 |
| `created_by` | uuid | 谁授予的（可空） |

判断某人是不是管理员：看这张表有没有他的 `user_id`。SQL 里封装了 `public.is_admin()`。

---

### `style_profiles` — 创作者画像（每人一行）

`user_id` 就是主键，所以一个用户只有一份画像。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `user_id` | uuid | — | **PK** → `auth.users(id)` cascade |
| `tone_tags` | text[] | `{}` | 语气标签：犀利 / 幽默 / 温情 / 悬疑… |
| `pace_preference` | text | `'未知'` | 快节奏 / 慢节奏 / 中等 / 未知 |
| `common_opening` | text | `'未知'` | 常用开篇：提问式 / 叙事式 / 未知 |
| `avg_length` | integer | `0` | 内容平均字符数 |
| `source` | text | `'auto'` | `auto`=自动统计 / `manual`=手动编辑 |
| `updated_at` | timestamptz | now() | |
| `style_vector` | vector(1024) | — | **后补**：风格向量，相似匹配用 |
| `style_dimensions` | jsonb | `{}` | **后补**：多维风格评分 |
| `creator_personality` | text | — | **后补**：创作人格名，如「冷峻的都市观察者」 |
| `topic_preferences` | text[] | `{}` | **后补**：偏好题材 |
| `favorite_elements` | text[] | `{}` | **后补**：喜欢的元素（真实细节 / 反转 / 金句…） |
| `avoid_elements` | text[] | `{}` | **后补**：排斥元素（说教 / 烂尾…），生成时当**硬禁忌** |
| `ai_creator_summary` | text | — | **后补**：AI 写的「这个创作者是谁」总结（1-2 段） |
| `model_meta` | jsonb | `{}` | **后补**：`{summaryUpdatedAt, workSampleCount, signalCount}` |
| `creator_report` | jsonb | `{}` | **后补**：创作者报告 |
| `editing_profile` | jsonb | — | **后补**：剪辑偏好 |

---

### `user_characters` — 角色卡 / 解说身份

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | uuid | gen_random_uuid() | **PK** |
| `user_id` | uuid | — | → `auth.users(id)` cascade |
| `name` | text | — | 角色名，check 长度 1~30 |
| `background` | text | `''` | 身份背景（职业 / 经历 / 年龄），≤200 字 |
| `personality` | text | `''` | 性格特质与说话方式，≤200 字 |
| `role` | text | `'supporting'` | `protagonist` / `supporting` / `narrator` |
| `is_self` | boolean | `false` | 是否代表用户本人 |
| `created_at` | timestamptz | now() | |
| `updated_at` | timestamptz | now() | |

---

### `follows` — 关注关系

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid | **PK** |
| `follower_id` | uuid | → `auth.users(id)` cascade，发起关注的人 |
| `following_id` | uuid | → `auth.users(id)` cascade，被关注的人 |
| `created_at` | timestamptz | |

约束：`unique(follower_id, following_id)` 防重复关注；`check(follower_id <> following_id)` 禁止关注自己。

---

### `user_style_matches` — 风格相似用户配对

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid | **PK** |
| `user_id_1` | uuid | → `auth.users(id)` cascade |
| `user_id_2` | uuid | → `auth.users(id)` cascade |
| `similarity` | real | 0~1（有 check） |
| `updated_at` | timestamptz | |

约束：`unique(user_id_1, user_id_2)`。

---

## 2. 创作：素材、作品、稿子、反馈

### `scripts` — 素材库（用户上传/保存的原始材料）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid | **PK** |
| `user_id` | uuid | 所有者（**没有**外键约束，纯 uuid） |
| `content` | text | 素材正文，非空 |
| `type` | text | **后补**：素材类型 |
| `file_url` | text | **后补**：附件地址 |
| `category` | text | **后补**：分类 |
| `embedding` | vector(1024) | 向量，语义检索用 |
| `created_at` | timestamptz | |

> `material_usages.material_id` 指向这张表——素材的「使用记录」单独记。

---

### `creative_projects` — 作品（迭代容器）

一部作品会有很多版稿子，稿子挂在 `generation_history` 上。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | uuid | gen_random_uuid() | **PK** |
| `user_id` | uuid | — | → `auth.users(id)` cascade |
| `title` | text | — | 作品名（通常取主题） |
| `topic` | text | — | 原始输入主题 |
| `status` | text | `'active'` | `active`=迭代中 / `finalized`=已定稿 |
| `current_version` | integer | `1` | 当前最新版本号 |
| `created_at` | timestamptz | now() | |
| `updated_at` | timestamptz | now() | |

---

### `generation_history` — 生成的稿子（每一版一行）

主键是 **text** 不是 uuid：格式 `${projectId}::v${N}`（与 localStorage 里的作品 id 对齐）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | text | **PK**，见上 |
| `user_id` | uuid | 所有者 |
| `topic` | text | 解说主题，非空 |
| `identity_label` | text | 身份名称 |
| `style` | text | 文风描述 |
| `category` | text | 内容类型 |
| `system_prompt` | text | 生成的成品系统提示词 |
| `sample_text` | text | 生成的解说范文，非空 |
| `feedback_status` | text | 默认 null；`like` / `dislike` / `edited` / `regenerated` |
| `created_at` | timestamptz | |
| `embedding` | vector(1024) | **后补** |
| `project_id` | uuid | **后补** → `creative_projects(id)` on delete set null |
| `version_number` | integer | **后补**：本稿是第几版 |
| `blueprint` | jsonb | **后补**：生成蓝图 |
| `analysis` | jsonb | **后补**：分析结构 |
| `improve_direction` | text | **后补**：优化方向 |
| `improve_note` | text | **后补**：优化备注 |
| `characters` | jsonb | **后补**：本次用到哪些角色 |
| `generation_mode` | text | **后补**：生成模式 |
| `personalization` | jsonb | **后补**：个性化参数 |
| `edit_patches` | jsonb | **后补**：局部修改补丁 |
| `user_feedback` | text | **后补**：用户反馈原文 |
| `performance_feedback` | jsonb | **后补**：发布后效果回流 |
| `session_id` | uuid | **后补**：关联的 AI 工作台会话 |
| `revision_plan` | jsonb | **后补**：修订计划 |

> 这一张表后补了 15 个字段，是项目里字段最多的表。排查生成相关问题优先看它。

---

### `generation_feedback` — 用户对稿子的反馈

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid | **PK** |
| `generation_id` | text | → `generation_history(id)` cascade，指向被评价的稿子 |
| `user_id` | uuid | |
| `feedback_type` | text | check：`like` / `dislike` / `edit` / `regenerate` / `optimize` |
| `edited_content` | text | `feedback_type='edit'` 时用户改后的内容 |
| `created_at` | timestamptz | |
| `direction` | text | **后补**：反馈方向 |
| `free_text` | text | **后补**：自由填写的反馈文本 |
| `analysis_result` | jsonb | **后补**：反馈分析结果 |

---

### `material_groups` — 素材分组

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid | **PK** |
| `user_id` | uuid | 所有者（无外键约束） |
| `name` | text | 分组名 |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

---

### `material_usages` — 素材使用记录（数据飞轮）

一条记录 = 「某素材在某作品里被建议 / 选中 / 实际用了」一次。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | uuid | gen_random_uuid() | **PK** |
| `user_id` | uuid | — | |
| `material_id` | uuid | — | → `scripts(id)` cascade |
| `work_id` | text | — | → `generation_history(id)` on delete set null |
| `suggested_by_ai` | boolean | false | 是不是 AI 推荐的 |
| `selected_by_user` | boolean | false | 用户有没有勾它 |
| `actually_used` | boolean | false | 最终有没有真的用上 |
| `created_at` | timestamptz | now() | |

> 推荐质量的核心证据：对比 `suggested_by_ai` 与 `actually_used` 的比例。

---

## 3. 知识库

### `creator_knowledge` — 知识库条目

把用户的零散表达收敛成可复用的「命题」。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | uuid | gen_random_uuid() | **PK** |
| `user_id` | uuid | — | |
| `concept` | text | — | **聚合键**：同一「概念」的稳定标识，靠它去重收敛 |
| `claim` | text | — | 知识本体：可被引用的完整命题（写成句子，不是标签） |
| `kind` | text | `'观点'` | check：`事实` / `数据` / `观点` / `经历` |
| `domain_scope` | text[] | `{}` | 适用选题范围，相关性判断的第一道闸 |
| `confidence` | numeric | `0.5` | 0~1（有 check） |
| `status` | text | `'候选'` | check：`候选` / `已确认` / `已拒绝` / `已过期`。**默认候选——未经用户确认不注入 Prompt** |
| `source_item_ids` | uuid[] | `{}` | 弱引用 `scripts(id)`，不复制原文 |
| `source_count` | integer | `0` | 来源素材数 |
| `created_at` | timestamptz | now() | |
| `updated_at` | timestamptz | now() | |
| `confirmed_at` | timestamptz | — | 用户确认时间 |

---

### `creator_knowledge_links` — 知识与作品的关联

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | uuid | gen_random_uuid() | **PK** |
| `user_id` | uuid | — | |
| `knowledge_id` | uuid | — | 弱引用 `creator_knowledge.id`（不抢删除权） |
| `project_id` | uuid | — | → `creative_projects(id)` cascade（作品没了，关系也跟着没） |
| `origin` | text | `'manual'` | check：`manual`=手动关联 / `auto_history`=从历史版本回填 |
| `created_at` | timestamptz | now() | |

约束：`unique(knowledge_id, project_id)`——同一条知识对同一作品只可能有一条关系，回填可反复跑。

---

## 4. 积分、余额与支付

> 记账单位统一是**积分**（不是次数、不是元）。`POINTS_PER_YUAN = 20`，即 **1 元 = 20 积分**。
> 核心原则：**余额负责快，流水负责真**。`user_balances.balance` 必须等于 `point_ledger` 中该用户 `amount` 的代数和。

### `user_balances` — 用户余额快照（每人一行）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `user_id` | uuid | — | **PK** → `auth.users(id)` cascade |
| `balance` | numeric(12,2) | `0` | 可用积分，`check(balance >= 0)`——**余额永不为负** |
| `updated_at` | timestamptz | now() | |

客户端**只读**（RLS 只给 SELECT，写入一律由服务端函数做）。

---

### `point_ledger` — 积分流水（append-only，唯一事实）

每一分积分的来龙去脉。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid | **PK** |
| `user_id` | uuid | → `auth.users(id)` cascade |
| `type` | text | check：`REGISTER_BONUS` 注册赠金 / `RECHARGE` 充值 / `AI_CONSUMPTION` AI 消耗 / `MANUAL_ADJUSTMENT` 手动调整 / `REFUND` 退款 |
| `amount` | numeric(14,2) | 变动额，`check(amount <> 0)`；**扣分为负** |
| `balance_before` | numeric(14,2) | 变动前余额 |
| `balance_after` | numeric(14,2) | 变动后余额 |
| `source` | text | 默认 `'system'` |
| `reference_id` | text | **幂等键**：同一单号重复提交只生效一次 |
| `description` | text | 说明 |
| `created_by` | uuid | 谁操作的（管理员手动调整时会记） |
| `created_at` | timestamptz | |

---

### `point_config` — 价格与门槛（唯一出处）

| 字段 | 类型 | 说明 |
|---|---|---|
| `key` | text | **PK**，配置名 |
| `value` | numeric(14,4) | 配置值 |
| `updated_at` | timestamptz | |
| `updated_by` | uuid | 谁改的 |

现有键：

| key | 默认值 | 含义 |
|---|---|---|
| `POINTS_PER_YUAN` | `20` | 1 元 = 20 积分 |
| `MIN_RECHARGE_AMOUNT` | `5` | 低于 5 元不受理（人工审核成本考虑） |
| `REGISTER_BONUS_POINTS` | `20` | 新用户注册赠送，幂等、一生一次 |

> 改价改这里，**不用碰代码**。

---

### `recharge_orders` — 充值订单（人工确认制）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | uuid | gen_random_uuid() | **PK** |
| `order_no` | text | — | 订单号，`unique` |
| `user_id` | uuid | — | → `auth.users(id)` cascade |
| `requested_amount` | numeric(10,2) | — | 用户**申请**的金额（元），`> 0` |
| `confirmed_amount` | numeric(10,2) | — | 管理员核实的**实际到账**金额（元）；未确认前为 null |
| `points` | numeric(14,2) | — | 实际入账积分 = `confirmed_amount × POINTS_PER_YUAN`（向下取整） |
| `status` | text | `'PENDING'` | check：`PENDING` / `PAID` / `CONFIRMED` / `CANCELLED` / `REJECTED` |
| `user_note` | text | — | 用户备注 |
| `admin_note` | text | — | 管理员备注 |
| `created_at` | timestamptz | now() | |
| `paid_at` | timestamptz | — | 用户标记已付款的时间 |
| `confirmed_at` | timestamptz | — | 管理员确认到账的时间 |
| `confirmed_by` | uuid | — | 哪位管理员确认的 |
| `updated_at` | timestamptz | now() | |

> 注意 `requested_amount` 与 `confirmed_amount` 可能不同（用户申请 10 元实际转了 20 元）。积分按 **confirmed** 算。

---

### `payment_settings` — 收款码配置（单行表）

`id` 是 smallint 主键且 `check(id = 1)`——**全表只允许一行**。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | smallint | `1` | **PK**，强制 =1 |
| `method` | text | `'微信'` | 收款方式 |
| `qr_image_url` | text | — | 收款码图片地址 |
| `account_name` | text | — | 收款账户名 |
| `instruction` | text | — | 给用户的充值说明 |
| `updated_at` | timestamptz | now() | |
| `updated_by` | uuid | — | 谁改的 |

---

## 5. 社区

### `posts` — 帖子

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | uuid | gen_random_uuid() | **PK** |
| `user_id` | uuid | — | → `auth.users(id)` cascade |
| `content` | text | — | 正文 |
| `content_type` | text | `'text'` | check：`text` / `image` |
| `category` | text | `'灵感'` | 分类 |
| `tags` | text[] | `{}` | 标签 |
| `style_vector` | vector(1024) | — | 风格向量，推荐用 |
| `like_count` | integer | `0` | 点赞数（计数冗余） |
| `comment_count` | integer | `0` | 评论数 |
| `save_count` | integer | `0` | 收藏数 |
| `is_public` | boolean | `true` | 是否公开 |
| `created_at` | timestamptz | now() | |
| `image_url` | text | — | **后补**：图片地址 |
| `post_type` | text | `'moment'` | **后补**：帖子类型 |
| `archive` | jsonb | — | **后补**：归档结构 |
| `source_project_id` | uuid | — | **后补**：来源于哪个作品 |

---

### `post_interactions` — 帖子的点赞 / 收藏

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid | **PK** |
| `user_id` | uuid | → `auth.users(id)` cascade |
| `post_id` | uuid | → `posts(id)` cascade |
| `interaction_type` | text | check：`like` / `save` / `style_resonate` |
| `created_at` | timestamptz | |

约束：`unique(user_id, post_id, interaction_type)`——同一用户对同一帖同一类型只记一次。

---

### `comments` — 评论

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid | **PK** |
| `post_id` | uuid | → `posts(id)` cascade |
| `user_id` | uuid | → `auth.users(id)` cascade |
| `content` | text | 评论内容 |
| `created_at` | timestamptz | |

---

## 6. 兴趣洞察（数据飞轮的核心）

> 链路：`creator_events`（埋点）→ `interest_clusters`（聚类）→ `interest_suggestions`（推荐）。
> 每次跑聚类先生成一条 `interest_builds`，聚类结果和推荐都挂在它下面，方便回溯「这次结果是谁算出来的」。

### `creator_events` — 用户行为埋点

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | uuid | gen_random_uuid() | **PK** |
| `user_id` | uuid | — | → `auth.users(id)` cascade |
| `event_type` | text | — | 事件类型 |
| `target_type` | text | — | `generation` / `project` / `script` / `post` / `inspiration` / `ci_item` / `topic` |
| `target_id` | text | — | 目标 ID |
| `project_id` | uuid | — | → `creative_projects(id)` on delete set null |
| `category` | text | — | 形式分类（电影解说…），仅辅助维度 |
| `content_domain` | text | — | 粗领域（tech / business…），辅助维度 |
| `embedding` | vector(1024) | — | 事件向量 |
| `embedding_model` | text | `'bge-m3@1024'` | 用的 embedding 模型 |
| `payload` | jsonb | `{}` | 事件明细 |
| `interpretation` | jsonb | — | AI 行为原因分析（Behavior Reason） |
| `interpret_status` | text | `'none'` | `none` / `pending` / `done` / `failed` |
| `cluster_id` | uuid | — | → `interest_clusters(id)` on delete set null，事件归到哪个簇 |
| `occurred_at` | timestamptz | now() | 事件发生时间 |
| `created_at` | timestamptz | now() | |
| `idempotency_key` | text | — | 幂等键，防重复埋点 |

---

### `interest_builds` — 一次聚类计算的记录

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | uuid | gen_random_uuid() | **PK** |
| `user_id` | uuid | — | → `auth.users(id)` cascade |
| `trigger` | text | — | `manual` / `scheduled` / `incremental` / `backfill` |
| `algo_version` | text | — | 聚类算法版本，如 `interest-cluster-v1` |
| `rule_version` | text | — | 权重规则版本，如 `interest-rules-v1` |
| `params` | jsonb | `{}` | 本次算法参数全量快照 |
| `event_range` | jsonb | `{}` | `{from_event_id, to_event_id, count}` |
| `status` | text | `'running'` | `running` / `done` / `failed` |
| `error` | text | — | 失败原因 |
| `started_at` | timestamptz | now() | |
| `finished_at` | timestamptz | — | |

---

### `interest_clusters` — 兴趣聚类结果

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | uuid | gen_random_uuid() | **PK** |
| `user_id` | uuid | — | → `auth.users(id)` cascade |
| `build_id` | uuid | — | → `interest_builds(id)` cascade |
| `cluster_code` | text | — | 跨 build 的稳定身份码，如 `c_ai_business` |
| `label` | text | — | 簇名，check 长度 1~20 |
| `summary` | text | `''` | 摘要，≤200 字 |
| `centroid` | vector(1024) | — | 质心向量 |
| `layer` | text | — | `core` / `exploration` / `temporary` |
| `previous_layer` | text | — | 上一次分层，看分层迁移用 |
| `layer_changed_at` | timestamptz | — | 分层变化时间 |
| `weight` | real | — | 用户内归一化强度，0~1 |
| `raw_score` | real | `0` | 归一化前加权事件分，算趋势用 |
| `confidence` | real | — | 0~1 |
| `event_count` | integer | `0` | 事件数 |
| `project_count` | integer | `0` | **去重**项目数——防单项目反复迭代刷票 |
| `first_seen_at` | timestamptz | now() | |
| `last_seen_at` | timestamptz | now() | |
| `status` | text | `'active'` | `active` / `superseded` / `archived` |
| `superseded_by` | uuid | — | → `interest_clusters(id)` on delete set null，被哪个新簇取代 |
| `stats` | jsonb | `{}` | 窗口分 / 趋势 / 来源 / 原因混合 / 证据 |
| `algo_version` | text | — | |
| `created_at` | timestamptz | now() | |
| `updated_at` | timestamptz | now() | |

---

### `interest_suggestions` — 给用户的创作建议

对外暴露时 `id` 就是 `rec_id`。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | uuid | gen_random_uuid() | **PK** |
| `user_id` | uuid | — | → `auth.users(id)` cascade |
| `build_id` | uuid | — | → `interest_builds(id)` cascade |
| `cluster_code` | text | — | 来源簇的身份码 |
| `slot` | text | — | `core_gap` / `evidence_followup` / `exploration` / `continuation` |
| `source` | text | — | `own_inspiration` / `ci_market` / `saved_material` / `exploration` / `active_project` |
| `title` | text | — | 标题，check 长度 1~40 |
| `description` | text | — | 描述，≤120 字 |
| `topic` | text | — | 选题，check 长度 1~200 |
| `form_hint` | text | `'其他'` | 形式提示 |
| `score` | real | — | 0~1 |
| `score_breakdown` | jsonb | `{}` | 分数构成明细 |
| `evidence` | jsonb | `{}` | **确定性事实包**（推荐解释用，禁止 LLM 自由发挥写进来） |
| `market_refs` | jsonb | — | 内部溯源 `[{platform, url}]`，**不返回前端** |
| `status` | text | `'active'` | `active` / `impressed` / `consumed` / `dismissed` / `expired` / `superseded` |
| `expires_at` | timestamptz | now()+14天 | 有效期默认 14 天 |
| `created_at` | timestamptz | now() | |

---

## 7. AI 工作台（局部改稿的对话）

### `work_agent_sessions` — 会话

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | uuid | gen_random_uuid() | **PK** |
| `user_id` | uuid | — | → `auth.users(id)` cascade |
| `project_id` | uuid | — | → `creative_projects(id)` cascade |
| `base_version_id` | text | — | 发起时的基底版本（`generation_history.id`，形如 `${pid}::vN`）。作品删除后置空，**不清会话** |
| `status` | text | `'active'` | check：`active` 进行中 / `applied` 已落地新版本 / `abandoned` 用户放弃 |
| `phase` | text | `'clarify'` | check：`clarify` 意图澄清 / `propose` 方案选择 / `apply` 局部修改 / `done` 完成 |
| `meta` | jsonb | — | `{chosenIntentId?, chosenPlanId?, turnCount?, lastError?}`，阶段指针，不存正文 |
| `created_at` | timestamptz | now() | |
| `updated_at` | timestamptz | now() | |

---

### `work_agent_messages` — 会话消息

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | uuid | gen_random_uuid() | **PK** |
| `session_id` | uuid | — | → `work_agent_sessions(id)` cascade |
| `user_id` | uuid | — | → `auth.users(id)` cascade |
| `role` | text | — | check：`user` / `assistant` |
| `kind` | text | `'intent_clarify'` | check：`intent_clarify` 意图候选 / `proposal` 修改方案 / `patch_preview` 补丁预览 / `confirm` 用户确认 / `system_notice` 降级或错误提示 |
| `content` | text | `''` | 面向用户展示的文案 |
| `payload` | jsonb | — | 结构化载荷：`intentOptions[]` / `plans[]` / `patches[]` / `analysis` |
| `selected_index` | integer | — | 用户在候选中选的序号（null=未选择/自由输入）。**数据飞轮核心字段** |
| `created_at` | timestamptz | now() | |

---

## 8. 外部内容抓取缓存（竞品/素材情报）

### `ci_items` — 抓取到的内容条目

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid | **PK** |
| `platform` | text | 来源平台，非空 |
| `external_id` | text | 平台侧 ID，非空 |
| `url` | text | 原文链接 |
| `title` | text | 标题，非空 |
| `excerpt` | text | 摘要，check ≤300 字 |
| `author` | text | 作者，默认 `''` |
| `published_at` | timestamptz | 发布时间 |
| `metrics` | jsonb | 平台指标，默认 `{}` |
| `content_info` | jsonb | 内容结构信息，默认 `{}` |
| `ai_analysis` | jsonb | AI 分析结果 |
| `query_hash` | text | 查询哈希，非空 |
| `fetched_at` | timestamptz | 抓取时间，默认 now() |
| `expires_at` | timestamptz | 过期时间，非空 |

约束：`unique(platform, external_id)`——同一平台的同一内容只存一条。

---

### `ci_search_log` — 搜索日志

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | uuid | gen_random_uuid() | **PK** |
| `query_hash` | text | — | 查询哈希，非空 |
| `query_text` | text | — | 查询文本 |
| `adapters` | text[] | — | 用了哪些适配器（平台） |
| `item_count` | int | `0` | 命中条目数 |
| `created_at` | timestamptz | now() | |

---

## 附录 A：28 张表总览

| 分组 | 表 |
|---|---|
| 用户与画像 | `admin_users`、`style_profiles`、`user_characters`、`follows`、`user_style_matches` |
| 创作 | `scripts`、`creative_projects`、`generation_history`、`generation_feedback`、`material_groups`、`material_usages` |
| 知识库 | `creator_knowledge`、`creator_knowledge_links` |
| 积分支付 | `user_balances`、`point_ledger`、`point_config`、`recharge_orders`、`payment_settings` |
| 社区 | `posts`、`post_interactions`、`comments` |
| 兴趣洞察 | `creator_events`、`interest_builds`、`interest_clusters`、`interest_suggestions` |
| AI 工作台 | `work_agent_sessions`、`work_agent_messages` |
| 外部抓取 | `ci_items`、`ci_search_log` |

> 另外 `auth.users` 是 Supabase 内置认证表（含 email、注册时间等），本文未展开。

---

## 附录 B：常用自检 SQL

```sql
-- 账目是否对得上（有输出＝余额被绕过流水改过，或流水漏记）
select b.user_id, b.balance, coalesce(sum(l.amount), 0) as ledger_sum
from public.user_balances b
left join public.point_ledger l on l.user_id = b.user_id
group by b.user_id, b.balance
having b.balance <> coalesce(sum(l.amount), 0);

-- 有没有负余额 / 流水的负结余
select user_id, balance from public.user_balances where balance < 0;
select id, user_id, balance_after from public.point_ledger where balance_after < 0;

-- 待处理的充值订单
select order_no, user_id, requested_amount, status, created_at
from public.recharge_orders
where status in ('PENDING','PAID')
order by created_at desc;

-- 价格配置快照
select key, value from public.point_config order by key;

-- 某用户的积分流水（按邮箱不行，先取 id）
select type, amount, balance_before, balance_after, source, description, created_at
from public.point_ledger
where user_id = '<USER_UUID>'
order by created_at desc
limit 50;
```

