-- ============================================================
-- 0011_knowledge_work_links.sql
-- Creator Knowledge System：知识单元 ↔ 作品 的关联留痕
--
-- 背景（本次要修的问题）：
--   0006 解决了「这次生成用了哪几条知识」的当次留痕（generation_history.used_knowledge），
--   但它解决不了两个问题：
--     1. 那条快照里只有 concept 文本、没有知识单元 id —— 顺着作品反查不到是哪一条单元，
--        你在 /knowledge 上点「确认」，也看不出这条知识被哪些作品用过。
--     2. 用户主动沉淀的知识（访谈里说出来的、手动确认的）根本没进过生成链路，
--        它与作品的关系从来没有被人显式表达过。
--   结果就是：知识库是一个孤岛，写出来的"这一条我很确定"与"哪些作品体现了它"
--   之间没有任何连接，复盘时只能靠人回忆。
--
-- 为什么是一张关联表而不是继续往 jsonb 里塞：
--   used_knowledge 是「当次生成的事实快照」，语义是只读历史（见 0006 第 16-33 行）；
--   而"这条知识属于哪些作品"是**当前关系的指针**，会被用户手动增删。
--   两者混进同一列，历史就会被当前状态改写 —— 0006 刻意避免的正是这件事。
--
-- ⚠ 复用优先原则（与 0005/0006 一致）：
--   - 不复制知识正文：只存 knowledge_id 弱引用，claim 措辞改了引用关系不断
--   - 不复制作品正文：只存 creative_projects.id，标题随时间变化也没关系
--   - 不为"是否已用于创作"新建判定表：knowledge.status='已确认' 仍是注入的唯一闸门，
--     本表只回答"被哪些作品用过"，不改任何准入逻辑
--
-- 幂等：可重复执行。
-- ============================================================

create table if not exists public.creator_knowledge_links (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,

  -- 弱引用：不跟 creator_knowledge 抢 FK 的删除权（下面条件添加），也没有跨库硬依赖
  knowledge_id uuid not null,
  -- 强引用：作品不存在了，关联关系就没有意义，跟着删
  project_id   uuid not null references public.creative_projects(id) on delete cascade,

  -- 来源：manual=用户在知识库里手动关联 / auto_history=从历史版本的 used_knowledge 回填
  origin       text not null default 'manual'
               check (origin in ('manual', 'auto_history')),

  created_at   timestamptz not null default now(),

  -- 同一条知识对同一个作品只可能有一条关系：回填可以反复跑，靠它保证不重复
  constraint creator_knowledge_links_uniq unique (knowledge_id, project_id)
);

alter table public.creator_knowledge_links enable row level security;

-- 清理旧策略后重建规范四条（与 creator_knowledge 一致）
do $$
declare r record;
begin
  for r in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'creator_knowledge_links'
  loop
    execute format('drop policy if exists %I on public.creator_knowledge_links', r.policyname);
  end loop;
end $$;

create policy creator_knowledge_links_select_own on public.creator_knowledge_links
  for select to authenticated using (auth.uid() = user_id);

create policy creator_knowledge_links_insert_own on public.creator_knowledge_links
  for insert to authenticated with check (auth.uid() = user_id);

create policy creator_knowledge_links_update_own on public.creator_knowledge_links
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy creator_knowledge_links_delete_own on public.creator_knowledge_links
  for delete to authenticated using (auth.uid() = user_id);

-- 只能看 creator_knowledge 的外键在迁移齐了之后再加：
-- 0005 尚未执行的库也应当能把本迁移跑完（届时只是少一道级联删除），
-- 而不是让整段 SQL 在第 1 行就失败。
do $$
begin
  if to_regclass('public.creator_knowledge') is not null
     and not exists (
       select 1 from pg_constraint
       where conname = 'creator_knowledge_links_knowledge_fk'
     ) then
    alter table public.creator_knowledge_links
      add constraint creator_knowledge_links_knowledge_fk
      foreign key (knowledge_id) references public.creator_knowledge(id) on delete cascade;
  end if;
end $$;

create index if not exists creator_knowledge_links_knowledge_idx
  on public.creator_knowledge_links (knowledge_id);

create index if not exists creator_knowledge_links_user_project_idx
  on public.creator_knowledge_links (user_id, project_id);

comment on column public.creator_knowledge_links.origin is
  'manual=用户在知识库手动关联 / auto_history=由 sync_knowledge_project_links 从历史版本快照回填';

-- ─────────────── 历史回填函数 ───────────────
-- 0006 已经把"这次生成用了哪些 concept"写在每个版本行里了。这里把它翻译成显式的
-- 知识 id → 作品 id 关系，让老数据一次性接上新结构，不需要重跑任何一次生成。
--
-- 返回新增的关联行数（已存在的重复关系不计入）。
create or replace function public.sync_knowledge_project_links(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_count integer := 0;
begin
  -- 只允许回填自己的历史：SECURITY DEFINER 下必须显式设这道闸
  if p_user_id is null or auth.uid() is null or p_user_id <> auth.uid() then
    return 0;
  end if;

  -- 任一依赖缺失都安静返回 0，不让"少跑了一个迁移"变成 500
  if to_regclass('public.creator_knowledge') is null
     or to_regclass('public.creator_knowledge_links') is null
     or to_regclass('public.generation_history') is null then
    return 0;
  end if;
  if not exists (
    select 1 from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name   = 'generation_history'
      and c.column_name  = 'used_knowledge'
  ) then
    return 0;
  end if;

  with history_rows as (
    select gh.project_id, uk->>'concept' as concept
    from public.generation_history gh
    -- 守卫必须写在 lateral 的入参里：
    --   set-returning 函数在 FROM 阶段求值，WHERE 里的 `jsonb_typeof = 'array'`
    --   救不了它 —— 只要有一行的 used_knowledge 不是数组（老版本写脏的对象、
    --   或半路失败留下残缺值），整个回填就会报
    --   "cannot extract elements from an object" 而整段失败。
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(gh.used_knowledge) = 'array' then gh.used_knowledge
        else '[]'::jsonb
      end
    ) as uk
    where gh.user_id = p_user_id
      and gh.project_id is not null
  ),
  matched as (
    select distinct ck.id as knowledge_id, h.project_id
    from history_rows h
    join public.creator_knowledge ck
      on ck.user_id = p_user_id and ck.concept = h.concept
    where nullif(trim(coalesce(h.concept, '')), '') is not null
  )
  insert into public.creator_knowledge_links (user_id, knowledge_id, project_id, origin)
  select p_user_id, m.knowledge_id, m.project_id, 'auto_history'
  from matched m
  on conflict (knowledge_id, project_id) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.sync_knowledge_project_links(uuid) to authenticated;

comment on function public.sync_knowledge_project_links(uuid) is
  '把 generation_history.used_knowledge 的历史快照翻译成显式的知识↔作品关联；'
  '只回填调用者自己的数据，重复执行不会重复插入。';

-- ── 验证查询（执行后应成功，返回受影响行数 0 或正整数）──────────────
--   select tablename from pg_tables where tablename = 'creator_knowledge_links';
--   select policyname, cmd from pg_policies where tablename = 'creator_knowledge_links';
--   select public.sync_knowledge_project_links(auth.uid());

-- 同 0005 的教训：表级 GRANT 必须显式给，否则 RLS 策略形同虚设——
-- 查询在到达策略之前就被 `permission denied for table` 挡住了。
grant select, insert, update, delete on public.creator_knowledge_links to authenticated;
