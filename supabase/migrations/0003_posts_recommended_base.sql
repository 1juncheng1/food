-- ============================================================
-- P3-1b: /api/posts 有向量分支优化
--
-- 问题：原 get_recommended_posts 每行做 2 个 exists 子查询
--       计算 current_user_liked/saved（2N 个子查询），
--       且 JOIN auth.users 性能开销大。
--       实测 P95 = 2706-3257ms（dev 环境）。
--
-- 方案：新增 get_posts_recommended_base RPC
--   - 用 LEFT JOIN 代替 exists（1 次 JOIN 代替 N 个子查询）
--   - 不返回 current_user_liked/saved（由 get_posts_user_state 批量查）
--   - 保留 style_vector 相似度排序
--
-- 有向量分支数据流变为：
--   get_posts_recommended_base(user_vector, limit, offset)  ← 1 次查询
--   + get_posts_user_state(user_id, post_ids)              ← 1 次查询
--   = 2 次查询代替 2N+1 次查询
-- ============================================================

-- ──────────────── P3-1b. 有向量分支公共数据 RPC ────────────────
-- 返回公共字段 + similarity，无 current_user_liked/saved
-- 用 LEFT JOIN 代替 exists 子查询
drop function if exists public.get_posts_recommended_base(vector, integer, integer) cascade;
create or replace function public.get_posts_recommended_base(
  p_user_vector vector default null,
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
  source_project_id uuid,
  similarity double precision
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
    split_part(coalesce(u.email, ''), '@', 1) as author_name,
    p.image_url,
    p.post_type,
    p.archive,
    p.source_project_id,
    case when p_user_vector is not null and p.style_vector is not null
      then 1 - (p.style_vector <=> p_user_vector)
      else null
    end as similarity
  from public.posts p
  left join auth.users u on u.id = p.user_id
  where p.is_public = true
  order by
    case when p_user_vector is not null and p.style_vector is not null
      then p.style_vector <=> p_user_vector
      else null
    end asc nulls last,
    p.created_at desc
  limit least(p_limit, 100)
  offset p_offset;
$$;

grant execute on function public.get_posts_recommended_base(vector, integer, integer) to authenticated;
