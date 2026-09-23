-- ============================================================
-- P3-1: /api/posts RPC 拆分 + 服务端缓存支持
--
-- 问题：get_recommended_posts 每行做 2 个 exists 子查询计算
--       current_user_liked/current_user_saved，且响应含用户状态
--       字段导致无法跨用户共享缓存。P95 = 3257ms（实测）。
--
-- 方案：拆分为两个 RPC：
--   1. get_posts_base：返回公共字段（无用户状态），按时间倒序
--      → 可跨用户共享缓存（unstable_cache + TTL）
--   2. get_posts_user_state：批量查 post_ids 的用户状态
--      → 一次 IN 查询代替 N 个 exists
--
-- 无风格向量的用户走新 RPC（可缓存）+ 用户状态批量查
-- 有风格向量的用户保留原 get_recommended_posts（个性化排序）
-- ============================================================

-- ──────────────── P3-1a-1. 公共帖子列表 RPC（无用户状态）────────────────
-- 返回公共字段，按 created_at 倒序，无 current_user_liked/saved
-- 供 /api/posts 无风格向量分支调用，响应可跨用户共享缓存
drop function if exists public.get_posts_base(integer, integer) cascade;
create or replace function public.get_posts_base(
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  id uuid,
  user_id uuid,
  content text,
  content_type text,
  category text,
  tags text[],
  like_count integer,
  comment_count integer,
  save_count integer,
  is_public boolean,
  created_at timestamptz,
  author_name text,
  image_url text,
  post_type text,
  archive jsonb,
  source_project_id uuid
)
language sql
stable
security definer
set search_path = 'public'
as $$
  select
    p.id,
    p.user_id,
    p.content,
    p.content_type,
    p.category,
    p.tags,
    p.like_count,
    p.comment_count,
    p.save_count,
    p.is_public,
    p.created_at,
    -- 作者名：取邮箱 @ 前部分（隐私保护）
    split_part(coalesce(u.email, ''), '@', 1) as author_name,
    p.image_url,
    p.post_type,
    p.archive,
    p.source_project_id
  from public.posts p
  left join auth.users u on u.id = p.user_id
  where p.is_public = true
  order by p.created_at desc
  limit least(p_limit, 100)
  offset p_offset;
$$;

grant execute on function public.get_posts_base(integer, integer) to authenticated;

-- ──────────────── P3-1a-2. 批量查询用户状态 RPC ────────────────
-- 输入 post_ids 数组 + 用户 ID，返回每条 post 的 current_user_liked/saved
-- 一次 IN 查询代替 N 个 exists 子查询
drop function if exists public.get_posts_user_state(uuid, uuid[]) cascade;
create or replace function public.get_posts_user_state(
  p_user_id uuid,
  p_post_ids uuid[]
)
returns table (
  post_id uuid,
  liked boolean,
  saved boolean
)
language sql
stable
security definer
set search_path = 'public'
as $$
  select
    pid as post_id,
    exists (
      select 1 from public.post_interactions pi
      where pi.post_id = pid
        and pi.user_id = p_user_id
        and pi.interaction_type = 'like'
    ) as liked,
    exists (
      select 1 from public.post_interactions pi
      where pi.post_id = pid
        and pi.user_id = p_user_id
        and pi.interaction_type = 'save'
    ) as saved
  from unnest(p_post_ids) as pid;
$$;

grant execute on function public.get_posts_user_state(uuid, uuid[]) to authenticated;
