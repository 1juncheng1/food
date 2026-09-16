-- ============================================================
-- 视界 · 数据库一键整理脚本（幂等，可重复执行，不删除业务数据）
-- 用法：Supabase Dashboard -> SQL Editor -> 新建查询 -> 全部粘贴 -> Run
-- 内容：表结构 / 索引 / RLS 策略 / match_scripts 函数 / Storage 桶 / submit_feedback 反馈事务函数
-- ============================================================

-- ──────────────── 1. 表结构 ────────────────

-- 主表：不存在时才创建（已有的表不会被改动数据）
create table if not exists public.scripts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  content    text not null,
  type       text,
  file_url   text,
  category   text,
  embedding  vector(1024),
  created_at timestamptz not null default now()
);

-- 补齐可能缺失的列（已存在则跳过）
alter table public.scripts add column if not exists type       text;
alter table public.scripts add column if not exists file_url   text;
alter table public.scripts add column if not exists category   text;

-- 修正 embedding 列：若建列时没固定维度，统一为 1024 维（bge-m3）
do $$
declare
  v_type text;
begin
  select format_type(a.atttypid, a.atttypmod) into v_type
  from pg_attribute a
  join pg_class c     on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'scripts'
    and a.attname = 'embedding'
    and not a.attisdropped;

  if v_type = 'vector' then
    execute 'alter table public.scripts alter column embedding type vector(1024)';
    raise notice 'embedding 列已从无维度修正为 vector(1024)';
  end if;
exception
  when others then
    -- 存在维度不一致的历史数据时会走到这里，不影响其余整理步骤
    raise warning 'embedding 列维度修正失败（%），请检查历史数据', sqlerrm;
end $$;

-- ──────────────── 2. 索引 ────────────────

-- 用户列表查询索引（dashboard 按用户+时间倒序查）
create index if not exists scripts_user_created_idx
  on public.scripts (user_id, created_at desc);

-- 向量相似度检索索引（HNSW + 余弦距离）；失败仅影响检索速度，不阻断脚本
do $$
begin
  create index if not exists scripts_embedding_hnsw_idx
    on public.scripts using hnsw (embedding public.vector_cosine_ops);
exception
  when others then
    raise notice 'HNSW 索引创建失败（%），不影响功能，仅检索稍慢', sqlerrm;
end $$;

-- ──────────────── 3. RLS 策略（清理旧策略后重建规范三条） ────────────────

do $$
declare r record;
begin
  for r in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'scripts'
  loop
    execute format('drop policy if exists %I on public.scripts', r.policyname);
  end loop;
end $$;

alter table public.scripts enable row level security;

create policy scripts_select_own on public.scripts
  for select to authenticated
  using (auth.uid() = user_id);

create policy scripts_insert_own on public.scripts
  for insert to authenticated
  with check (auth.uid() = user_id);

create policy scripts_delete_own on public.scripts
  for delete to authenticated
  using (auth.uid() = user_id);

-- ──────────────── 4. match_scripts 函数（删旧版重载，重建规范版） ────────────────
-- 说明：用 OPERATOR(schema.<=>) 全限定写法 + 自动探测 pgvector 所在 schema，
--       不依赖 search_path 解析，避免 "operator does not exist: vector <=> vector"

do $$
declare
  ext_schema text;
  r record;
begin
  -- 定位 pgvector 实际安装的 schema（public 或 extensions）
  select n.nspname into ext_schema
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'vector';

  if ext_schema is null then
    raise exception '未检测到 pgvector 扩展，请先在 Database -> Extensions 中启用 vector';
  end if;
  raise notice 'pgvector 位于 schema: %，开始重建 match_scripts', ext_schema;

  -- 删除所有旧版本（含不同签名的重载）
  for r in
    select p.oid::regprocedure as fn
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'match_scripts'
  loop
    execute format('drop function %s', r.fn);
  end loop;

  -- 规范版：security invoker + 固定 search_path + 全限定操作符
  execute format($f$
    create or replace function public.match_scripts(
      query_embedding %1$I.vector,
      match_count     integer,
      p_user_id       uuid
    )
    returns table (
      id         uuid,
      content    text,
      similarity double precision
    )
    language sql
    stable
    security invoker
    set search_path = %2$L
    as $body$
      select
        s.id,
        s.content,
        1 - (s.embedding operator(%1$I.<=>) query_embedding) as similarity
      from public.scripts s
      where s.user_id = p_user_id
      order by s.embedding operator(%1$I.<=>) query_embedding
      limit least(match_count, 50);
    $body$;
  $f$, ext_schema, 'public, ' || ext_schema);

  raise notice 'match_scripts 重建完成';
end $$;

-- ──────────────── 5. Storage：media 桶 ────────────────

-- 创建/更新 media 公开桶，加 5MB 上限 + 图片 MIME 白名单（与 API 校验一致）
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'media', 'media', true,
  5242880,
  array['image/jpeg','image/png','image/webp','image/gif']
)
on conflict (id) do update
  set public             = true,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 上传权限：登录用户只能传到以自己 user_id 命名的文件夹
drop policy if exists "media_insert_own" on storage.objects;
create policy "media_insert_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- 读取权限：media 为公开桶，公开 URL 可直接访问
drop policy if exists "media_public_read" on storage.objects;
create policy "media_public_read" on storage.objects
  for select to public
  using (bucket_id = 'media');

-- ──────────────── 6. 生成历史 + 反馈表 ────────────────

-- 生成历史：记录每次 AI 生成的内容和用户输入参数
create table if not exists public.generation_history (
  id              text primary key,           -- 前端生成的 UUID（与 localStorage 作品 id 一致）
  user_id         uuid not null,
  topic           text not null,              -- 解说主题
  identity_label  text,                       -- 身份名称
  style           text,                       -- 文风描述
  category        text,                       -- 内容类型
  system_prompt   text,                       -- 生成的成品系统提示词
  sample_text     text not null,              -- 生成的解说范文
  feedback_status text default null,          -- like / dislike / edited / regenerated
  created_at      timestamptz not null default now()
);

-- 补齐 embedding 列：用于风格向量计算（与 scripts 表一致，bge-m3 1024 维）
alter table public.generation_history add column if not exists embedding vector(1024);

