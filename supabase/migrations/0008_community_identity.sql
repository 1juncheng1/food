-- ============================================================
-- P4 社区化：作者身份统一 + 计数自愈
--
-- 背景（本次改造要修的问题）：
--   1. 作者名口径不一致：广场/详情/评论取「邮箱 @ 前缀」（setup.sql 856/935/1013/1108），
--      而个人主页取 user_metadata.display_name（setup.sql 1149）。
--      → 同一个人在两处两个名字，且邮箱前缀常是手机号/随机串（用户看到"复杂 ID"）。
--   2. 无头像字段：统一补 author_avatar_url（来自 user_metadata.avatar_url，未设置时
--      前端降级为首字母头像）。
--   3. posts.like_count/comment_count/save_count 是 post_interactions / comments 的冗余
--      聚合，靠应用层 RPC 增减维护、无触发器 → 长期漂移。提供一次性自愈函数。
--
-- 幂等：可重复执行。返回类型变更的函数先 DROP 再 CREATE（与 setup.sql 既有写法一致）。
-- 前端对新列做可选降级：本迁移未执行时，author_avatar_url 为 undefined，走首字母头像。
-- ============================================================

-- ──────────────── 1. 统一作者名/头像解析函数 ────────────────
-- 优先级：user_metadata.display_name（设置页可编辑）> 邮箱前缀 > '创作者'
-- SECURITY DEFINER：客户端无法直接读 auth.users
create or replace function public.user_display_name(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = 'public'
as $$
  select coalesce(
    nullif(trim(coalesce(
      (select u.raw_user_meta_data->>'display_name' from auth.users u where u.id = p_user_id),
      ''
    )), ''),
    nullif(split_part(coalesce(
      (select u.email from auth.users u where u.id = p_user_id),
      ''
    ), '@', 1), ''),
    '创作者'
  );
$$;

create or replace function public.user_avatar_url(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = 'public'
as $$
  select nullif(trim(coalesce(
    (select u.raw_user_meta_data->>'avatar_url' from auth.users u where u.id = p_user_id),
    ''
  )), '');
$$;

grant execute on function public.user_display_name(uuid) to authenticated;
grant execute on function public.user_avatar_url(uuid) to authenticated;

-- ──────────────── 2. get_posts_base：统一昵称 + 头像列 ────────────────
-- 返回类型变了（新增 author_avatar_url），必须 DROP
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
  author_avatar_url text,
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
    -- 一次 left join 取昵称/头像，避免每行两次函数调用（N 次索引扫描）
    coalesce(
      nullif(trim(coalesce(u.raw_user_meta_data->>'display_name', '')), ''),
      nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
      '创作者'
    ) as author_name,
    nullif(trim(coalesce(u.raw_user_meta_data->>'avatar_url', '')), '') as author_avatar_url,
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

-- ──────────────── 3. get_recommended_posts：统一昵称 + 头像列 ────────────────
drop function if exists public.get_recommended_posts(vector, integer, integer) cascade;
create or replace function public.get_recommended_posts(
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
  author_avatar_url text,
  current_user_liked boolean,
  current_user_saved boolean,
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
    coalesce(
      nullif(trim(coalesce(u.raw_user_meta_data->>'display_name', '')), ''),
      nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
      '创作者'
    ) as author_name,
    nullif(trim(coalesce(u.raw_user_meta_data->>'avatar_url', '')), '') as author_avatar_url,
    exists (
      select 1 from public.post_interactions pi
      where pi.post_id = p.id
        and pi.user_id = auth.uid()
        and pi.interaction_type = 'like'
    ) as current_user_liked,
    exists (
      select 1 from public.post_interactions pi
      where pi.post_id = p.id
        and pi.user_id = auth.uid()
        and pi.interaction_type = 'save'
    ) as current_user_saved,
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

grant execute on function public.get_recommended_posts(vector, integer, integer) to authenticated;

-- ──────────────── 4. get_post_detail：统一昵称 + 头像列 ────────────────
drop function if exists public.get_post_detail(uuid) cascade;
create or replace function public.get_post_detail(p_post_id uuid)
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
  created_at timestamptz,
  author_name text,
  author_avatar_url text,
  current_user_liked boolean,
  current_user_saved boolean,
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
    p.created_at,
    coalesce(
      nullif(trim(coalesce(u.raw_user_meta_data->>'display_name', '')), ''),
      nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
      '创作者'
    ) as author_name,
    nullif(trim(coalesce(u.raw_user_meta_data->>'avatar_url', '')), '') as author_avatar_url,
    exists (
      select 1 from public.post_interactions pi
      where pi.post_id = p.id and pi.user_id = auth.uid() and pi.interaction_type = 'like'
    ) as current_user_liked,
    exists (
      select 1 from public.post_interactions pi
      where pi.post_id = p.id and pi.user_id = auth.uid() and pi.interaction_type = 'save'
    ) as current_user_saved,
    p.image_url,
    p.post_type,
    p.archive,
    p.source_project_id
  from public.posts p
  left join auth.users u on u.id = p.user_id
  where p.id = p_post_id and p.is_public = true
  limit 1;
$$;

grant execute on function public.get_post_detail(uuid) to authenticated;

-- ──────────────── 5. get_post_comments：统一昵称 + 头像列 ────────────────
-- 返回类型变了（新增 author_avatar_url），必须 DROP
drop function if exists public.get_post_comments(uuid) cascade;
create or replace function public.get_post_comments(
  p_post_id uuid
)
returns table (
  id uuid,
  post_id uuid,
  user_id uuid,
  content text,
  created_at timestamptz,
  author_name text,
  author_avatar_url text
)
language sql
stable
security definer
set search_path = 'public'
as $$
  select
    c.id,
    c.post_id,
    c.user_id,
    c.content,
    c.created_at,
    coalesce(
      nullif(trim(coalesce(u.raw_user_meta_data->>'display_name', '')), ''),
      nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
      '创作者'
    ) as author_name,
    nullif(trim(coalesce(u.raw_user_meta_data->>'avatar_url', '')), '') as author_avatar_url
  from public.comments c
  left join auth.users u on u.id = c.user_id
  where c.post_id = p_post_id
  order by c.created_at asc;
$$;

grant execute on function public.get_post_comments(uuid) to authenticated;

-- ──────────────── 6. get_posts_with_authors：统一昵称（旧 RPC，未被 API 使用）────────────────
drop function if exists public.get_posts_with_authors(integer, integer) cascade;
create or replace function public.get_posts_with_authors(
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
  author_avatar_url text,
  current_user_liked boolean,
  current_user_saved boolean,
  image_url text
)
language sql
stable
security definer
set search_path = 'public'
as $$
  select
    p.id, p.user_id, p.content, p.content_type, p.category, p.tags,
    p.like_count, p.comment_count, p.save_count, p.is_public, p.created_at,
    coalesce(
      nullif(trim(coalesce(u.raw_user_meta_data->>'display_name', '')), ''),
      nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
      '创作者'
    ) as author_name,
    nullif(trim(coalesce(u.raw_user_meta_data->>'avatar_url', '')), '') as author_avatar_url,
    exists (
      select 1 from public.post_interactions pi
      where pi.post_id = p.id and pi.user_id = auth.uid() and pi.interaction_type = 'like'
    ) as current_user_liked,
    exists (
      select 1 from public.post_interactions pi
      where pi.post_id = p.id and pi.user_id = auth.uid() and pi.interaction_type = 'save'
    ) as current_user_saved,
    p.image_url
  from public.posts p
  left join auth.users u on u.id = p.user_id
  where p.is_public = true
  order by p.created_at desc
  limit least(p_limit, 100)
  offset p_offset;
$$;

grant execute on function public.get_posts_with_authors(integer, integer) to authenticated;

-- ──────────────── 7. get_user_profile：昵称/头像与新口径对齐 ────────────────
-- 原实现直接读 auth.users 的 display_name，逻辑与新口径一致，这里只补头像与简介字段：
--   authorAvatarUrl：user_metadata.avatar_url（未设置为 null）
--   bio：优先 Creator Profile 人格描述（style_profiles.creator_report.personality.description），
--        无则 null → 前端降级为"这位创作者还没有简介"
-- 注：返回 jsonb，新增字段对旧前端无破坏。
create or replace function public.get_user_profile(
  p_target_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = 'public'
as $$
declare
  v_current_user uuid := auth.uid();
  v_email text;
  v_display_name text;
  v_avatar_url text;
  v_profile record;
  v_creator jsonb;
  v_posts jsonb;
  v_is_following boolean;
  v_follower_count integer;
  v_following_count integer;
  v_post_count integer;
begin
  if v_current_user is null then
    return jsonb_build_object('success', false, 'error', '请先登录', 'code', 401);
  end if;

  select split_part(coalesce(email, ''), '@', 1),
         coalesce(nullif(trim(coalesce(raw_user_meta_data->>'display_name', '')), ''), ''),
         nullif(trim(coalesce(raw_user_meta_data->>'avatar_url', '')), '')
  into v_email, v_display_name, v_avatar_url
  from auth.users where id = p_target_user_id;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'style_profiles'
      and column_name = 'creator_report'
  ) then
    select tone_tags, pace_preference, common_opening, avg_length, source, creator_report
    into v_profile
    from public.style_profiles where user_id = p_target_user_id;

    if v_profile is not null and v_profile.creator_report ? 'personality' then
      select jsonb_build_object(
        'main', coalesce(v_profile.creator_report #>> '{personality,main}', ''),
        'sub', coalesce(v_profile.creator_report #>> '{personality,sub}', ''),
        'description', coalesce(v_profile.creator_report #>> '{personality,description}', ''),
        'confidence', v_profile.creator_report -> 'confidence',
        'motifs', coalesce((
          select jsonb_agg(t.label)
          from (
            select e->>'label' as label
            from jsonb_array_elements(v_profile.creator_report -> 'motifDna') e
            order by coalesce((e->>'count')::int, 0) desc
            limit 3
          ) t
        ), '[]'::jsonb),
        'narratives', coalesce((
          select jsonb_agg(t.label)
          from (
            select e->>'label' as label
            from jsonb_array_elements(v_profile.creator_report -> 'narrativeDna') e
            order by coalesce((e->>'count')::int, 0) desc
            limit 3
          ) t
        ), '[]'::jsonb)
      ) into v_creator;
    end if;
  else
    select tone_tags, pace_preference, common_opening, avg_length, source
    into v_profile
    from public.style_profiles where user_id = p_target_user_id;
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', p.id,
      'content', p.content,
      'content_type', p.content_type,
      'category', p.category,
      'tags', p.tags,
      'like_count', p.like_count,
      'comment_count', p.comment_count,
      'save_count', p.save_count,
      'image_url', p.image_url,
      'created_at', p.created_at,
      'post_type', p.post_type,
      'archive', p.archive,
      'current_user_liked', exists (
        select 1 from public.post_interactions pi
        where pi.post_id = p.id and pi.user_id = v_current_user and pi.interaction_type = 'like'
      ),
      'current_user_saved', exists (
        select 1 from public.post_interactions pi
        where pi.post_id = p.id and pi.user_id = v_current_user and pi.interaction_type = 'save'
      )
    ) order by p.created_at desc
  ), '[]'::jsonb) into v_posts
  from public.posts p
  where p.user_id = p_target_user_id and p.is_public = true;

  select exists (
    select 1 from public.follows f
    where f.follower_id = v_current_user and f.following_id = p_target_user_id
  ) into v_is_following;

  select count(*) into v_follower_count
  from public.follows where following_id = p_target_user_id;

  select count(*) into v_following_count
  from public.follows where follower_id = p_target_user_id;

  select count(*) into v_post_count
  from public.posts where user_id = p_target_user_id and is_public = true;

  return jsonb_build_object(
    'success', true,
    'userId', p_target_user_id,
    'authorName', coalesce(nullif(v_display_name, ''), nullif(v_email, ''), '创作者'),
    'authorAvatarUrl', v_avatar_url,
    'bio', coalesce(nullif(v_creator ->> 'description', ''), null),
    'isOwn', v_current_user = p_target_user_id,
    'isFollowing', v_is_following,
    'followerCount', v_follower_count,
    'followingCount', v_following_count,
    'postCount', v_post_count,
    'posts', v_posts,
    'styleProfile', case when v_profile is not null then
      jsonb_build_object(
        'tone_tags', v_profile.tone_tags,
        'pace_preference', v_profile.pace_preference,
        'common_opening', v_profile.common_opening,
        'avg_length', v_profile.avg_length,
        'source', v_profile.source,
        'creator', v_creator
      )
    else null end
  );
end;
$$;

grant execute on function public.get_user_profile(uuid) to authenticated;

-- ──────────────── 8. 计数自愈（发现点赞数/评论数对不上时手工执行一次）────────────────
-- select public.recompute_post_counts();  -- 返回修正的行数
-- 口径与后端一致：like_count = like + style_resonate（见 interactions 路由 COUNT_COLUMN）
create or replace function public.recompute_post_counts()
returns integer
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_rows integer := 0;
begin
  update public.posts p
  set like_count = coalesce((
        select count(*) from public.post_interactions pi
        where pi.post_id = p.id and pi.interaction_type in ('like', 'style_resonate')
      ), 0),
      save_count = coalesce((
        select count(*) from public.post_interactions pi
        where pi.post_id = p.id and pi.interaction_type = 'save'
      ), 0),
      comment_count = coalesce((
        select count(*) from public.comments c where c.post_id = p.id
      ), 0);

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- 只允许服务角色执行（前端不需要调用）
revoke all on function public.recompute_post_counts() from public, authenticated;
