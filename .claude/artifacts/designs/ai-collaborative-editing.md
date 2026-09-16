# AI 协作创作引擎（AI Collaborative Editing Engine）Spec

> Status: DRAFT（待用户确认后转 ALIGNED）
> Author: 王俊澄
> Last updated: 2026-09-16

## Background
当前「继续优化」= AI 按优化蓝图完整重写全文（prompt-optimizer improve 模式），存在：满意内容被破坏、每次全篇重写 token 浪费、修改行为未被结构化沉淀。目标：反馈理解 → 定位修改区域 → 修改方案 → 用户确认 → 局部融合 → 版本链 → 修改偏好记忆 → 注入后续生成，形成 Creator Profile 数据资产闭环。

前置依赖：feedback CHECK 约束 bug 已修（.claude/artifacts/fixes/feedback-optimize-check-constraint.md），线上库验证待用户在 Dashboard 执行 SQL。

## In scope
- FeedbackAnalysis 扩展「影响范围 impact_scope / 保持内容 preserve_items」字段（修改理解报告）
- 修改补丁层：AI 输出结构化段落级 patch（锚点+原文摘录+改写+理由），服务端双重校验锚点，失败降级全文重写
- AI 修改建议窗口：原文→建议 对照展示 + 接受/继续调整/拒绝 三操作
- 继续调整循环：追加反馈后重新出 patch（禁止全文重写）
- 局部融合生成新版本行（沿用 creative_projects / generation_history 版本链，append-only）
- 撤销：以选中旧版为基底生成新版本行（不修改不删除任何历史行）
- CreativeMemory → `style_profiles.editing_profile` jsonb 新列（聚合偏好+置信度+样本溯源）；原始事件沿用 generation_feedback，不建独立记忆表
- editing_profile 注入生成链路（prompt-optimizer 我的模式装配，与 Creator Model 人格块并列；avoid 类偏好并入硬禁忌）
- 修改历史视图（free_text + 各版本 patch 摘要，按项目展示）

## Out of scope
- 文章物理 blocks 化存储与历史数据迁移（已决策：方案 B 整篇存储 + 补丁层）
- 游客协作修改（游客保留现有全文重写降级路径）
- 新建 creative_memories 独立表
- 聊天机器人式自由对话
- 多模态修改（图片/语音）

## Assumptions
- 文章为 Markdown 纯文本，段落按空行/标题切分；patch 锚点 = 段落序号 + 首句摘录（≤30 字）双重校验
- 版本行仍存融合后全文（方案 B 核心承诺：旧文章零迁移）
- patch 详情存 generation_history 新列 `edit_patches jsonb`（nullable，老行无值不受影响）
- 偏好记忆带 confidence（接受/拒绝次数加权）；注入 prompt 需 source_count ≥ 2（防单次污染）；用户可在风格卡查看并手动移除单条
- 局部生成的 max_tokens 按目标段落规模估算（被改段字数 ×3 + 理由摘要），非全文

## Solution
流程（登录用户，8 步）：
1. **反馈理解**：analyze-feedback 扩展输出 `impact_scope`（开头/背景/核心/高潮/结尾/全篇 枚举）与 `preserve_items`（必须保持项）；用户沿用现有「确认理解」节奏确认。
2. **patch 生成**（新服务端能力）：输入 = 全文 + FeedbackAnalysis + editing_profile(若有) + preserve_items；输出 JSON = `{ patches: [{ segment_index, segment_excerpt, original_excerpt, revised_text, reason }], summary }`。服务端校验 segment_index 在范围内且 excerpt 与全文第 N 段首句模糊匹配（≥80%）；失败重试 1 次，仍失败降级现有全文重写链路（用户可见提示）。
3. **建议窗口**：work-feedback-panel 新增视图，逐条「原文 → 建议」对照，三操作按钮。
4. **继续调整**：拒绝/调整时把上一轮 patches + 不满反馈追加为上下文重新出 patch。
5. **融合**：接受 → 按段落替换生成新全文 → 新版本行（version_number+1，improve_note=patch 摘要，user_feedback=反馈原话，edit_patches=完整 patch）。
6. **记忆更新**：接受/拒绝事件 → 服务端聚合更新 `style_profiles.editing_profile.preferences[]`（type 喜欢/避免、statement、confidence、source_count、examples）。
7. **注入生成**：prompt-optimizer 我的模式读 editing_profile，注入「该创作者的修改偏好（来自 N 次修改历史）」块。
8. **撤销/历史**：版本列表新增「以此版为基底继续修改」；修改历史聚合展示。