alter table public.generation_history enable row level security;

drop policy if exists "gen_history_select_own" on public.generation_history;
create policy "gen_history_select_own" on public.generation_history
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "gen_history_insert_own" on public.generation_history;
create policy "gen_history_insert_own" on public.generation_history
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "gen_history_update_own" on public.generation_history;
create policy "gen_history_update_own" on public.generation_history
  for update to authenticated using (auth.uid() = user_id);

-- 反馈记录：用户对每次生成的评价
create table if not exists public.generation_feedback (
  id              uuid primary key default gen_random_uuid(),
  generation_id   text not null references public.generation_history(id) on delete cascade,
  user_id         uuid not null,
  feedback_type   text not null check (feedback_type in ('like','dislike','edit','regenerate','optimize')),
  edited_content  text,                       -- feedback_type='edit' 时用户修改后的内容
  created_at      timestamptz not null default now()
);

alter table public.generation_feedback enable row level security;

drop policy if exists "gen_feedback_select_own" on public.generation_feedback;
create policy "gen_feedback_select_own" on public.generation_feedback
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "gen_feedback_insert_own" on public.generation_feedback;
create policy "gen_feedback_insert_own" on public.generation_feedback
  for insert to authenticated with check (auth.uid() = user_id);

create index if not exists gen_history_user_idx
  on public.generation_history (user_id, created_at desc);

create index if not exists gen_feedback_gen_idx
  on public.generation_feedback (generation_id);

-- generation_history embedding 向量索引（HNSW + 余弦距离）
do $$
begin
  create index if not exists gen_history_embedding_hnsw_idx
    on public.generation_history using hnsw (embedding public.vector_cosine_ops);
exception
  when others then
    raise notice 'generation_history HNSW 索引创建失败（%），不影响功能', sqlerrm;
end $$;

-- 显式授权：RLS 策略只过滤行，不授予权限；
-- 缺少 GRANT 时 security invoker 函数会报 "permission denied for table"
grant select, insert, update on public.generation_history to authenticated;
grant select, insert on public.generation_feedback to authenticated;
grant execute on function public.submit_feedback(text, text, text, text, text, text, text, text, text) to authenticated;

-- ──────────────── 7. 风格卡表 ────────────────
-- 每用户一行，存储从历史内容统计出的创作风格特征
create table if not exists public.style_profiles (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  tone_tags        text[]      not null default '{}',   -- 语气标签：犀利/幽默/温情/悬疑 等
  pace_preference  text        not null default '未知', -- 快节奏 / 慢节奏 / 中等 / 未知
  common_opening   text        not null default '未知', -- 提问式 / 叙事式 / 未知
  avg_length       integer     not null default 0,       -- 内容平均字符数
  source           text        not null default 'auto',  -- auto=自动统计 / manual=手动编辑
  updated_at       timestamptz not null default now()
);

-- 补齐 style_vector 列：用户历史内容的平均嵌入向量（bge-m3 1024 维），用于生成时混合检索
alter table public.style_profiles add column if not exists style_vector vector(1024);

alter table public.style_profiles enable row level security;

drop policy if exists "style_profile_select_own" on public.style_profiles;
create policy "style_profile_select_own" on public.style_profiles
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "style_profile_insert_own" on public.style_profiles;
create policy "style_profile_insert_own" on public.style_profiles
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "style_profile_update_own" on public.style_profiles;
create policy "style_profile_update_own" on public.style_profiles
  for update to authenticated using (auth.uid() = user_id);

-- 显式授权：RLS 策略只过滤行，不授予权限
grant select, insert, update on public.style_profiles to authenticated;

-- ──────────────── 8. submit_feedback 反馈事务函数 ────────────────
-- 一个函数内完成「补建历史 → 插入反馈 → 更新状态」：单次 RPC 调用 = 单个事务，原子提交，
-- 替代前端客户端无法实现的跨表事务。
-- like/dislike 为 toggle 语义：当前状态与本次相同则取消（feedback_status 置 null，事件日志仍追加）。
-- security invoker：以调用者 JWT 身份执行（auth.uid() 可用，所有读写均受 RLS 约束）。
-- 返回 jsonb：成功 { success:true, generationId, feedbackStatus }（取消时 feedbackStatus 为 null）
--            失败 { success:false, error, code }

