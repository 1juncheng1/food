# Bug: 自由文本反馈因 CHECK 约束不识别 'optimize' 而无法落库

> Status: FIXED（代码/脚本侧；线上库待执行）
> Mode: --quick
> Severity: functional（阻塞「用户修改记忆系统」的唯一数据源）
> Author: 王俊澄
> Last updated: 2026-09-16

## Symptom
文章页「继续优化」面板提交自由文本反馈后，AI 分析正常返回，但反馈从不入库；`/api/creative/analyze-feedback` GET 的反馈历史永远为空。

## Expected
登录用户提交自由反馈 → `generation_feedback` 插入 `feedback_type='optimize'` 行 → GET 返回该反馈历史。

## Reproduction
- 路径：作品页 → 继续优化 → 输入自由文本 → 确认理解
- 失败点：`app/api/creative/analyze-feedback/route.ts:78-93` 的 insert 被 Postgres 拒绝，错误仅 `console.error('反馈写库失败…')`，接口仍返回 200（前端无感知）
- 测试基础设施说明：项目无测试框架（package.json 仅 dev/build/start/lint），且 bug 位于 DB 约束层，单元测试无法触达真实约束。有效验证 = 对线上库查询约束定义 + 试插入（待用户授权后执行，见 Verification）

## Hypotheses & diagnosis
| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| H1 | 表 CHECK 约束只允许 4 种枚举，'optimize' 插入被拒 | confirmed (root cause) | setup.sql:221 `check (feedback_type in ('like','dislike','edit','regenerate'))` vs route L83 `feedback_type: 'optimize'` |
| H2 | RLS 拦截插入 | eliminated | 同表 like/dislike/edit 反馈（同 user_id、同 insert 路径）落库正常，RLS 策略一致（setup.sql:227-233） |

## Root cause
`generation_feedback` 建表时 inline CHECK 只含 4 种枚举值；Work Agent 阶段（10.1）引入自由文本反馈时新增了第 5 种类型 `'optimize'`，扩了列（free_text/analysis_result）但漏了放宽 CHECK。插入违反约束 → 静默失败（catch 后仅 console.error）→ 数据源断供。

## Fix
- 改动文件：`supabase/setup.sql:221`（新装路径：inline CHECK 加入 'optimize'）
- 改动文件：`supabase/setup.sql:1321-1327`（存量路径：10.1.1 幂等 drop + add constraint）
- 一句话改了什么：把 `feedback_type` CHECK 从 4 值放宽为 5 值，存量库用幂等 ALTER 重建同名约束

## Verification
- V-1（静态）：全仓 grep `feedback_type|feedbackType` → 'optimize' 写入路径唯一（analyze-feedback L83），其余两路（submit_feedback RPC、/api/feedback VALID_TYPES）均为 4 枚举且自校验，不受影响 ✓
- V-2（幂等性）：10.1.1 采用 `drop constraint if exists` + 重建，重复执行安全 ✓
- V-3（线上库，待执行）：执行
  ```sql
  select conname, pg_get_constraintdef(oid)
  from pg_constraint where conrelid = 'public.generation_feedback'::regclass and contype = 'c';
  ```
  修复前应显示仅 4 值 CHECK；执行 10.1.1 后应显示 5 值 CHECK，且
  `insert into public.generation_feedback(generation_id,user_id,feedback_type) values ('test',auth.uid(),'optimize')` 可成功（随后回滚/删除）。
  ⚠️ 该步骤需操作线上库，等待用户选择执行方式。

## Regression test
- 项目无测试框架；回归验证以 V-3 的线上约束查询代替。后续若引入测试框架，可补一条「analyze-feedback 落库后 GET 返回该反馈」的集成测试。

## Pattern analysis
| 搜索方式 | 命中数 | 是否本次同类隐患 |
|---|---|---|
| grep `check \(feedback_type` / `check \(.*in \(`（setup.sql） | 若干（feedback_type、creation_mode 等 inline CHECK） | 潜在同类：新增枚举值时须同步 inline CHECK |

**同类隐患排查结论**：`generation_history.feedback_status`（like/dislike/edited/regenerated，由 RPC 写入且 RPC 自校验）当前无第 5 值需求，无风险。教训沉淀：今后给带 CHECK 的枚举列加新值时，setup.sql 必须同时改 inline 定义 + 存量幂等 ALTER（本次已按此模式写入 10.1.1 注释）。

## Open questions / Follow-ups
- analyze-feedback 落库失败仅 console.error、前端无感知（degraded 时用户不知道历史没存上）——建议后续把写库失败暴露给前端（本次不修，属独立改进）
- 线上库修复执行方式待用户确认
