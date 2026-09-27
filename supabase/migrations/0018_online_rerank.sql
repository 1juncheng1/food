-- ============================================================
-- 0018 推荐卡在线重排（RULE v5）—— 需在 Supabase SQL Editor 执行
--
-- 状态：**待执行**。本项目代码侧无法执行 DDL（无 DB 密码 / 无 psql / 库里无
-- exec_sql RPC），与 0017 同例。
--
-- 不执行会不会炸？不会。应用层已做降级：
--   - insert 带新列失败 → 自动重试不带新列（卡照常落库，只是不能被在线重排）
--   - select 带新列失败 → 自动重试不带新列（推荐照常返回，按库 score 排序）
-- 也就是说缺这两列的代价是"重排能力不生效"，而不是报错或空推荐。
-- 但为了真正拿到 v5 的收益，请执行本文件。
--
-- 与 supabase/setup.sql 第 17 节同源（那边是全新库的累计脚本，两边保持一致）。
-- ============================================================

-- 背景：score 此前在 build/refill 写库时算死，落库后 14 天不变。而它依赖的量
-- （簇最近行为距今天数 / 簇趋势 / 近期行为质心 / ✕ 口味惩罚）全是活的，
-- 队列实际上是一张冻结在 build 时刻的排序快照。
--
-- 改法：离线只落「卡片固有特征」，分与排序挪到读路径现场算
-- （lib/creative/interest/rescore.ts）。本文件是它需要的两个 additive 列。

begin;

-- 1. 卡自身的语义向量（bge-m3@1024）。
--    nullable：S6 知识卡等无向量的源仍为 null，在线重排时该维度走
--    「信号缺失 → 权重重分配」，与离线口径一致。
alter table public.interest_suggestions
  add column if not exists embedding vector(1024);

-- 2. 卡片固有特征：quality / tagOverlap / knowledge / ranking_version。
--    ranking_version 不是历史标签，而是「这行能不能被当前代码重排」的开关：
--    将来给评分加新维度时，新写入的 features 带上新版本号，老行自动因版本
--    不匹配退回库 score —— 绝不会出现半批新契约半批旧契约混排。
alter table public.interest_suggestions
  add column if not exists ranking_features jsonb not null default '{}'::jsonb;

commit;

-- ── 执行后自检 ──
-- select column_name from information_schema.columns
--   where table_name='interest_suggestions'
--     and column_name in ('embedding','ranking_features');   -- 期望 2 行
--
-- select count(*) filter (where ranking_features <> '{}'::jsonb) as 可重排卡数,
--        count(*) as 总卡数
--   from public.interest_suggestions where status='active';
-- 首次全量重建后，期望：可重排卡数 = 总卡数。