-- 参数说明：必填参数 p_feedback_type 必须放在所有带默认值参数之前（Postgres 规则）；
-- 前端 supabase.rpc() 按参数名传参，与参数顺序无关。
create or replace function public.submit_feedback(
  p_feedback_type  text,                       -- 必填：like / dislike / edit / regenerate
  p_generation_id  text default null,
  p_edited_content text default null,
  p_topic          text default null,
  p_identity_label text default null,
  p_style          text default null,
  p_category       text default null,
  p_system_prompt  text default null,
  p_sample_text    text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = 'public'
as $$
declare
  v_user_id     uuid := auth.uid();
  v_gen_id      text := coalesce(p_generation_id, '');
  v_status      text;
  v_prev_status text;  -- 本次反馈前历史行上的状态（like/dislike 再点取消用）
  v_exists      boolean;
begin
  -- 登录校验
  if v_user_id is null then
    return jsonb_build_object('success', false, 'error', '请先登录', 'code', 401);
  end if;

  -- 反馈类型校验（表上 CHECK 约束兜底）
  if p_feedback_type not in ('like', 'dislike', 'edit', 'regenerate') then
    return jsonb_build_object('success', false, 'error', '无效的反馈类型', 'code', 400);
  end if;

  -- edit 类型必须带修改后的内容
  if p_feedback_type = 'edit' and coalesce(p_edited_content, '') = '' then
    return jsonb_build_object('success', false, 'error', '请填写修改后的内容', 'code', 400);
  end if;

  -- 状态映射：like→like, dislike→dislike, edit→edited, regenerate→regenerated
  v_status := case p_feedback_type
    when 'like' then 'like'
    when 'dislike' then 'dislike'
    when 'edit' then 'edited'
    else 'regenerated'
  end;

  -- a) 无 id 时生成新 id；历史记录不存在（RLS 下他人的记录同样查不到）时延迟创建
  if v_gen_id = '' then
    v_gen_id := gen_random_uuid()::text;
  end if;

  select exists (
    select 1 from public.generation_history
    where id = v_gen_id and user_id = v_user_id
  ) into v_exists;

  if not v_exists then
    if coalesce(p_sample_text, '') = '' then
      return jsonb_build_object(
        'success', false,
        'error', '生成记录不存在，且未提供生成内容以创建记录',
        'code', 404
      );
    end if;

    begin
      insert into public.generation_history (
        id, user_id, topic, identity_label, style, category, system_prompt, sample_text
      ) values (
        v_gen_id,
        v_user_id,
        coalesce(nullif(btrim(coalesce(p_topic, '')), ''), '未命名'),
        nullif(btrim(coalesce(p_identity_label, '')), ''),
        nullif(btrim(coalesce(p_style, '')), ''),
        nullif(btrim(coalesce(p_category, '')), ''),
        nullif(btrim(coalesce(p_system_prompt, '')), ''),
        p_sample_text
      );
    exception when unique_violation then
      -- id 已存在但属于其他用户（RLS 下查不到，插入时主键冲突暴露）
      return jsonb_build_object('success', false, 'error', '生成记录不属于当前用户', 'code', 403);
    end;
  end if;

  -- b) 读取本次操作前的状态（like/dislike 支持「再点一次取消」：与上一状态相同 → 置 null）
  select feedback_status into v_prev_status
  from public.generation_history
  where id = v_gen_id and user_id = v_user_id;

  -- c) 追加反馈事件日志（append-only：like→取消也留痕，export-data 可还原完整操作轨迹）
  insert into public.generation_feedback (generation_id, user_id, feedback_type, edited_content)
  values (v_gen_id, v_user_id, p_feedback_type, p_edited_content);

  -- d) 更新历史记录的反馈状态；like/dislike 重复点击同一状态 = 取消（feedback_status 置 null）
  if p_feedback_type in ('like', 'dislike') and v_prev_status = v_status then
    v_status := null;
  end if;

  update public.generation_history
  set feedback_status = v_status
  where id = v_gen_id;

  -- feedbackStatus 为 null 时 jsonb_build_object 输出 null，前端据此把按钮恢复未选态
  return jsonb_build_object('success', true, 'generationId', v_gen_id, 'feedbackStatus', v_status);
end;
$$;

-- ──────────────── 9. 创作进化系统（蓝图 → 版本 → 诊断 → 持续迭代） ────────────────
-- 设计原则：不与现有表重复——
--   creative_projects        新建：一个主题下多版本的归属主体
--   generation_history 扩 4 列：兼任 creative_versions（project_id + version_number + blueprint + analysis）
--   generation_feedback 扩 1 列：direction 记录选择的优化方向
--   style_profiles 扩 1 列：style_dimensions 存可读化风格维度分（style_vector 继续负责向量检索）

