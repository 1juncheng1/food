# AI 协作创作引擎 Implementation Plan

> Status: APPROVED
> Source: .claude/artifacts/designs/ai-collaborative-editing.md
> Mode: (default)
> Iterations: 1 / 3
> Author: 王俊澄
> Last updated: 2026-09-16

## Requirements summary
把「继续优化 = AI 重写全文」升级为「反馈理解 → 段落级补丁 → 用户确认 → 服务端确定性融合 → 版本链 → 修改偏好记忆 → 注入后续生成」。方案 B：整篇存储不变 + 补丁层。接受动作零 LLM 调用（token 核心收益）。

## Acceptance criteria
继承 spec AC-1 ~ AC-7（diff 断言 / 注入块验证 / 版本持久化 / 拒绝不触发全文重写 / 撤销只增不改 / 降级可见 / 用户隔离）。

## RALPLAN-DR

### Principles
- 最小代码；复用既有范式：styleLearning 的 parse/apply/MIN_SAMPLES 三件套、workAgent 纯函数、feedbackAnalyzer LLM 调用模式
- 版本链 append-only：不 UPDATE 不 DELETE 任何 generation_history 历史行
- 锚点校验必须在服务端；融合函数纯函数化，前后端共用

### Decision drivers
- token 成本（接受时不调 LLM）
- 不破坏现有 improve 全文重写链路（作为锚点失败降级路径）
- prompt-optimizer 已 935 行，不再往里塞新职责

### Viable options
- **Option A（chosen）**：独立 `/api/creative/patch` + `/api/creative/patch/decide`，服务端确定性融合
- **Option B（rejected）**：扩展 prompt-optimizer improve 分支——职责混杂、maxDuration 互相拖累、确认动作白跑全长链路
- **Option C（rejected）**：客户端融合 + 薄落库端点——锚点校验可被绕过，错位替换直接入库

### Open questions 定稿
1. API 形态 = Option A（独立双 route）
2. 存储 = generation_history 新增 `edit_patches jsonb`（analysis 列语义保持纯净）
3. 负例上下文 = 引入，仅最近 1 轮被拒补丁

## Implementation steps

### P1 地基（本阶段交付）
1. `supabase/setup.sql` 10.2 节后新增 10.3 节：`alter table public.generation_history add column if not exists edit_patches jsonb;` + `alter table public.style_profiles add column if not exists editing_profile jsonb;`（双列均 nullable，幂等）
2. `lib/creative/workAgent.ts:63-74` FeedbackAnalysis 增加可选字段 `impactScope?: string[]`（影响范围枚举：开头/背景/核心/高潮/结尾/全篇）与 `preserveItems?: string[]`（保持内容项）；`normalizeFeedbackAnalysis` 同步解析
3. `lib/creative/feedbackAnalyzer.ts:34` FEEDBACK_JSON_KEYS 加两键；`buildSystemPrompt():43-75` 增加输出规则（impact_scope 从 6 段位枚举、preserve_items 必须 2-4 项含"主题与整体结构"）；`analyze-feedback/route.ts` 无需改（analysis 整体落 analysis_result jsonb）
4. `components/creative/work-feedback-panel.tsx` AI 理解确认区（L213 附近）增加「影响范围 / 保持内容」两行展示

### P2 补丁生成链
5. 新建 `lib/creative/patchEngine.ts`：`splitParagraphs(content)`（空行+标题切分）、`fuzzyMatchAnchor(expected, actual)`（≥80% 相似）、`applyPatches(content, patches)`（纯函数，前后端共用）、`generateEditPatches(input)`（DeepSeek 强制 JSON，服务端；复用 feedbackAnalyzer 的重试/降级模式）
6. 新建 `app/api/creative/patch/route.ts`：POST（登录必须）→ 校验锚点（segment_index 范围 + excerpt 模糊匹配）→ 失败重试 1 次 → 仍失败返回 `degraded: true`（前端走现有全文重写链路并提示）；上下文含 FeedbackAnalysis + editing_profile(若有) + 最近 1 轮被拒补丁（负例）

### P3 融合与记忆事件
7. 新建 `lib/creative/editingMemory.ts`（镜像 styleLearning 模式）：`EditingProfileState{preferences[]{type:'like'|'avoid', statement, confidence, sourceCount, examples[]}, updatedAt}` + `parseEditingProfile` + `applyMemoryEvent`（接受 weight 1.0 / 拒绝 weight 0.5 反向；sourceCount<2 不注入）+ `formatEditingProfileForPrompt`
8. 新建 `app/api/creative/patch/decide/route.ts`：
   - accept：服务端 `applyPatches` 融合 → 查目标版本行（project_id 归属校验，不信任前端）→ 插入新版本行（version_number+1、improve_note=补丁摘要、user_feedback=反馈原话、edit_patches=完整补丁）→ 更新 `style_profiles.editing_profile`
   - 老作品无 project_id：先复用 adopt 语义（`app/api/creative/projects/adopt/route.ts` 的幂等归属逻辑抽用）再落版本
   - reject：仅记 generation_feedback 事件 + 更新 editing_profile，返回下一轮上下文所需数据