## Edge cases & risks
| Category | Notes |
|---|---|
| 锚点失配 | LLM 定位段落与真实段落不符 → 双重校验+重试+全文重写降级，绝不允许错位替换 |
| 记忆污染 | 单次异常反馈歪曲偏好 → source_count≥2 才注入 + 手动移除入口 |
| patch 越界 | 一次反馈拆出 >5 个 patch → 截断并提示 |
| 并发迭代 | 同项目两标签页同时修改 → 以 version_id 为准，后写者提示刷新 |
| 成本 | patch 生成 = 全文输入 + 局部输出，输出侧 token 较全文重写省 70%+ |
| 游客/老数据 | 无 editing_profile / 无版本链 → 空值降级走现有链路 |

## Acceptance criteria
- AC-1: 对开头段落提出修改并接受后，新版本除该段落外其余段落文本与原版本完全一致（程序化 diff 断言）
- AC-2: 连续 ≥5 次接受修改后，editing_profile 至少 1 条 preference 且 source_count ≥5；下一次生成时服务端装配包含该注入块
- AC-3: 关闭重开文章，全部版本及其 patch 元数据（位置/原因/反馈/AI建议）可查看
- AC-4: 拒绝建议并补充反馈后，下一轮仅重新生成目标段落 patch，不触发全文重写（请求/日志可验证）
- AC-5: 「以旧版为基底」后当前内容等于所选旧版全文，历史版本行无任何改动
- AC-6: 锚点校验失败自动降级全文重写且用户可见降级提示（不静默）
- AC-7: 两个不同账号对同一主题提出不同反馈，editing_profile 与注入内容互不相同（RLS 隔离复核）

## Open questions
- patch 生成 API 形态：扩展 /api/prompt-optimizer improve vs 独立 /api/creative/patch（dev-plan 定稿）
- edit_patches 新列 vs 复用 analysis jsonb（倾向新列，保 analysis 语义纯净；dev-plan 定稿）
- 继续调整是否引入最近 1 轮被拒 patch 作负例上下文（默认引入，dev-plan 确认）

## Core entities (ontology)
| Entity | Type | Key fields | Relationship |
|---|---|---|---|
| ArticleVersion | generation_history 行（现有） | sample_text, version_number, project_id, user_feedback, improve_note, edit_patches(新) | 属于 creative_projects |
| ModificationPatch | jsonb（新） | segment_index, segment_excerpt, original_excerpt, revised_text, reason | 存于 ArticleVersion.edit_patches |
| FeedbackEvent | generation_feedback 行（现有） | free_text, analysis_result(+impact_scope, preserve_items) | 关联 ArticleVersion |
| EditingProfile | style_profiles.editing_profile jsonb（新列） | preferences[]{type, statement, confidence, source_count, examples} | 属于用户，聚合自 FeedbackEvent |

## Interview metadata
- Mode: default（early exit）
- Waves: 1（方案 A/B 决策）
- Final ambiguity: ~14%
- Status: EARLY_EXIT_BY_USER（用户明示「执行吧」推进；残余不确定性已全部写入 Assumptions / Open questions）

### Clarity breakdown
| Dimension | Score | Weight | Weighted |
|---|---|---|---|
| Goal | 0.9 | 0.40 | 0.36 |
| Scope | 0.85 | 0.25 | 0.21 |
| AC | 0.75 | 0.25 | 0.19 |
| Context | 0.95 | 0.10 | 0.10 |