-- ───── 9.1 creative_projects：创作项目 ─────
create table if not exists public.creative_projects (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  title           text not null,                    -- 作品名（通常取主题）
  topic           text not null,                    -- 原始输入主题
  status          text not null default 'active',  -- active=迭代中 / finalized=已定稿
  current_version integer not null default 1,      -- 当前最新版本号
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists creative_projects_user_idx
  on public.creative_projects (user_id, updated_at desc);

alter table public.creative_projects enable row level security;

drop policy if exists "creative_projects_select_own" on public.creative_projects;
create policy "creative_projects_select_own" on public.creative_projects
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "creative_projects_insert_own" on public.creative_projects;
create policy "creative_projects_insert_own" on public.creative_projects
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "creative_projects_update_own" on public.creative_projects;
create policy "creative_projects_update_own" on public.creative_projects
  for update to authenticated using (auth.uid() = user_id);

drop policy if exists "creative_projects_delete_own" on public.creative_projects;
create policy "creative_projects_delete_own" on public.creative_projects
  for delete to authenticated using (auth.uid() = user_id);

grant select, insert, update, delete on public.creative_projects to authenticated;

-- ───── 9.2 generation_history 扩展为"作品版本表" ─────
-- project_id：所属创作项目（老数据为 null，表示升级前的单次生成作品）
-- version_number：项目内版本号 V1/V2/V3…（老数据为 null）
-- blueprint：该版本依据的创作蓝图（jsonb）
-- analysis：AI 诊断报告（jsonb，阶段 4 写入）
-- improve_direction：该版本为定向迭代版时的优化方向（hit/style/emotion/depth/video/script/custom，阶段 5；V1 与旧路径为 null）
-- improve_note：该版本相对上一版"AI 为什么这样修改"的一句话说明（第四阶段；V1 与旧路径为 null）
alter table public.generation_history add column if not exists project_id     uuid references public.creative_projects(id) on delete set null;
alter table public.generation_history add column if not exists version_number integer;
alter table public.generation_history add column if not exists blueprint      jsonb;
alter table public.generation_history add column if not exists analysis       jsonb;
alter table public.generation_history add column if not exists improve_direction text;
alter table public.generation_history add column if not exists improve_note text;
-- 阶段四：登场角色快照（生成时锁定的设定数组，与角色库解耦；无角色为 null）
alter table public.generation_history add column if not exists characters    jsonb;
-- Creator Mode：本篇创作模式 inspiration=灵感模式(系统AI) / creator=我的模式(Creator AI)；老作品为 null
alter table public.generation_history add column if not exists generation_mode text;
-- Creator Mode 第七阶段：个性化证据快照（本次采用了哪些特征/数据层，含风格一致度与 DNA 统计）
alter table public.generation_history add column if not exists personalization jsonb;

create index if not exists gen_history_project_ver_idx
  on public.generation_history (project_id, version_number);

-- ── Creator Mode 第五阶段：历史作品向量检索（与 match_scripts 同口径）──
-- 我的模式生成时，按主题检索该用户自己的历史作品，让 AI 模仿其真实行文而非只看统计标签。
-- security invoker：RLS 兜底只能检索自己的作品；embedding 为空的旧行自动排除。
do $$
declare
  ext_schema text;
begin
  select extnamespace::regnamespace::text into ext_schema
    from pg_extension where extname = 'vector';
  if ext_schema is null then
    raise notice 'vector 扩展不存在，跳过 match_user_works（我的模式历史作品检索将降级为空）';
    return;
  end if;

  execute format($f$
    create or replace function public.match_user_works(
      query_embedding %1$I.vector,
      match_count     integer,
      p_user_id       uuid
    )
    returns table (
      id         text,
      topic      text,
      sample_text text,
      similarity double precision
    )
    language sql
    stable
    security invoker
    set search_path = %2$L
    as $body$
      select
        h.id,
        h.topic,
        h.sample_text,
        1 - (h.embedding operator(%1$I.<=>) query_embedding) as similarity
      from public.generation_history h
      where h.user_id = p_user_id
        and h.embedding is not null
        and coalesce(btrim(h.sample_text), '') <> ''
      order by h.embedding operator(%1$I.<=>) query_embedding
      limit least(match_count, 50);
    $body$;
  $f$, ext_schema, 'public, ' || ext_schema);

  raise notice 'match_user_works 重建完成';
end $$;

grant execute on function public.match_user_works(public.vector, integer, uuid) to authenticated;

-- 新增列后 UPDATE 权限此前已授予（generation_history 有 SELECT/INSERT/UPDATE），无需重复 grant

-- ───── 9.3 generation_feedback 扩展：记录优化方向选择 ─────
-- direction：用户选择的下一步动作（viral 爆款优化 / style 风格强化 / emotion 情绪增强 /
--            depth 深度升级 / shortvideo 短视频改编 / script 脚本转换 等）
alter table public.generation_feedback add column if not exists direction text;

-- ───── 9.4 style_profiles 扩展：可读化风格维度分 ─────
-- 与 style_vector(1024维检索向量) 互补：这是面向 prompt 注入的人类可读维度
-- 结构示例：{"emotion":0.8,"philosophy":0.9,"humor":0.3,"storytelling":0.8,"suspense":0.7}
-- 值域 0~1，由用户的修改/删除/选版/选方向行为持续更新（阶段 5 实现）
alter table public.style_profiles add column if not exists style_dimensions jsonb not null default '{}'::jsonb;

-- ───── 9.5 style_profiles 扩展：个人创作者模型 Creator Model ─────
-- 与自动统计的风格卡互补：这里存「用户可声明 + AI 可归纳」的创作者人格。
-- 声明类字段（personality/偏好/喜欢/排斥）由用户在风格页编辑，AI 不擅自覆盖；
-- ai_creator_summary 由 LLM 基于风格统计+五维画像+近作手动刷新生成；
-- model_meta 记录总结的生成时间与依据样本数，用于透明化展示与限流判断。
alter table public.style_profiles add column if not exists creator_personality text;        -- 创作人格名，如「冷峻的都市观察者」
alter table public.style_profiles add column if not exists topic_preferences   text[] not null default '{}'; -- 偏好题材
alter table public.style_profiles add column if not exists favorite_elements   text[] not null default '{}'; -- 喜欢元素（真实细节/反转/金句…）
alter table public.style_profiles add column if not exists avoid_elements      text[] not null default '{}'; -- 排斥元素（说教/烂尾…），生成时作为硬禁忌
alter table public.style_profiles add column if not exists ai_creator_summary   text;        -- AI 对「这个创作者是谁」的 1-2 段总结
alter table public.style_profiles add column if not exists model_meta           jsonb not null default '{}'::jsonb; -- {summaryUpdatedAt, workSampleCount, signalCount}

-- ───── 9.6 style_profiles 扩展：版本化创作 DNA 报告 Creator Report ─────
-- 一次「AI 重新理解我」的完整结构化产物，随用户创作成长（每次手动刷新整体替换，version 递增）。
-- 与 9.5 散列的分工：
--   · creator_report = AI 报告（主/副人格、母题/叙事/语言 DNA、证据、置信度），一个版本化文档；
--   · 9.5 的 creator_personality/topic/favorite/avoid 仍是用户手动声明的权威数据，AI 不覆盖；
--   · ai_creator_summary 同步写报告 description，供旧读者/旧版本回退。
-- 权重口径：formDna/openingDna/languageDna.measured 为服务端确定性计数；
--   motifDna/narrativeDna 由 AI 给标签但必须引用真实作品 topic，权重按服务端校验后的引用篇数重算。
-- 结构示例：
-- {"version":2,"updatedAt":"...","sampleCount":12,"sources":{"works":10,"materials":8,"signals":6},
--  "confidence":0.72,
--  "personality":{"main":"冷峻解构者","sub":"情绪观察者","description":"..."},
--  "formDna":[{"label":"故事文案","weight":0.67,"count":8}],
--  "motifDna":[{"label":"人性","weight":0.67,"evidence":["作品topic原文…"],"count":8}],
--  "narrativeDna":[{"label":"人物心理切入","weight":0.5,"evidence":["…"],"count":6}],
--  "openingDna":[{"label":"叙事式","weight":0.6,"count":6}],
--  "languageDna":{"measured":[{"label":"犀利","count":5}],"aiLabels":["冷静","克制","高密度"],"pace":"快节奏","avgLength":820},
--  "bounds":{"favorite":["人物心理","隐藏线索"],"avoid":["说教","空洞鸡汤"]}}
alter table public.style_profiles add column if not exists creator_report jsonb not null default '{}'::jsonb;

-- ──────────────── 10. 社交平台表 ────────────────

-- ───── 10.1 posts：社区动态 ─────
create table if not exists public.posts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  content        text not null,
  content_type   text not null default 'text' check (content_type in ('text', 'image')),
  category       text not null default '灵感',
  tags           text[] not null default '{}',
  style_vector   vector(1024),
  like_count     integer not null default 0,
  comment_count  integer not null default 0,
  save_count     integer not null default 0,
  is_public      boolean not null default true,
  created_at     timestamptz not null default now()
);