9. `supabase/setup.sql`：确认 generation_feedback 反馈事件沿用现有结构（free_text 已有），无新列

### P4 建议窗口 UI
10. `components/creative/work-feedback-panel.tsx`：新增 patch 对照视图（逐条 原文→建议 + reason），三按钮：接受修改 / 继续调整（追加反馈重新出补丁）/ 拒绝修改
11. `app/(main)/article/[id]/page.tsx`：接线 decide API；accept 后刷新版本列表（不走 startGenerationTask——那是 LLM 生成路径）；游客隐藏补丁入口；degraded 提示走现有全文重写确认流

### P5 偏好注入与可视化
12. `app/api/prompt-optimizer/route.ts:336-545` 装配区：creator 模式读 `style_profiles.editing_profile`（与 style_dimensions同查询扩展）；`formatEditingProfileForPrompt` 注入块放人格块后（L613-615 区域）；avoid类偏好并入 L754 `creatorAvoid` 硬禁忌
13. `app/api/style-profile/route.ts` GET 响应带 editing_profile；`app/(main)/style-profile/page.tsx` 新增「修改偏好」区：展示 statement/confidence/来源次数 + 单条移除按钮（POST 扩展）

### P6 撤销与修改历史
14. `app/(main)/article/[id]/page.tsx`：版本列表加「以此版为基底继续修改」（以所选旧版全文为当前基底发起 patch 流程，落新版本行，append-only）+ 修改历史时间线（free_text + 各版本 edit_patches 摘要，GET 已有 `/api/creative/analyze-feedback?generationId=` 反馈历史可复用）

### P7 全面验证
15. 按 AC-1~7 逐条验证（见 Verification steps）

## Workspace setup
- 工作区现状：master 分支、全部代码未提交（untracked）。建议先做一次 baseline commit 保护现状再开工（用户决定）；不另建 worktree（untracked 文件不会带入）。

## Risks & mitigations
| Risk | Mitigation |
|---|---|
| 锚点错位替换 | 服务端双重校验+重试+degraded 降级，绝不允许校验失败入库 |
| 记忆污染 | sourceCount<2 不注入；用户可单条移除（P5） |
| 多轮调整 prompt 膨胀 | 只带最近 1 轮被拒补丁 + 上一轮 patches |
| patch 数量失控 | 上限 5 条，超出截断提示 |
| 并发迭代 | 以 version_id 为准，版本行插入前复查 version_number |
| 游客误入 | patch/decide 均 401；UI 层隐藏入口（P4 验收项） |

## Verification steps
- AC-1：node 脚本对「改开头」用例跑 applyPatches，断言其余段落 === 原文对应段落
- AC-2：连续 5 次 accept 后查 style_profiles.editing_profile（supabase 查询）+ 抓 prompt-optimizer 装配日志注入块
- AC-3：重开文章页，版本列表 + edit_patches 元数据完整
- AC-4：拒绝后网络面板确认无 prompt-optimizer 全文请求
- AC-5：基底切换后内容 === 所选旧版 sample_text；历史行 updated_at 不变
- AC-6：mock 锚点失败响应，UI 出现降级提示
- AC-7：双账号交叉验证 editing_profile 与注入块互异

## ADR
- **Decision**: 独立 patch/decide 双 route + 服务端确定性融合 + edit_patches/editing_profile 双 jsonb 列 + styleLearning 范式聚合记忆
- **Drivers**: token 成本（决定性）、935 行 route 可维护性、锚点完整性
- **Alternatives**: Option B rejected（职责混杂）；Option C rejected（校验绕过风险）
- **Why chosen**: 接受动作零 LLM 是本项目的核心成本承诺；服务端校验是数据完整性底线；范式复用使新增代码集中在 2 个新模块 + 2 个新 route
- **Consequences**: (+) token 省 70%+、满意内容锁定、偏好数据资产开始积累；(−) 2 个新 route 的维护面、融合纯函数需前后端行为一致（同一实现文件保证）
- **Follow-ups**: analyze-feedback 写库失败的前端可见性；LLM 网关层统一（前次架构报告建议）

## Review trail
- Planner v1 → Architect v1（steelman 不成立；发现前后端融合复用解法）→ Critic v1 APPROVED（2 条 reservations 已落入 Risks/P4）
