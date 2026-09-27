-- ============================================================
-- 0023_index_gaps.sql
-- 补齐索引缺口（2026-09-27 全库索引审计）
--
-- 审计方式：把 setup.sql 与全部 migration 的索引，逐条对照
--   业务代码里真实出现的 .eq() / .order() / .in() 组合。
--   只有"确实被查询"的列组合才建索引——多余索引不是免费的，
--   它拖慢每一次 INSERT/UPDATE，还会吃掉缓存。
--
-- 本迁移只加 1 条。下面同时记录**刻意不加**的三处及理由，
--   避免以后有人凭直觉补上去。
-- ============================================================

-- ─── 1. generation_feedback：用户反馈时间线 ────────────────
-- 两处真实查询都按 user_id 过滤 + created_at 排序：
--   · app/api/export-data/route.ts:82   导出我的数据（user_id, created_at desc）
--   · lib/creative/interest/backfill.ts:125  兴趣画像回填扫描
--     （user_id, feedback_type in (...), created_at asc）
--
-- 现有索引只有 gen_feedback_gen_idx(generation_id)，覆盖不到这两条：
-- backfill 是批量扫描，随着 generation_history 增长会线性变慢，
-- 最终表现为"画像构建跑不完"，而不是一条慢 SQL——最难排查的那类问题。
--
-- feedback_type 不进索引：它的区分度只有 5 个枚举值，
-- 放进复合索引收益极低却会让每一条索引项变宽。由 user_id 前缀过滤后
-- 在内存里筛 5 个枚举值，比多维护一个宽索引划算。
create index if not exists gen_feedback_user_created_idx
  on public.generation_feedback (user_id, created_at desc);

comment on index public.gen_feedback_user_created_idx is
  '用户反馈时间线：支撑"导出我的数据"与兴趣画像回填扫描（backfill 是批量全扫，缺索引会随数据增长线性变慢）';

-- ─── 刻意不加的三处（记录理由，别再补）────────────────────

-- ① ci_search_log（无任何二级索引）
--    审计结论：**保持无索引**。
--    它是 append-only 的调用日志，全库检索不到任何读取它的代码——
--    lib/ci/service.ts 里只有 `void logSearch(...)` 写入，没有 SELECT。
--    给一张只写不读的表加索引，等于让每次写入都多维护一棵 B 树，纯亏。

-- ② posts(category, created_at)
--    审计结论：**不加**。
--    社区列表走的是 get_posts_base RPC，且前端没有按分类筛选的入口——
--    app/api/posts/route.ts:279 只在写入时给 category 赋值，从不按它过滤。
--    将来真做了分类筛选页再补，那时连排序方向都能定准。

-- ③ ci_items(query_hash, expires_at)
--    审计结论：**已存在**，无需重复建。
--    setup.sql:1557 的 idx_ci_items_query 已覆盖 lib/ci/store.ts:124 的
--    缓存命中查询（每次搜索都会走，是本表最热的路径）。

-- ─── 验证查询：确认索引被真实使用 ──────────────────────────
--   explain analyze
--     select * from public.generation_feedback
--      where user_id = '<某用户 id>'
--      order by created_at desc;
--   期望：Index Scan using gen_feedback_user_created_idx
--   （若仍是 Seq Scan，先跑 `analyze public.generation_feedback;` 刷新统计信息）