-- 补齐可能缺失的列（已存在则跳过）
alter table public.posts add column if not exists content_type   text default 'text' check (content_type in ('text', 'image'));
alter table public.posts add column if not exists category       text default '灵感';
alter table public.posts add column if not exists tags           text[] default '{}';
alter table public.posts add column if not exists style_vector  vector(1024);
alter table public.posts add column if not exists like_count    integer default 0;
alter table public.posts add column if not exists comment_count integer default 0;
alter table public.posts add column if not exists save_count    integer default 0;
alter table public.posts add column if not exists is_public     boolean default true;
alter table public.posts add column if not exists image_url     text;
-- 创作档案分享（作品详情页 → 灵感广场）：
-- post_type=moment 为普通灵感（旧数据全部默认 moment）；archive 为完整创作档案
-- archive 为发布时的只读快照（项目后续迭代不影响已发布档案）；source_project_id 仅作溯源
alter table public.posts add column if not exists post_type         text not null default 'moment';
alter table public.posts add column if not exists archive           jsonb;
alter table public.posts add column if not exists source_project_id uuid;

do $$
begin
  alter table public.posts
    add constraint posts_post_type_check check (post_type in ('moment', 'archive'));
exception
  when duplicate_object then null;
end $$;

create index if not exists posts_user_created_idx
  on public.posts (user_id, created_at desc);
create index if not exists posts_public_created_idx
  on public.posts (created_at desc) where is_public = true;

do $$
begin
  create index if not exists posts_style_hnsw_idx
    on public.posts using hnsw (style_vector public.vector_cosine_ops);
exception
  when others then
    raise notice 'posts HNSW 索引创建失败（%），不影响功能', sqlerrm;
end $$;

alter table public.posts enable row level security;

-- posts 策略：读所有公开帖 + 自己的私密帖；只能改/删自己的帖
drop policy if exists "posts_select_public_or_own" on public.posts;
create policy "posts_select_public_or_own" on public.posts
  for select to authenticated
  using (is_public = true or auth.uid() = user_id);

drop policy if exists "posts_insert_own" on public.posts;
create policy "posts_insert_own" on public.posts
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "posts_update_own" on public.posts;
create policy "posts_update_own" on public.posts
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "posts_delete_own" on public.posts;
create policy "posts_delete_own" on public.posts
  for delete to authenticated
  using (auth.uid() = user_id);

-- ───── 10.2 post_interactions：点赞/收藏/风格共鸣 ─────
create table if not exists public.post_interactions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  post_id          uuid not null references public.posts(id) on delete cascade,
  interaction_type text not null check (interaction_type in ('like', 'save', 'style_resonate')),
  created_at       timestamptz not null default now(),
  unique (user_id, post_id, interaction_type) -- 同一用户对同一帖同一类型只记一次
);

create index if not exists post_interactions_user_idx
  on public.post_interactions (user_id, interaction_type);
create index if not exists post_interactions_post_idx
  on public.post_interactions (post_id, interaction_type);

alter table public.post_interactions enable row level security;

-- post_interactions 策略：读所有交互（社交展示需要），但只能创建/删除自己的
drop policy if exists "pi_select_all" on public.post_interactions;
create policy "pi_select_all" on public.post_interactions
  for select to authenticated
  using (true);

drop policy if exists "pi_insert_own" on public.post_interactions;
create policy "pi_insert_own" on public.post_interactions
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "pi_delete_own" on public.post_interactions;
create policy "pi_delete_own" on public.post_interactions
  for delete to authenticated
  using (auth.uid() = user_id);

-- ───── 10.3 comments：评论 ─────
create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.posts(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  content     text not null,
  created_at  timestamptz not null default now()
);

create index if not exists comments_post_idx
  on public.comments (post_id, created_at desc);

alter table public.comments enable row level security;

-- comments 策略：读所有评论，只能创建/删除自己的
drop policy if exists "comments_select_all" on public.comments;
create policy "comments_select_all" on public.comments
  for select to authenticated
  using (true);

drop policy if exists "comments_insert_own" on public.comments;
create policy "comments_insert_own" on public.comments
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "comments_delete_own" on public.comments;
create policy "comments_delete_own" on public.comments
  for delete to authenticated
  using (auth.uid() = user_id);

-- ───── 10.4 follows：关注关系 ─────
create table if not exists public.follows (
  id           uuid primary key default gen_random_uuid(),
  follower_id  uuid not null references auth.users(id) on delete cascade,
  following_id uuid not null references auth.users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  unique (follower_id, following_id), -- 不重复关注
  check (follower_id <> following_id) -- 不能关注自己
);

create index if not exists follows_follower_idx
  on public.follows (follower_id);
create index if not exists follows_following_idx
  on public.follows (following_id);

alter table public.follows enable row level security;

-- follows 策略：读所有关注关系（社交展示需要），只能创建/删除自己发起的
drop policy if exists "follows_select_all" on public.follows;
create policy "follows_select_all" on public.follows
  for select to authenticated
  using (true);

drop policy if exists "follows_insert_own" on public.follows;
create policy "follows_insert_own" on public.follows
  for insert to authenticated
  with check (auth.uid() = follower_id);

drop policy if exists "follows_delete_own" on public.follows;
create policy "follows_delete_own" on public.follows
  for delete to authenticated
  using (auth.uid() = follower_id);

-- ───── 10.5 user_style_matches：用户风格相似度缓存 ─────
create table if not exists public.user_style_matches (
  id          uuid primary key default gen_random_uuid(),
  user_id_1   uuid not null references auth.users(id) on delete cascade,
  user_id_2   uuid not null references auth.users(id) on delete cascade,
  similarity  real not null,
  updated_at  timestamptz not null default now(),
  check (similarity >= 0 and similarity <= 1),
  unique (user_id_1, user_id_2)
);

create index if not exists style_matches_user1_idx
  on public.user_style_matches (user_id_1, similarity desc);
create index if not exists style_matches_user2_idx
  on public.user_style_matches (user_id_2, similarity desc);

alter table public.user_style_matches enable row level security;

-- user_style_matches 策略：用户只读与自己相关的记录，写入由服务端（service_role）操作
drop policy if exists "style_matches_select_related" on public.user_style_matches;
create policy "style_matches_select_related" on public.user_style_matches
  for select to authenticated
  using (auth.uid() = user_id_1 or auth.uid() = user_id_2);

