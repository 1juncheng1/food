-- ============================================================
-- 0009: 作者主页「作品」服务端分页
--
-- 问题：get_user_profile 用 jsonb_agg 一次聚合该作者的**全部**公开作品
--       （含 content 全文与 archive jsonb），作品越多返回体越大；
--       前端拿到全量后再用客户端切片兜着 —— 流量白花，首屏被拖慢。
--
-- 方案：给 get_user_profile 加 p_post_limit / p_post_offset（都带默认值，
--       不传参数时行为与旧版一致），posts 只返回当页；
--       额外返回 postsHasMore，前端据此决定是否继续翻页。
--
-- 注意：必须先 drop 旧签名再 create —— PostgreSQL 的
--       CREATE OR REPLACE 无法修改参数列表，直接 replace 会留下两个重载
--       （旧 (uuid) 与新 (uuid,int,int) 并存，调用点可能命中旧的）。
-- ============================================================

drop function if exists public.get_user_profile(uuid) cascade;

create or replace function public.get_user_profile(
  p_target_user_id uuid,
  p_post_limit integer default 20,
  p_post_offset integer default 0
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
  -- 上限 50：主页一屏不需要更多，防止前端传超大值把返回体撑爆
  v_limit integer := least(greatest(coalesce(p_post_limit, 20), 1), 50);
  v_offset integer := greatest(coalesce(p_post_offset, 0), 0);
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

  -- 作品：只取当页（先排序分页，再聚合，避免全表 jsonb_agg）
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
  from (
    select pp.*
    from public.posts pp
    where pp.user_id = p_target_user_id and pp.is_public = true
    order by pp.created_at desc
    limit v_limit
    offset v_offset
  ) p;

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
    -- 前端用这个判断是否还能继续翻（不要用 posts.length < limit 猜，
    -- 总数刚好被整除时会误判"没有更多"）
    'postsHasMore', v_post_count > v_offset + jsonb_array_length(v_posts),
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

grant execute on function public.get_user_profile(uuid, integer, integer) to authenticated;

-- 注：supabase/setup.sql 仍是初始版本（不含 0008 起的新字段），
-- 新环境请以 setup.sql 建库后按序跑 migrations/ 下的迁移。
