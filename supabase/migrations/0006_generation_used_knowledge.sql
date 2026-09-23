-- ============================================================
-- 0006_generation_used_knowledge.sql
-- Creator Knowledge System Phase 3：生成注入留痕
--
-- 一句话：把「这次生成实际依据了你哪几条知识」随版本行一起存下来。
--
-- 为什么需要这一列：
--   Phase 3 的三条链路（plan / blueprint / prompt-optimizer）已经在响应里回传
--   usedKnowledgeUnits，但那只活在当次 HTTP 响应中——刷新即消失。于是出现一个怪象：
--     作品正文落库了、blueprint 落库了、五维诊断 analysis 落库了、
--     personalization 证据快照也落库了，
--     唯独「AI 这次是拿着什么主张在替你写」没留下任何痕迹。
--   结果就是：历史作品无法复盘 AI 到底有没有真的用上你的知识，
--   也没法回答「这条已确认的单元，历史上到底被用过几次」。
--
-- 为什么是 jsonb 快照而不是外键关联表：
--   1. 语义是「生成当时的事实」而非「当前关系的指针」。用户之后可以改 claim 措辞、
--      可以撤回确认、可以把某条单元标为已过期——这些都不应该改写历史作品当时的依据。
--      外键 join 会让历史记录随当前行漂移，快照不会。
--   2. 与既有的 blueprint / analysis / characters / personalization / inspiration_context
--      同构：这些都是「当次生成的只读证据」，统一用 jsonb 随行存储，读版本即可完整复盘。
--   3. 消费方式只是「随版本行读出展示」，没有任何跨作品按知识反查的查询需求，
--      不值得为它引入一张关联表与一轮 join。
--   4. 失败不得影响主链路：知识是增强项，没有 N 条 42P01 或写列失败就阻塞生成的道理。
--      jsonb 列 + add if not exists 保证幂等且零破坏。
--
-- ⚠ 复用优先原则（与 0005 一致）：
--   不复制素材原文、不复制知识单元整行，只留 concept / claim / kind / confidence 四个字段。
--   confidence 保留是必要的——它是注入当时参与「≥0.6 门槛」筛选的依据，属于
--   「当时为什么选中这一条」的事实；UI 刻意不展示它，正是为了避免
--   「历史快照显示 0.9、/knowledge 页面当前显示 0.6」给用户的观感矛盾。
--   source_item_ids 刻意不入库：那是内部素材溯源债务追踪，且会把用户并未主动公开的
--   素材关系带进一个本来只存"作品"的快照里。
-- ============================================================

alter table public.generation_history
  add column if not exists used_knowledge jsonb;

comment on column public.generation_history.used_knowledge is
  'Creator Knowledge System Phase 3：本次生成实际注入的创作者知识单元快照 [{concept,claim,kind,confidence}]；'
  '灵感模式/游客/无可用单元时为 null（不用空数组，区分「确实没用」与「该列尚未写入」）';

-- 无索引、无 RLS 变更：
--   RLS —— generation_history 已有 SELECT/INSERT/UPDATE 三条 own 策略，新列自动继承；
--   索引 —— 仅随版本行整行读出，没有按该列过滤/排序/连接的查询。
-- 权限 —— 列级权限不涉及，表级 UPDATE 权限在 8.x 节已授予 authenticated。

-- ── 验证查询（执行后应返回 1 行）────────────────────────────
--   select column_name, data_type from information_schema.columns
--    where table_name = 'generation_history' and column_name = 'used_knowledge';