-- ───── 10.6 授权：RLS 策略只过滤行，不授予权限 ─────
grant select, insert, update, delete on public.posts to authenticated;
grant select, insert, delete on public.post_interactions to authenticated;
grant select, insert, delete on public.comments to authenticated;
grant select, insert, delete on public.follows to authenticated;
grant select on public.user_style_matches to authenticated;

-- ──────────────── 11. 灵感广场 RPC：带作者信息的帖子列表 ────────────────
-- 客户端无法直接查 auth.users（RLS 限制），用 SECURITY DEFINER 函数在数据库内 join。
-- 返回公开帖 + 作者邮箱前缀（隐私保护，不暴露完整邮箱）。
-- SECURITY DEFINER：以函数创建者（postgres）身份执行，可访问 auth.users。

-- 改返回类型必须先 DROP（create or replace 不支持改返回列）
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
    -- 作者名：取邮箱 @ 前部分（隐私保护，不暴露完整邮箱）
    split_part(coalesce(u.email, ''), '@', 1) as author_name,
    -- 当前用户是否已点赞
    exists (
      select 1 from public.post_interactions pi
      where pi.post_id = p.id
        and pi.user_id = auth.uid()
        and pi.interaction_type = 'like'
    ) as current_user_liked,
    -- 当前用户是否已收藏
    exists (
      select 1 from public.post_interactions pi
      where pi.post_id = p.id
        and pi.user_id = auth.uid()
        and pi.interaction_type = 'save'
    ) as current_user_saved,
    p.image_url
  from public.posts p
  left join auth.users u on u.id = p.user_id
  where p.is_public = true
  order by p.created_at desc
  limit least(p_limit, 100)
  offset p_offset;
$$;

-- 授权：登录用户可调用此函数
grant execute on function public.get_posts_with_authors(integer, integer) to authenticated;

-- ──────────────── 11a-2. 基于风格相似度的推荐 RPC ────────────────
-- 按用户 style_vector 与帖子 style_vector 的余弦距离排序（<=> 操作符）
-- 相似度越高（距离越小）的帖子排在越前面
-- 如果用户无 style_vector（参数为 null），则降级为按 created_at 倒序
-- 排除用户自己的帖子（避免看到自己的内容）
-- SECURITY DEFINER：可访问 auth.users

-- 改返回类型必须先 DROP（create or replace 不支持改返回列）
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
    split_part(coalesce(u.email, ''), '@', 1) as author_name,
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
    -- 相似度 = 1 - 余弦距离（<=> 返回 0~2，0=完全相同）
    -- 无用户向量时 similarity 为 null
    case when p_user_vector is not null and p.style_vector is not null
      then 1 - (p.style_vector <=> p_user_vector)
      else null
    end as similarity
  from public.posts p
  left join auth.users u on u.id = p.user_id
  where p.is_public = true
  order by
    -- 有用户向量时按相似度降序（距离升序），无向量时按时间倒序
    case when p_user_vector is not null and p.style_vector is not null
      then p.style_vector <=> p_user_vector
      else null
    end asc nulls last,
    p.created_at desc
  limit least(p_limit, 100)
  offset p_offset;
$$;

grant execute on function public.get_recommended_posts(vector, integer, integer) to authenticated;

-- ──────────────── 11a-bis. 单条帖子详情（含创作档案字段）────────────────
-- 供 /post/[id] 使用；仅返回公开帖，作者名取邮箱前缀，附带当前用户点赞/收藏态
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
    split_part(coalesce(u.email, ''), '@', 1) as author_name,
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

-- ──────────────── 11b. 帖子计数原子操作函数 ────────────────
-- 原子递增/递减：避免并发 UPDATE 覆盖导致计数不一致
-- 递减时使用 GREATEST(x - 1, 0) 防止负数
-- 使用动态 SQL（EXECUTE）因为列名不能参数化

create or replace function public.increment_post_count(
  p_post_id uuid,
  p_column text
)
returns void
language plpgsql
security invoker
set search_path = 'public'
as $$
begin
  -- 列名白名单校验：只允许 like_count / save_count / comment_count
  if p_column not in ('like_count', 'save_count', 'comment_count') then
    raise exception '无效的计数列名: %', p_column;
  end if;
  execute format(
    'update public.posts set %I = %I + 1 where id = $1',
    p_column, p_column
  ) using p_post_id;
end;
$$;

create or replace function public.decrement_post_count(
  p_post_id uuid,
  p_column text
)
returns void
language plpgsql
security invoker
set search_path = 'public'
as $$
begin
  if p_column not in ('like_count', 'save_count', 'comment_count') then
    raise exception '无效的计数列名: %', p_column;
  end if;
  execute format(
    'update public.posts set %I = greatest(%I - 1, 0) where id = $1',
    p_column, p_column
  ) using p_post_id;
end;
$$;

grant execute on function public.increment_post_count(uuid, text) to authenticated;
grant execute on function public.decrement_post_count(uuid, text) to authenticated;

-- ──────────────── 11c. 评论列表 RPC：带作者信息 ────────────────
-- 与 get_posts_with_authors 类似，用 SECURITY DEFINER join auth.users

