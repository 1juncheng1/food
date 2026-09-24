-- ============================================================
-- 0010_author_cards.sql
-- 灵感广场作者身份：批量取「这位创作者是谁」
--
-- 背景（本次要修的问题）：
--   广场卡片上作者只有一个昵称（还常是邮箱前缀），读者无法判断「这个人值不值得点进主页」。
--   于是"作者"退化成一个不可判断的字符串，社区 Browse 的决策信息全部丢失。
--
-- 为什么是新函数而不是改现有 RPC：
--   1. 广场/详情用的 get_posts_base / get_recommended_posts 是 TABLE 返回函数，
--      加列必须 DROP + CREATE —— 为了一个展示字段去动社区读链路的主函数不划算。
--   2. 卡片需要的是「按作者去重后的简介」，不是「按帖子逐行重复的简介」。
--      20 条帖子常常只有 6 个作者，批量取一次比跟着每行重复计算更省。
--   3. 前端只在缺 ids 时补一次，并做会话级缓存 —— 后续翻页不再打这个 RPC。
--
-- 安全口径：
--   bio 来自 style_profiles.creator_report.personality.description，
--   与 0008 起 get_user_profile 对第三方曝光的口径一致（同一段文案、同一可见范围），
--   这里没有扩大任何人的可见数据面。
--
-- 幂等：可重复执行。
-- ============================================================

create or replace function public.get_author_cards(p_user_ids jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = 'public'
-- ⚠ 美元引用(dollar-quoting)标签必须两两不同：函数体 $fn$ 里还套着 $bio$ / $q$。
--   同标签（如外层 $$ 里再写 $$）会提前终止函数体 —— 这是上一版报
--   `syntax error at or near "nullif"` 的根因：函数体在第一个内层 $$ 处就结束了。
as $fn$
declare
  v_has_report boolean;
  v_bio_expr   text;
  v_result     jsonb;
begin
  if p_user_ids is null or jsonb_typeof(p_user_ids) <> 'array' then
    return '[]'::jsonb;
  end if;

  -- creator_report 是 0008 之前的可选列：不存在时 bio 一律 null，
  -- 前端降级为"这位创作者还没有简介"，而不是让整条查询报错。
  select exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name   = 'style_profiles'
      and c.column_name  = 'creator_report'
  ) into v_has_report;

  v_bio_expr := case
    when v_has_report
      then $bio$nullif(trim(coalesce(sp.creator_report #>> '{personality,description}', '')), '')$bio$
    else $bio$null::text$bio$
  end;

  -- %s 只拼前半段判出来的常量表达式，不接受外部输入。
  execute format($q$
    with requested as (
      -- 先按格式筛掉脏 id，再 cast：子查询保证 ::uuid 只会作用在通过正则的行上
      -- （同一层里 cast 与过滤的执行顺序不受保证，混写一次就可能因为一个脏 id 让整页 500）
      select distinct valid.v::uuid as id
      from (
        select t.x as v
        from jsonb_array_elements_text($1::jsonb) as t(x)
        where t.x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        limit 60
      ) as valid
    ),
    domains as (
      select p.user_id as uid, p.category as cat, count(*)::int as cnt
      from public.posts p
      join requested i on i.id = p.user_id
      where p.is_public = true
        and coalesce(trim(p.category), '') <> ''
      group by p.user_id, p.category
    ),
    ranked as (
      select uid, cat, cnt,
             row_number() over (partition by uid order by cnt desc, cat) as rn
      from domains
    ),
    agg as (
      select uid,
             array_agg(cat order by rn) as tags,
             sum(cnt)::int as total
      from ranked
      where rn <= 3
      group by uid
    )
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'userId',          u.id,
        'authorName',      coalesce(
                             nullif(trim(coalesce(u.raw_user_meta_data->>'display_name', '')), ''),
                             nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
                             '创作者'
                           ),
        'authorAvatarUrl', nullif(trim(coalesce(u.raw_user_meta_data->>'avatar_url', '')), ''),
        'bio',             %s,
        'domains',         coalesce(a.tags, '{}'::text[]),
        'postCount',       coalesce(a.total, 0)
      )
    ), '[]'::jsonb)
    from requested i
    join auth.users u on u.id = i.id
    left join agg a on a.uid = i.id
    left join public.style_profiles sp on sp.user_id = i.id
  $q$, v_bio_expr)
  into v_result
  using p_user_ids;

  return coalesce(v_result, '[]'::jsonb);
end;
$fn$;

grant execute on function public.get_author_cards(jsonb) to authenticated;

comment on function public.get_author_cards(jsonb) is
  '灵感广场作者卡片：批量取昵称/头像/简介/常用领域。简介口径与 get_user_profile 的 bio 一致；'
  '未传或从 auth.users 查不到的 id 不会出现在结果里 —— 前端按缺就是没有处理。';

-- ── 验证查询（执行后应返回空数组或作者数组，不应报错）──────────────
--   select public.get_author_cards('[]'::jsonb);
--   select public.get_author_cards(jsonb_build_array(auth.uid()));
