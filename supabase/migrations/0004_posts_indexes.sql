-- ============================================================
-- P3-1c: posts 表索引优化
--
-- 问题：get_recommended_posts RPC 实测 P95 = 2700-3400ms，
--       P3-1b RPC 拆分无收益（已回滚），说明瓶颈不在 exists 子查询。
--       真正瓶颈在：
--       1. ORDER BY style_vector <=> p_user_vector（向量余弦距离排序）
--          无 ivfflat 索引时会全表扫描 + 排序
--       2. WHERE is_public = true（无部分索引）
--       3. JOIN auth.users（系统表，无法优化）
--       4. ORDER BY created_at DESC（时间倒序兜底排序）
--
-- 方案：
--   1. ivfflat 索引：加速向量余弦距离排序
--   2. 部分索引：is_public=true 的 posts 子集，加速公共列表查询
--   3. 复合索引：(is_public, created_at DESC)：加速时间倒序兜底
--
-- 注：ivfflat 需要数据已存在才能聚类，lists 参数建议 = sqrt(rows)
-- ============================================================

-- ──────────────── 1. ivfflat 向量索引（余弦距离）────────────────
-- 加速 ORDER BY style_vector <=> p_user_vector
-- lists=100 适合 ~10000 行表（如数据少可调小，数据多需重建）
drop index if exists public.posts_style_vector_ivfflat_idx;
create index if not exists posts_style_vector_ivfflat_idx
  on public.posts
  using ivfflat (style_vector vector_cosine_ops)
  with (lists = 100)
  where style_vector is not null;

-- ──────────────── 2. 公共帖子部分索引（is_public=true）────────────────
-- 加速 WHERE is_public = true 过滤
drop index if exists public.posts_public_partial_idx;
create index if not exists posts_public_partial_idx
  on public.posts (created_at desc)
  where is_public = true;

-- ──────────────── 3. 复合索引：用户作品查询 ────────────────
-- 加速 WHERE user_id = ? AND is_public = true ORDER BY created_at DESC
-- 用于用户主页 /profile/[userId] 的作品列表查询
drop index if exists public.posts_user_public_created_idx;
create index if not exists posts_user_public_created_idx
  on public.posts (user_id, is_public, created_at desc);

-- ──────────────── 4. post_interactions 复合索引 ────────────────
-- 加速 get_posts_user_state 的批量查
-- WHERE post_id = ? AND user_id = ? AND interaction_type = ?
drop index if exists public.post_interactions_post_user_type_idx;
create index if not exists post_interactions_post_user_type_idx
  on public.post_interactions (post_id, user_id, interaction_type);

-- ──────────────── 5. 验证索引创建成功 ────────────────
-- 执行后可查询验证：
-- select indexname, indexdef from pg_indexes where tablename = 'posts';
-- select indexname, indexdef from pg_indexes where tablename = 'post_interactions';