create or replace function public.get_post_comments(
  p_post_id uuid
)
returns table (
  id uuid,
  post_id uuid,
  user_id uuid,
  content text,
  created_at timestamptz,
  author_name text
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
    split_part(coalesce(u.email, ''), '@', 1) as author_name
  from public.comments c
  left join auth.users u on u.id = c.user_id
  where c.post_id = p_post_id
  order by c.created_at asc;
$$;

grant execute on function public.get_post_comments(uuid) to authenticated;

-- ──────────────── 11d. 个人主页数据 RPC ────────────────
-- 获取指定用户的创作者人格摘要 + 语言特征 + 公开帖子 + 关注状态
-- SECURITY DEFINER：可访问 auth.users 获取昵称/邮箱前缀
-- creator_report（9.6）列不存在时自动降级旧字段，主页不因迁移顺序中断

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

  -- 目标用户昵称（user_metadata.display_name，设置页可编辑）与邮箱前缀兜底
  select split_part(coalesce(email, ''), '@', 1),
         coalesce(nullif(trim(coalesce(raw_user_meta_data->>'display_name', '')), ''), '')
  into v_email, v_display_name
  from auth.users where id = p_target_user_id;

  -- 风格卡 + 创作者人格摘要：
  -- creator_report（9.6）列存在才查，否则降级为旧字段——主页不因迁移顺序中断
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'style_profiles'
      and column_name = 'creator_report'
  ) then
    select tone_tags, pace_preference, common_opening, avg_length, source, creator_report
    into v_profile
    from public.style_profiles where user_id = p_target_user_id;

    -- 对外只展示人格摘要：主/副人格、描述、置信度、证据最多的前三组 DNA 标签
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

  -- 获取公开帖子
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

  -- 是否已关注
  select exists (
    select 1 from public.follows f
    where f.follower_id = v_current_user and f.following_id = p_target_user_id
  ) into v_is_following;

  -- 粉丝数
  select count(*) into v_follower_count
  from public.follows where following_id = p_target_user_id;

  -- 关注数
  select count(*) into v_following_count
  from public.follows where follower_id = p_target_user_id;

  -- 帖子数
  select count(*) into v_post_count
  from public.posts where user_id = p_target_user_id and is_public = true;

  return jsonb_build_object(
    'success', true,
    'userId', p_target_user_id,
    'authorName', coalesce(nullif(v_display_name, ''), v_email),
    'isOwn', v_current_user = p_target_user_id,
    'isFollowing', v_is_following,
    'followerCount', v_follower_count,
    'followingCount', v_following_count,
    'postCount', v_post_count,
    'styleProfile', case when v_profile is not null then
      jsonb_build_object(
        'tone_tags', v_profile.tone_tags,
        'pace_preference', v_profile.pace_preference,
        'common_opening', v_profile.common_opening,
        'avg_length', v_profile.avg_length,
        'source', v_profile.source,
        'creator', v_creator
      )
    else null end,
    'posts', v_posts
  );
end;
$$;

grant execute on function public.get_user_profile(uuid) to authenticated;

-- ──────────────── 11e. 用户角色库 user_characters（阶段四：把我写进故事） ────────────────
-- 可跨作品复用的"故事角色"资产（与"创作身份"identityTemplates 是两回事：
-- 身份=AI 用什么口吻写；角色=内容里登场的人物）。
-- role 约定：protagonist=主线视角 / supporting=适度出现 / narrator=第一人称叙述
-- is_self=true 表示"我"本人进入故事（AI 草稿仅参考，永不覆盖用户确认的设定）
create table if not exists public.user_characters (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null check (char_length(trim(name)) between 1 and 30),
  background  text not null default '',                -- 身份背景（职业/经历/年龄），≤200 字
  personality text not null default '',                -- 性格特质与说话方式，≤200 字
  role        text not null default 'supporting',      -- protagonist / supporting / narrator
  is_self     boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.user_characters enable row level security;

drop policy if exists "user_characters_select_own" on public.user_characters;
create policy "user_characters_select_own" on public.user_characters
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "user_characters_insert_own" on public.user_characters;
create policy "user_characters_insert_own" on public.user_characters
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "user_characters_update_own" on public.user_characters;
create policy "user_characters_update_own" on public.user_characters
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "user_characters_delete_own" on public.user_characters;
create policy "user_characters_delete_own" on public.user_characters
  for delete to authenticated using (auth.uid() = user_id);

grant select, insert, update, delete on public.user_characters to authenticated;

-- ──────────────── 12. 自检查询（执行完脚本后，逐条手动运行确认） ────────────────
-- a) 表结构：
--    select column_name, data_type from information_schema.columns
--     where table_schema='public' and table_name='scripts' order by ordinal_position;
-- b) 策略（应恰好 3 条）：
--    select policyname, cmd from pg_policies
--     where schemaname='public' and tablename='scripts';
-- c) 函数（应恰好 1 个，proconfig 应含 search_path）：
--    select proname, prosecdef, proconfig from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname='public' and proname='match_scripts';
-- d) 反馈事务函数（应恰好 1 行）：
--    select proname from pg_proc
--     where pronamespace='public'::regnamespace and proname='submit_feedback';
-- e) 表授权（generation_history 应有 SELECT/INSERT/UPDATE，generation_feedback 应有 SELECT/INSERT）：
--    select table_name, grantee, privilege_type from information_schema.role_table_grants
--     where table_schema='public'
--       and table_name in ('generation_history','generation_feedback')
--       and grantee = 'authenticated';
-- f) 社交表授权（posts 全权，interactions/comments 全权，follows 全权，user_style_matches 只读）：
--    select table_name, privilege_type from information_schema.role_table_grants
--     where table_schema='public'
--       and table_name in ('posts','post_interactions','comments','follows','user_style_matches')
--       and grantee = 'authenticated';
-- g) 社交表策略（posts 5 条，post_interactions 3 条，comments 3 条，follows 3 条，user_style_matches 1 条）：
--    select tablename, policyname, cmd from pg_policies
--     where schemaname='public'
--       and tablename in ('posts','post_interactions','comments','follows','user_style_matches')
--     order by tablename, cmd;
-- h) 灵感广场 RPC 函数（应恰好 1 行）：
--    select proname from pg_proc
--     where pronamespace='public'::regnamespace and proname='get_posts_with_authors';

-- ═════════════════════════════════════════════════════════════════
-- 10. 作品智能体（Work Agent）—— 作品持续进化系统
-- ═════════════════════════════════════════════════════════════════
-- 设计原则：扩展现有表，不新建独立 work_agents 表
--   - generation_feedback 扩 2 列：free_text（自由反馈原文）+ analysis_result（AI 分析结果）
--   - generation_history 扩 1 列：user_feedback（该版本基于哪条用户反馈生成，版本级溯源）
-- 旧数据兼容：新列全部 nullable，老行无值不影响现有功能

-- ───── 10.1 generation_feedback 扩展：自由文本反馈 + AI 分析 ─────
-- free_text：用户自由输入的反馈原文（如"开头不够吸引人""不够震撼"）
--   与 feedback_type 互补：like/dislike/edit/regenerate 是枚举动作，free_text 是自然语言说明
-- analysis_result：Feedback Analyzer 的结构化输出（jsonb）
--   结构：{intent_type, modification_targets[], optimization_blueprint, analyzed_at}
--   intent_type 指向 6 类优化方向之一（hit/style/emotion/depth/video/script/custom）
--   modification_targets：AI 从反馈中提取的具体修改点（如["开头冲突","情绪曲线"]）
--   optimization_blueprint：可直接注入下一版生成的优化蓝图片段
alter table public.generation_feedback add column if not exists free_text text;
alter table public.generation_feedback add column if not exists analysis_result jsonb;

-- 10.1.1 放宽 feedback_type CHECK：free_text 自由反馈使用 'optimize' 类型
-- （/api/creative/analyze-feedback 落库）。老库建表时 CHECK 只含 4 种枚举，
-- 'optimize' 插入会被静默拒绝（代码只 console.error），反馈历史查询永远为空。
-- 幂等：先删同名约束再重建，重复执行安全。
alter table public.generation_feedback drop constraint if exists generation_feedback_feedback_type_check;
alter table public.generation_feedback add constraint generation_feedback_feedback_type_check
  check (feedback_type in ('like','dislike','edit','regenerate','optimize'));

-- 10.3 AI 协作修改系统：段落级补丁与编辑偏好记忆
-- edit_patches：该版本由哪些段落级补丁融合而来（ModificationPatch[]，null=全文生成）
-- editing_profile：从修改行为聚合的用户编辑偏好（EditingProfileState，镜像 style_dimensions 模式）
alter table public.generation_history add column if not exists edit_patches jsonb;
alter table public.style_profiles add column if not exists editing_profile jsonb;

-- ───── 10.2 generation_history 扩展：版本级用户反馈溯源 ─────
-- user_feedback：该版本生成时所依据的用户反馈原文（V1 为 null，V2+ 承接上一版的反馈）
-- 与 improve_note 互补：improve_note 是 AI 说"我改了什么"，user_feedback 是用户说"我想改什么"
alter table public.generation_history add column if not exists user_feedback text;

-- 验证查询（执行后应返回 3 列非空）：
--   select column_name from information_schema.columns
--    where table_name='generation_feedback' and column_name in ('free_text','analysis_result')
--    order by column_name;
--   select column_name from information_schema.columns
--    where table_name='generation_history' and column_name='user_feedback';

-- ═════════════════════════════════════════════════════════════════
-- 11. Creator Understanding Engine —— 创作者理解引擎
-- ═════════════════════════════════════════════════════════════════
-- 设计原则：1 个 jsonb 列承载访谈声明，与 creator_report（AI 被动推断）互补
--   - creator_declaration = 用户主动声明（权威边界，AI 不覆盖）
--   - creator_report       = AI 从作品+素材学习（被动推断）
-- 两者都注入 prompt，但 declaration 优先级更高（用户说的 > AI 推断的）
-- 旧数据兼容：新列默认 '{}'，未访谈用户的 declaration 为空对象

-- ───── 11.1 style_profiles 扩展：用户主动声明（访谈结果） ─────
-- 6 类访谈维度的用户原始回答 + 访谈元数据
-- 结构：{creator_goal, expression_profile, thinking_profile,
--        narrative_preference, emotional_preference, quality_standard,
--        avoid_preference, creation_scenario, interviewedAt, interviewVersion}
alter table public.style_profiles
  add column if not exists creator_declaration jsonb not null default '{}'::jsonb;

-- 验证查询：
--   select column_name from information_schema.columns
--    where table_name='style_profiles' and column_name='creator_declaration';


-- ═════════════════════════════════════════════════════════════════
-- 12. Creator Knowledge Base（创作者知识库）
-- ═════════════════════════════════════════════════════════════════
-- scripts 表扩 knowledge jsonb 列：AI 理解素材后的结构化数据
-- 与 content（原始文本）并列；老素材 knowledge=null 兼容
-- 设计与 creator_declaration 同模式（1 个 jsonb 承载多维结构）
--
-- knowledge 字段结构见 lib/creative/knowledgeItem.ts: KnowledgeItem
--   meaning          text   AI 理解该素材的意义
--   context          text   使用场景
--   content_type     text   AI 判断素材用途
--   content_tags     text[] 内容标签（电影/科技/商业/...）
--   thought_tags     text[] 思想标签（人性/成长/自由/...）
--   emotion_tags     text[] 情绪标签（恐惧/震撼/悲伤/...）
--   expression_tags  text[] 表达方式标签（故事化/观点分析/...）
--   usage_tags       text[] 创作用途标签（开头钩子/案例素材/...）
--   audience_tags    text[] 受众标签（创业者/年轻用户/...）
--   confidence       float  AI 判断置信度 0-1（< 0.6 不参与检索）
--   analyzed_at      text   AI 分析时间 ISO
--   clarification_asked bool 是否问过用户补充问题
-- ─────────────────────────────────────────────────────────────────

-- 12.1 scripts 表加 knowledge jsonb 列（nullable，老素材兼容）
alter table public.scripts
  add column if not exists knowledge jsonb;

-- 12.2 match_scripts RPC 扩展：加 p_usage_filter 可选参数
--   当 p_usage_filter 非空时，只召回 knowledge->usage_tags 包含该值的素材
--   当 p_usage_filter 为空时，行为与原版一致（纯向量检索）
--   老素材 knowledge=null 不受影响（p_usage_filter 非空时自动跳过）
create or replace function public.match_scripts(
  query_embedding vector(1024),
  match_count int default 5,
  p_user_id uuid default null,
  p_usage_filter text default null
) returns table (
  id uuid,
  content text,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    s.id,
    s.content,
    1 - (s.embedding <=> query_embedding) as similarity
  from public.scripts s
  where s.user_id = p_user_id
    and s.embedding is not null
    -- usage_filter 非空时：只召回 knowledge 含该 usage 的素材（老素材 knowledge=null 自动跳过）
    and (
      p_usage_filter is null
      or (
        s.knowledge is not null
        and (s.knowledge -> 'usage_tags')::jsonb ? p_usage_filter
      )
    )
  order by s.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- 12.3 验证查询：
--   select column_name from information_schema.columns
--    where table_name='scripts' and column_name='knowledge';

