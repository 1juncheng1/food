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

-- 读取权限：media 是公开桶（公开 URL 可直接访问，存量图片的 URL 不受影响），
-- 但 storage.objects 的 select 策略同时还授权了「列举/下载」API：
-- 原来的 `to public` 让任何匿名用户都能 list 出全站用户上传的图片（隐私面太大）。
-- 这里收敛为「登录用户只能列举/下载自己文件夹下的对象」，公开 URL 读取不受影响。
drop policy if exists "media_public_read" on storage.objects;
drop policy if exists "media_read_own" on storage.objects;
create policy "media_read_own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- 更新 / 删除权限：原先只有 insert + select，导致 API 里的 .remove()
-- （删除旧头像/旧封面）在用户 token 下被 RLS 静默拒绝 → 孤儿文件堆积。
drop policy if exists "media_update_own" on storage.objects;
create policy "media_update_own" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "media_delete_own" on storage.objects;
create policy "media_delete_own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

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
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

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
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

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
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

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
-- pgvector 所在 schema 由 pg_extension 运行时探测（Supabase 通常是 extensions，
-- 自建库可能装在 public），因此这里与文件顶部一致走动态 format，
-- 避免硬编码 extensions 导致脚本在该 schema 不存在的环境里整体中断。
do $$
declare
  ext_schema text;
begin
  select n.nspname into ext_schema
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'vector';

  if ext_schema is null then
    raise exception '未检测到 pgvector 扩展，请先在 Database -> Extensions 中启用 vector';
  end if;

  execute format($f$
    create or replace function public.match_scripts(
      query_embedding %1$I.vector,
      match_count int default 5,
      p_user_id uuid default null,
      p_usage_filter text default null
    ) returns table (
      id uuid,
      content text,
      similarity float
    )
    language plpgsql
    stable
    security invoker
    -- 固定 search_path 并把向量操作符写成全限定形式（见文件顶部说明）
    set search_path = public, %1$I
    as $body$
    begin
      return query
      select
        s.id,
        s.content,
        1 - (s.embedding operator(%1$I.<=>) query_embedding) as similarity
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
      order by s.embedding operator(%1$I.<=>) query_embedding
      limit match_count;
    end;
    $body$;
  $f$, ext_schema);

  raise notice 'match_scripts (p_usage_filter 重载) 重建完成';
end $$;

-- 12.3 验证查询：
--   select column_name from information_schema.columns
--    where table_name='scripts' and column_name='knowledge';

-- ═════════════════════════════════════════════════════════════════
-- 13. AI 灵感分析与转化系统（AI Inspiration Analysis）
-- ═════════════════════════════════════════════════════════════════
-- 设计原则：复用 generation_history 表，一次 generation_id 串起
--   灵感输入 → AI 分析 → 用户选择方向 → plan → 生成作品 → 作品反馈
--   溯源链完整，未来灵感推荐算法只需 select 该列聚类，无需跨表 join
--
-- inspiration_context jsonb 结构（见 lib/creative/inspirationAnalyzer.ts: InspirationAnalysis）：
--   raw_input             text      用户原始灵感输入（≤2000 字）
--   input_type            text      LLM 自动判断：title/sentence/news/material/random_thought/video_summary/other
--   value_assessment      jsonb     6 维价值评估 + overall_score(1-10) + issues[]
--   optimization_suggestions jsonb  优化建议：main_problem/missing_info[]/missing_viewpoints[]/improvement_direction
--   recalled_material_ids text[]   从 scripts 表向量召回的相关素材 ID（仅登录用户有值）
--   analyzed_at            text     ISO timestamp
--
-- 旧数据兼容：新列 nullable，老作品 inspiration_context=null 不影响现有功能
-- RLS/权限不变：generation_history 已有 SELECT/INSERT/UPDATE，新列自动继承
alter table public.generation_history
  add column if not exists inspiration_context jsonb;

-- 13.1 验证查询：
--   select column_name from information_schema.columns
--    where table_name='generation_history' and column_name='inspiration_context';

-- ============================================================
-- 14. Content Intelligence Data Layer（P0）
-- ============================================================
-- 统一市场数据缓存表：所有平台（web/news，未来 B站/抖音/知乎）的数据
-- 统一进 CIItem 格式落这里，跨用户共享（同主题 24-72h 内免重复搜索+富化）。
--
-- 设计红线（对应 lib/ci/types.ts: CIItem）：
--   1. excerpt ≤300 字（check 约束兜底）——存"理解市场的线索"，永不存全文（版权红线）
--   2. metrics 中 null = 该源拿不到该数据，永不为 0 冒充（web/news 源无互动指标）
--   3. ai_analysis 可整块 null（未富化），重算不污染原始字段
--
-- 权限模型：RLS 启用且不建任何 anon/authenticated 策略 = 仅 service role 可读写。
-- 消费走服务端（/api/creative/market/analyze → lib/ci/*），用户永远不直接查表；
-- query_hash 关联的查询文本可能含用户私有想法，不跨用户暴露。
-- 前置条件：服务端需配置 SUPABASE_SERVICE_ROLE_KEY（未配置时缓存自动降级关闭）。
create table if not exists public.ci_items (
  id uuid primary key default gen_random_uuid(),
  platform text not null,
  external_id text not null,
  url text,
  title text not null,
  excerpt text check (char_length(excerpt) <= 300),
  author text default '',
  published_at timestamptz,
  metrics jsonb default '{}'::jsonb,
  content_info jsonb default '{}'::jsonb,
  ai_analysis jsonb,
  query_hash text not null,
  fetched_at timestamptz default now(),
  expires_at timestamptz not null,
  unique (platform, external_id)
);
create index if not exists idx_ci_items_query on public.ci_items (query_hash, expires_at);

-- 搜索日志（成本监控 + 缓存命中率分析 + 未来主题分布统计）
create table if not exists public.ci_search_log (
  id uuid primary key default gen_random_uuid(),
  query_hash text not null,
  query_text text,
  adapters text[],
  item_count int default 0,
  created_at timestamptz default now()
);

alter table public.ci_items enable row level security;
alter table public.ci_search_log enable row level security;
-- 注意：不建任何 anon/authenticated 策略（service role 不受 RLS 限制）

-- 14.1 验证查询：
--   select tablename, rowsecurity from pg_tables
--    where tablename in ('ci_items','ci_search_log');

-- ============================================================
-- 15. 作品发布表现回流（轻量版：手动三档自评）
-- ============================================================
-- 闭环意义：这是"灵感→分析→战略→作品→市场验证"全链路中缺失的最后一环。
-- 站内 👍/👎（feedback_status）衡量的是"AI 生成质量"，
-- performance_feedback 衡量的是"作品在真实市场的表现"——两者是不同的信号，分列存储。
--
-- 数据形状（jsonb，应用层校验）：
--   {
--     "grade": "good | okay | flop",     -- 三档自评（跨平台可比的最小公共分母）
--     "platform": "wechat|xhs|douyin|bilibili|zhihu|other" | null,
--     "note": "≤200字补充说明" | null,
--     "recorded_at": "ISO 时间戳"        -- 重复记录=覆盖（最新自评为准）
--   }
--
-- 设计取舍（MVP）：
--   - 三档自评而非数字指标：不同平台指标不可比（B站播放 vs 公众号在看），
--     自评档位跨平台可比、录入摩擦最低，且足够支撑"战略模式×表现"关联分析；
--     未来接平台数据回流（CI 数据层）时可并存数字指标字段。
--   - 覆盖而非追加历史：分析消费的是"最新表现"；作品表现随时间演变时用户可重新记录。
--
-- 与 content_strategy 的关联分析（本机制的核心价值，积累 2-4 周后执行）：
--   select coalesce(blueprint->'content_strategy'->>'recommended_mode','none') as mode,
--          performance_feedback->>'grade' as grade,
--          count(*)
--   from generation_history
--   where performance_feedback is not null
--   group by 1, 2 order by 1, 2;
--   → 得到"哪种战略模式的作品表现更好"，反哺战略块 Prompt 与付费价值证明。
alter table public.generation_history add column if not exists performance_feedback jsonb;

-- 15.1 验证查询：
--   select column_name from information_schema.columns
--    where table_name='generation_history' and column_name='performance_feedback';

-- ============================================================
-- 16. Creator Interest Profile（创作者兴趣模型 · M0 地基）
-- ============================================================
-- 设计原则：事件是事实（append-only，不可变），簇/画像/推荐卡是派生品（可从事件全量重建）。
--   creator_events        行为事件账本：幂等写入，只增不改不删；撤回语义用新事件表达
--   interest_builds       画像构建运行记录：算法/规则版本 + 参数快照 + 在途折叠
--   interest_clusters     语义簇：质心 pgvector + 三层归属（core/exploration/temporary）+ 跨期身份
--   interest_suggestions  推荐卡队列：build 预制，推荐接口只读取排序
--   style_profiles.interest_profile  画像视图 jsonb（六层结构，空对象=未建模）
-- 全部 additive + if not exists，不影响任何现有表与功能。

-- ───── 16.0 既有缺失列补齐 ─────
-- work_tags：app/api/creative/work-tags 已在读写 generation_history.work_tags，
-- 但建表脚本遗漏了这一列（写库失败仅 console.error，老库静默丢标签）。
alter table public.generation_history
  add column if not exists work_tags jsonb;

-- ───── 16.1 style_profiles：兴趣画像视图列 ─────
-- 与 creator_report / creator_declaration / editing_profile 并列，互不覆盖；
-- 消费方读空对象时整块剔除，未建模用户零影响。
alter table public.style_profiles
  add column if not exists interest_profile jsonb not null default '{}'::jsonb;

-- ───── 16.2 interest_builds：画像构建运行记录 ─────
create table if not exists public.interest_builds (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  trigger      text not null,                         -- manual/scheduled/incremental/backfill
  algo_version text not null,                        -- 聚类算法版本，如 interest-cluster-v1
  rule_version text not null,                        -- 权重/分层规则版本，如 interest-rules-v1
  params       jsonb not null default '{}'::jsonb,   -- 本次算法参数全量快照
  event_range  jsonb not null default '{}'::jsonb,   -- {from_event_id,to_event_id,count}
  status       text not null default 'running',      -- running/done/failed
  error        text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);

alter table public.interest_builds drop constraint if exists interest_builds_trigger_check;
alter table public.interest_builds add constraint interest_builds_trigger_check
  check (trigger in ('manual','scheduled','incremental','backfill'));

alter table public.interest_builds drop constraint if exists interest_builds_status_check;
alter table public.interest_builds add constraint interest_builds_status_check
  check (status in ('running','done','failed'));

create index if not exists interest_builds_user_idx
  on public.interest_builds (user_id, started_at desc);
-- 在途折叠：同用户只允许扫描一个 running build
create index if not exists interest_builds_running_idx
  on public.interest_builds (user_id) where status = 'running';

-- ───── 16.3 interest_clusters：语义簇 ─────
create table if not exists public.interest_clusters (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  build_id         uuid not null references public.interest_builds(id) on delete cascade,
  cluster_code     text not null,                    -- 跨 build 稳定身份码（如 c_ai_business）
  label            text not null check (char_length(trim(label)) between 1 and 20),
  summary          text not null default '' check (char_length(summary) <= 200),
  centroid         vector(1024) not null,
  layer            text not null,                    -- core/exploration/temporary
  previous_layer   text,
  layer_changed_at timestamptz,
  weight           real not null check (weight >= 0 and weight <= 1),       -- 用户内归一化强度
  raw_score        real not null default 0,          -- 归一化前加权事件分（趋势计算用）
  confidence       real not null check (confidence >= 0 and confidence <= 1),
  event_count      integer not null default 0,
  project_count    integer not null default 0,       -- 去重项目数（防单项目迭代刷票）
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  status           text not null default 'active',   -- active/superseded/archived
  superseded_by    uuid references public.interest_clusters(id) on delete set null,
  stats            jsonb not null default '{}'::jsonb, -- 窗口分/趋势/来源/原因混合/证据
  algo_version     text not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.interest_clusters drop constraint if exists interest_clusters_layer_check;
alter table public.interest_clusters add constraint interest_clusters_layer_check
  check (layer in ('core','exploration','temporary'));

alter table public.interest_clusters drop constraint if exists interest_clusters_status_check;
alter table public.interest_clusters add constraint interest_clusters_status_check
  check (status in ('active','superseded','archived'));

-- 同一稳定码在同一用户下只保留一个活跃簇（历史行 supersede 保留，支持回滚与趋势连续）
create unique index if not exists interest_clusters_active_code_idx
  on public.interest_clusters (user_id, cluster_code) where status = 'active';
create index if not exists interest_clusters_user_layer_idx
  on public.interest_clusters (user_id, layer, weight desc);
create index if not exists interest_clusters_build_idx
  on public.interest_clusters (build_id);

do $$
begin
  create index if not exists interest_clusters_centroid_hnsw_idx
    on public.interest_clusters using hnsw (centroid public.vector_cosine_ops);
exception
  when others then
    raise notice 'interest_clusters HNSW 索引创建失败（%），不影响功能，仅检索稍慢', sqlerrm;
end $$;

-- ───── 16.4 creator_events：创作者行为事件流（append-only） ─────
create table if not exists public.creator_events (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  event_type        text not null,
  target_type       text not null,                   -- generation/project/script/post/inspiration/ci_item/topic
  target_id         text,
  project_id        uuid references public.creative_projects(id) on delete set null,
  category          text,                            -- 形式分类（电影解说…），仅辅助维度
  content_domain    text,                            -- 粗领域（tech/business…），辅助维度
  embedding         vector(1024),
  embedding_model   text not null default 'bge-m3@1024',
  payload           jsonb not null default '{}'::jsonb,
  interpretation    jsonb,                           -- AI 行为原因分析（Behavior Reason）
  interpret_status  text not null default 'none',   -- none/pending/done/failed
  cluster_id        uuid references public.interest_clusters(id) on delete set null,
  occurred_at       timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  idempotency_key   text not null
);

-- 枚举用 CHECK 兜底（应用层枚举为主）；未来扩事件类型时重建此约束即可，
-- 与 generation_feedback.feedback_type 的放宽先例同模式。
alter table public.creator_events drop constraint if exists creator_events_event_type_check;
alter table public.creator_events add constraint creator_events_event_type_check check (
  event_type in (
    'work_generate','work_finalize','work_unfinalize','work_delete',
    'feedback_like','feedback_dislike','work_edit','work_regenerate',
    'material_save','material_delete',
    'post_like','post_unlike','post_save','post_unsave','post_style_resonate',
    'inspiration_analyze','topic_search',
    'recommend_impression','recommend_click','recommend_adopt','recommend_dismiss'
  )
);

alter table public.creator_events drop constraint if exists creator_events_target_type_check;
alter table public.creator_events add constraint creator_events_target_type_check check (
  target_type in ('generation','project','script','post','inspiration','ci_item','topic')
);

alter table public.creator_events drop constraint if exists creator_events_interpret_status_check;
alter table public.creator_events add constraint creator_events_interpret_status_check check (
  interpret_status in ('none','pending','done','failed')
);

-- 幂等：同一用户同一业务动作只入账一次
create unique index if not exists creator_events_idem_idx
  on public.creator_events (user_id, idempotency_key);
create index if not exists creator_events_user_time_idx
  on public.creator_events (user_id, occurred_at desc);
create index if not exists creator_events_user_type_time_idx
  on public.creator_events (user_id, event_type, occurred_at desc);
-- 原因批处理扫描待解释事件
create index if not exists creator_events_pending_idx
  on public.creator_events (user_id) where interpret_status = 'pending';
create index if not exists creator_events_cluster_idx
  on public.creator_events (cluster_id);

do $$
begin
  create index if not exists creator_events_embedding_hnsw_idx
    on public.creator_events using hnsw (embedding public.vector_cosine_ops);
exception
  when others then
    raise notice 'creator_events HNSW 索引创建失败（%），不影响功能，仅聚类稍慢', sqlerrm;
end $$;

-- ───── 16.5 interest_suggestions：推荐卡预制队列 ─────
create table if not exists public.interest_suggestions (
  id              uuid primary key default gen_random_uuid(),  -- 对外即 rec_id
  user_id         uuid not null references auth.users(id) on delete cascade,
  build_id        uuid not null references public.interest_builds(id) on delete cascade,
  cluster_code    text not null,
  slot            text not null,                    -- core_gap/evidence_followup/exploration/continuation
  source          text not null,                    -- own_inspiration/ci_market/saved_material/exploration/active_project
  title           text not null check (char_length(trim(title)) between 1 and 40),
  description     text not null check (char_length(description) <= 120),
  topic           text not null check (char_length(topic) between 1 and 200),
  form_hint       text not null default '其他',
  score           real not null check (score >= 0 and score <= 1),
  score_breakdown jsonb not null default '{}'::jsonb,
  evidence        jsonb not null default '{}'::jsonb,  -- 确定性事实包（推荐解释用，禁止 LLM 自由发挥进这里）
  market_refs     jsonb,                            -- 内部溯源 [{platform,url}]，不返回前端
  status          text not null default 'active',   -- active/impressed/consumed/dismissed/expired/superseded
  expires_at      timestamptz not null default (now() + interval '14 days'),
  created_at      timestamptz not null default now()
);

alter table public.interest_suggestions drop constraint if exists interest_suggestions_slot_check;
alter table public.interest_suggestions add constraint interest_suggestions_slot_check
  check (slot in ('core_gap','evidence_followup','exploration','continuation'));

alter table public.interest_suggestions drop constraint if exists interest_suggestions_source_check;
alter table public.interest_suggestions add constraint interest_suggestions_source_check
  check (source in ('own_inspiration','ci_market','saved_material','exploration','active_project'));

alter table public.interest_suggestions drop constraint if exists interest_suggestions_status_check;
alter table public.interest_suggestions add constraint interest_suggestions_status_check
  check (status in ('active','impressed','consumed','dismissed','expired','superseded'));

create index if not exists interest_suggestions_user_status_idx
  on public.interest_suggestions (user_id, status, score desc);
create index if not exists interest_suggestions_user_cluster_idx
  on public.interest_suggestions (user_id, cluster_code);
create index if not exists interest_suggestions_expires_idx
  on public.interest_suggestions (expires_at);

-- ───── 16.6 ci_items：市场情报条目向量列（build 时 ANN 检索市场缺口） ─────
-- nullable，老数据不重算，下次搜索刷新时自然补上；ci_items 维持 service-role-only，
-- 不建任何 RPC，从结构上保证跨用户私有 query 不泄露。
alter table public.ci_items
  add column if not exists embedding vector(1024);

do $$
begin
  create index if not exists ci_items_embedding_hnsw_idx
    on public.ci_items using hnsw (embedding public.vector_cosine_ops);
exception
  when others then
    raise notice 'ci_items HNSW 索引创建失败（%），不影响功能，仅市场缺口检索不可用', sqlerrm;
end $$;

-- ───── 16.7 RLS 策略（四张新表全部用户私有） ─────
-- creator_events：只增不改不删（撤回语义用新事件表达，保证账本完整）。
-- WF10 例外开口：embedding 列允许本人 UPDATE——画像 build 步骤3 用用户 token 补算
-- 并回写事件向量；列级 GRANT 保证 payload/user_id/type 等账本列依然不可变。
alter table public.creator_events enable row level security;
drop policy if exists "creator_events_select_own" on public.creator_events;
create policy "creator_events_select_own" on public.creator_events
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "creator_events_insert_own" on public.creator_events;
create policy "creator_events_insert_own" on public.creator_events
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "creator_events_update_embedding_own" on public.creator_events;
create policy "creator_events_update_embedding_own" on public.creator_events
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
-- 列级授权兜底：RLS 放行行之后，仅 embedding 一列可写（RLS 本身不限制列）
grant update(embedding) on public.creator_events to authenticated;

-- interest_builds / interest_clusters / interest_suggestions：自己可读可插可改（状态流转/supersede），不可删
alter table public.interest_builds enable row level security;
drop policy if exists "interest_builds_select_own" on public.interest_builds;
create policy "interest_builds_select_own" on public.interest_builds
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "interest_builds_insert_own" on public.interest_builds;
create policy "interest_builds_insert_own" on public.interest_builds
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "interest_builds_update_own" on public.interest_builds;
create policy "interest_builds_update_own" on public.interest_builds
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

alter table public.interest_clusters enable row level security;
drop policy if exists "interest_clusters_select_own" on public.interest_clusters;
create policy "interest_clusters_select_own" on public.interest_clusters
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "interest_clusters_insert_own" on public.interest_clusters;
create policy "interest_clusters_insert_own" on public.interest_clusters
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "interest_clusters_update_own" on public.interest_clusters;
create policy "interest_clusters_update_own" on public.interest_clusters
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

alter table public.interest_suggestions enable row level security;
drop policy if exists "interest_suggestions_select_own" on public.interest_suggestions;
create policy "interest_suggestions_select_own" on public.interest_suggestions
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "interest_suggestions_insert_own" on public.interest_suggestions;
create policy "interest_suggestions_insert_own" on public.interest_suggestions
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "interest_suggestions_update_own" on public.interest_suggestions;
create policy "interest_suggestions_update_own" on public.interest_suggestions
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- generation_history 硬删除：仅本人（RLS 兜底归属）。
-- 业务规则"项目版本行禁止单独删除"在应用层（DELETE /api/creative/works/[id]）强制，
-- 不写进策略条件，避免未来"删除整个项目"功能需要反向改库。
-- generation_feedback 经 FK on delete cascade 由系统内部级联清理，无需额外 DELETE 授权。
drop policy if exists "gen_history_delete_own" on public.generation_history;
create policy "gen_history_delete_own" on public.generation_history
  for delete to authenticated using (auth.uid() = user_id);

-- ───── 16.8 显式授权（RLS 只过滤行，不授予权限） ─────
grant select, insert on public.creator_events to authenticated;
grant select, insert, update on public.interest_builds to authenticated;
grant select, insert, update on public.interest_clusters to authenticated;
grant select, insert, update on public.interest_suggestions to authenticated;
grant delete on public.generation_history to authenticated;
-- style_profiles 的 interest_profile 新列自动继承既有 select/insert/update 授权，无需额外 grant

-- 16.8b service_role 显式授权（实测：本项目的默认权限不含 service_role，
-- 缺失时 getServiceClient/S2 ci_market/运维脚本全部 "permission denied" 静默失败）：
--   ci_items 是 service-role-only 共享缓存表（无 RLS 策略，禁止暴露给 anon/authenticated）
--   creator_events 需 delete 供运维脚本清理合成/噪音事件（账本对用户仍 append-only）
--   其余 interest_* / 作品表运行时全部走用户 token（authenticated 角色），无需 service_role
grant select, insert, update, delete on public.creator_events to service_role;
grant select, insert, update, delete on public.interest_builds to service_role;
grant select, insert, update, delete on public.interest_clusters to service_role;
grant select, insert, update, delete on public.interest_suggestions to service_role;
grant select, insert, update, delete on public.ci_items to service_role;
-- WF0（2026-09-19 实测 42501）：两张旧表漏授 service_role，后台诊断/S2/运维直查全部
-- "permission denied for table ..."。authenticated 主路径走 RLS 不受影响，但 service_role
-- 作为受信角色需要只读（不授写：旧业务表运行时一律走用户 token）。
-- WF9（2026-09-19 实测 42501）：runBuild 的 finishBuild 需 upsert style_profiles（画像写），
-- 后台化 build（场景测试/serverless 定时触发）必须 service_role 可写；不授 DELETE（画像行不删）。
grant select, insert, update on public.style_profiles to service_role;
grant select, insert, update on public.generation_history to service_role;

-- 16.9 验证查询：
--   select table_name from information_schema.tables
--    where table_schema='public'
--      and table_name in ('creator_events','interest_builds','interest_clusters','interest_suggestions');
--   select column_name from information_schema.columns
--    where table_name='generation_history' and column_name='work_tags';
--   select column_name from information_schema.columns
--    where table_name='style_profiles' and column_name='interest_profile';
--   select column_name from information_schema.columns
--    where table_name='ci_items' and column_name='embedding';

-- ───── 16.10 Creation Opportunity Engine 升级（WF0/WF4/WF6，2026-09-19） ─────
-- 整节幂等，可在 Supabase SQL Editor 反复执行；全部为 additive 变更，旧应用代码透明。

-- [WF0] build 并发互斥：同一用户至多一条 status='running' 的 build。
-- 实测一次页面访问曾并发插入 6 个 build（findRunningBuild 幽灵列 + 无 DB 约束）。
-- 应用层 findRunningBuild 为快速路径，本索引为正确性兜底（第二个 insert 收 23505 跳过）。
create unique index if not exists interest_builds_one_running_idx
  on public.interest_builds (user_id)
  where status = 'running';

-- [WF4] 兴趣簇四维标签（内容/思想/情绪/创作方式）+ 标签文本向量（bge-m3@1024）。
-- tag_dims 结构：{content:[...],thought:[...],emotion:[...],craft:[...]}；
-- 与语义质心 centroid 正交共存，tag_embedding 由四维标签拼接文本编码得到。
alter table public.interest_clusters
  add column if not exists tag_dims jsonb not null default '{}'::jsonb,
  add column if not exists tag_embedding vector(1024);

-- [WF6] 推荐卡 AI 理由五件套（build 时预制，请求路径零 LLM 调用）。
-- why_recommend 必须复述 evidence.facts 中的真实事实；related_knowledge 为闭集素材引用。
-- reason_source 标记理由来源：template=事实模板兜底，ai=LLM 预制。
alter table public.interest_suggestions
  add column if not exists core_question text,
  add column if not exists why_recommend text,
  add column if not exists creation_angle text,
  add column if not exists related_knowledge jsonb not null default '[]'::jsonb,
  add column if not exists reason_source text not null default 'template';

-- 16.10 验证查询（执行后应全部成功；has_table_privilege 两行为 t；索引/列可见）：
--   select has_table_privilege('service_role','public.style_profiles','SELECT');
--   select has_table_privilege('service_role','public.generation_history','SELECT');
--   select indexname from pg_indexes where indexname='interest_builds_one_running_idx';
--   select column_name from information_schema.columns
--    where table_name='interest_clusters' and column_name in ('tag_dims','tag_embedding');
--   select column_name from information_schema.columns
--    where table_name='interest_suggestions'
--      and column_name in ('core_question','why_recommend','creation_angle','related_knowledge','reason_source');

-- ═════════════════════════════════════════════════════════════════
-- 17. Material Library 2.0 数据层（素材库升级：Material + MaterialGroup + MaterialUsage）
-- ═════════════════════════════════════════════════════════════════
-- 设计原则（Phase 0 审计确认）：
--   1. 复用 scripts 表不重命名，避免破坏所有现有 API/UI 引用
--   2. 所有 DDL 幂等（if not exists），重复执行零报错
--   3. 不删除 knowledge/category/type/file_url/embedding 任何现有列
--   4. match_scripts 新参数可选，不传时行为不变（向后兼容）
--   5. 新表 RLS 与 scripts 表一致（4 条 own 策略）
--
-- 执行前建议先跑两条预览查询：
--   select count(*) from scripts where knowledge is not null;  -- 待迁移素材数
--   select proname, proargnames from pg_proc where proname='match_scripts';  -- RPC 现状
-- ─────────────────────────────────────────────────────────────────

-- 17.1 scripts 表扩 7 列（全部 add column if not exists，老素材新列默认 NULL 兼容）
--   group_id        未来 references material_groups(id)，本阶段不加外键约束避免循环依赖
--   material_type   9 种枚举（观点/事实/数据/案例/金句/经历/观察/灵感/其他），用 text 不用 enum
--                   不加 CHECK 约束：避免 Supabase enum 迁移麻烦，靠应用层校验
--   source          素材来源（手输/上传/外部链接/AI生成）
--   ai_summary      从 knowledge.meaning+context 拆出的 AI 理解摘要（冗余存储便于检索）
--   related_topics  从 knowledge.content_tags 拆出的相关主题（数组）
--   claims          素材中包含的事实/数据/主张（jsonb，结构 Phase 3 Retrieval Service 定义）
--   updated_at      编辑时间戳，默认 now()
alter table public.scripts
  add column if not exists group_id uuid,
  add column if not exists material_type text,
  add column if not exists source text,
  add column if not exists ai_summary text,
  add column if not exists related_topics text[],
  add column if not exists claims jsonb,
  add column if not exists updated_at timestamptz not null default now();

-- 17.2 补 scripts_update_own RLS 策略（现有只有 select/insert/delete，缺 update）
--     Phase 2 素材编辑功能依赖此策略
drop policy if exists scripts_update_own on public.scripts;
create policy scripts_update_own on public.scripts
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 17.3 新建 material_groups 表（用户自由建立分组：AI观察/商业/电影/创业/职场/我的观点...）
--     分组是用户管理方式，不是 AI 唯一检索依据
create table if not exists public.material_groups (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  name        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.material_groups enable row level security;

-- 清理旧策略后重建规范四条（与 scripts 表一致）
do $$
declare r record;
begin
  for r in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'material_groups'
  loop
    execute format('drop policy if exists %I on public.material_groups', r.policyname);
  end loop;
end $$;

create policy material_groups_select_own on public.material_groups
  for select to authenticated using (auth.uid() = user_id);

create policy material_groups_insert_own on public.material_groups
  for insert to authenticated with check (auth.uid() = user_id);

create policy material_groups_update_own on public.material_groups
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy material_groups_delete_own on public.material_groups
  for delete to authenticated using (auth.uid() = user_id);

-- 唯一约束：同用户下分组名唯一（防止重名）
create unique index if not exists material_groups_user_name_uniq
  on public.material_groups (user_id, name);

-- 列表查询索引（按用户+时间倒序）
create index if not exists material_groups_user_created_idx
  on public.material_groups (user_id, created_at desc);

-- 17.4 新建 material_usages 表（素材使用记录：推荐→选择→拒绝→使用四态）
--     为 Phase 5 推荐系统训练提供闭环数据
--     work_id 用 text 而非 uuid：因为 generation_history.id 是 text（前端生成 UUID 字符串）
create table if not exists public.material_usages (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null,
  material_id     uuid not null references public.scripts(id) on delete cascade,
  work_id         text references public.generation_history(id) on delete set null,
  suggested_by_ai boolean not null default false,
  selected_by_user boolean not null default false,
  actually_used   boolean not null default false,
  created_at      timestamptz not null default now()
);

alter table public.material_usages enable row level security;

-- 清理旧策略后重建规范四条
do $$
declare r record;
begin
  for r in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'material_usages'
  loop
    execute format('drop policy if exists %I on public.material_usages', r.policyname);
  end loop;
end $$;

create policy material_usages_select_own on public.material_usages
  for select to authenticated using (auth.uid() = user_id);

create policy material_usages_insert_own on public.material_usages
  for insert to authenticated with check (auth.uid() = user_id);

create policy material_usages_update_own on public.material_usages
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy material_usages_delete_own on public.material_usages
  for delete to authenticated using (auth.uid() = user_id);

-- 3 索引：按用户查使用记录 / 按素材查被使用情况 / 按作品查使用了哪些素材
create index if not exists material_usages_user_created_idx
  on public.material_usages (user_id, created_at desc);
create index if not exists material_usages_material_idx
  on public.material_usages (material_id);
create index if not exists material_usages_work_idx
  on public.material_usages (work_id);

-- 唯一约束（usageWriter UPSERT 的冲突目标）
--   局部唯一：work_id IS NOT NULL 时 (user_id, material_id, work_id) 唯一
--   work_id IS NULL 时（推荐但未关联作品）允许多行（每次推荐一行），
--   但 usageWriter 的 upsert 只在 work_id 非空时才调，work_id=null 时直接 INSERT
create unique index if not exists material_usages_user_material_work_uniq
  on public.material_usages (user_id, material_id, work_id)
  where work_id is not null;

-- 17.5 match_scripts RPC 扩展 p_material_type 参数
--   ⚠️ 风险：PostgreSQL CREATE OR REPLACE FUNCTION 不能改参数签名，必须 DROP + CREATE
--   ⚠️ 生产中断：DROP 时若 prompt-optimizer 正在调用 match_scripts，会有毫秒级 500 错误
--   建议：选生产低峰期执行本节；或在 DROP 前先 set lock_timeout='5s' 防止卡死
--
--   新参数 p_material_type：当非空时，只召回 material_type 匹配的素材
--   当 p_material_type 为空时，行为与原版一致（向后兼容，prompt-optimizer 无需改动）
--   老素材 material_type IS NULL 不受影响（p_material_type 非空时自动跳过）
drop function if exists public.match_scripts(vector, int, uuid, text) cascade;

-- 同上：动态探测 pgvector 所在 schema，不硬编码 extensions
do $$
declare
  ext_schema text;
begin
  select n.nspname into ext_schema
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'vector';

  if ext_schema is null then
    raise exception '未检测到 pgvector 扩展，请先在 Database -> Extensions 中启用 vector';
  end if;

  execute format($f$
    create function public.match_scripts(
      query_embedding %1$I.vector,
      match_count int default 5,
      p_user_id uuid default null,
      p_usage_filter text default null,
      p_material_type text default null
    ) returns table (
      id uuid,
      content text,
      similarity float
    )
    language plpgsql
    stable
    security invoker
    -- 固定 search_path 并把向量操作符写成全限定形式（见文件顶部说明）
    set search_path = public, %1$I
    as $body$
    begin
      return query
      select
        s.id,
        s.content,
        1 - (s.embedding operator(%1$I.<=>) query_embedding) as similarity
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
        -- material_type 非空时：只召回 material_type 匹配的素材（老素材 material_type=null 自动跳过）
        and (
          p_material_type is null
          or s.material_type = p_material_type
        )
      order by s.embedding operator(%1$I.<=>) query_embedding
      limit match_count;
    end;
    $body$;
  $f$, ext_schema);

  raise notice 'match_scripts (p_material_type 重载) 重建完成';
end $$;

-- ──────────────── 17.6 Phase 1 GRANT 授权（必须，否则 RLS 表也会 42501） ────────────────
-- 注意：Postgres GRANT 与 RLS 是两层独立机制，RLS 存在不代表表级权限已授。

-- scripts 表：UPDATE 权限此前靠 RLS（scripts_update_own 策略），但表级 GRANT 仍需显式声明删除
grant delete on public.scripts to authenticated;
grant select, insert, update, delete on public.scripts to service_role;

-- material_groups：CRUD 全套（authenticated 靠 RLS 限定 user_id）
grant select, insert, update, delete on public.material_groups to authenticated;
grant select, insert, update, delete on public.material_groups to service_role;

-- material_usages：SELECT/INSERT/UPDATE（authenticated 只能读/写自己的 usage，service_role 写 suggested_by_ai）
grant select, insert, update on public.material_usages to authenticated;
grant select, insert, update, delete on public.material_usages to service_role;

-- match_scripts RPC：authenticated 和 service_role 都需要 execute
grant execute on function public.match_scripts(public.vector, integer, uuid, text, text) to authenticated;
grant execute on function public.match_scripts(public.vector, integer, uuid, text, text) to service_role;

-- 17.7 验证查询（执行后应全部成功）
--   select column_name, data_type from information_schema.columns
--    where table_name='scripts' and column_name in
--      ('group_id','material_type','source','ai_summary','related_topics','claims','updated_at');
--   select policyname, cmd from pg_policies where tablename='scripts' and cmd='UPDATE';
--   select tablename from pg_tables where tablename in ('material_groups','material_usages');
--   select indexname from pg_indexes where tablename in ('material_groups','material_usages');
--   select proargnames from pg_proc where proname='match_scripts';

-- ═════════════════════════════════════════════════════════════════
-- 18. Work Agent（作品智能协作体）—— 对话式共创系统
-- ═════════════════════════════════════════════════════════════════
-- 目标：把「继续优化」从「一句反馈 → AI 全文重写」升级为
--       「加载上下文 → 多轮对话 → 意图澄清 → 方案选择 → 局部修改 → 落新版本」。
--
-- 设计原则：
--   1. 仍然不新建 work_agents 表：版本真相唯一来源仍是 creative_projects + generation_history
--   2. session / message 分离：session 存本次共创的状态指针，message 存完整对话轨迹
--      （区别：generation_feedback 只存「一次动作」，messages 存「一次决策过程」）
--   3. 全 additive + nullable：未执行本节的库无影响，其余功能零中断
--   4. RLS 用户私有：会话与消息均按 user_id 隔离，service_role 全权（便于运维/排障）
--
-- 与既有表的关系（从三表聚合，不复制）：
--   work_agent_sessions.base_version_id → generation_history.id（对话发起时的基底版本）
--   generation_history.session_id        ← 本次会话产出该版本（溯源）
--   generation_history.revision_plan     ← 用户最终确认的修改方案快照（可直接复盘"为什么改"）

-- ─── 18.1 会话表 ───
create table if not exists public.work_agent_sessions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  project_id       uuid references public.creative_projects(id) on delete cascade,
  -- 发起对话时的基底版本（generation_history.id，形如 `${pid}::vN`）；作品删除后置空，不清会话
  base_version_id  text,
  -- active=进行中 / applied=已落地新版本 / abandoned=用户放弃
  status           text not null default 'active' check (status in ('active','applied','abandoned')),
  -- 三阶段状态机：clarify=意图澄清 / propose=方案选择 / apply=局部修改 / done=完成
  phase            text not null default 'clarify' check (phase in ('clarify','propose','apply','done')),
  -- { chosenIntentId?, chosenPlanId?, turnCount?, lastError? } —— 阶段推进的轻量指针，不存正文
  meta             jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists work_agent_sessions_user_idx
  on public.work_agent_sessions (user_id, updated_at desc);

create index if not exists work_agent_sessions_project_idx
  on public.work_agent_sessions (project_id, created_at desc);

alter table public.work_agent_sessions enable row level security;

drop policy if exists work_agent_sessions_select_own on public.work_agent_sessions;
create policy work_agent_sessions_select_own on public.work_agent_sessions
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists work_agent_sessions_insert_own on public.work_agent_sessions;
create policy work_agent_sessions_insert_own on public.work_agent_sessions
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists work_agent_sessions_update_own on public.work_agent_sessions;
create policy work_agent_sessions_update_own on public.work_agent_sessions
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists work_agent_sessions_delete_own on public.work_agent_sessions;
create policy work_agent_sessions_delete_own on public.work_agent_sessions
  for delete to authenticated using (auth.uid() = user_id);

grant select, insert, update, delete on public.work_agent_sessions to authenticated;
grant select, insert, update, delete on public.work_agent_sessions to service_role;

-- ─── 18.2 消息表（对话轨迹 = 数据飞轮原料）───
-- 与 generation_feedback 的分工：
--   generation_feedback = 一次「动作」（点了个赞、选了某方向）—— 粗粒度反馈账本
--   work_agent_messages = 一次「决策过程」（AI 提了什么、用户选了什么、为什么放弃）—— 细粒度共创轨迹
-- 注意别把它当成另一份 recommend feedback：selected_index 记录"用户在候选中挑了第几个"，
-- 这是最有价值的偏好信号（比最终点赞更能反映真实取舍，区分「认可」与「妥协」）。
create table if not exists public.work_agent_messages (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references public.work_agent_sessions(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  -- user=用户发言 / assistant=AI 回复
  role          text not null check (role in ('user','assistant')),
  -- intent_clarify=意图候选 / proposal=修改方案 / patch_preview=补丁预览
  -- confirm=用户确认结果 / system_notice=降级或错误提示
  kind          text not null default 'intent_clarify'
                check (kind in ('intent_clarify','proposal','patch_preview','confirm','system_notice')),
  content       text not null default '',   -- 面向用户展示的文案
  -- 结构化载荷：intentOptions[] / plans[] / patches[] / analysis
  payload       jsonb,
  -- 用户在候选中选择的序号（null=未选择/自由输入）。数据飞轮核心字段。
  selected_index integer,
  created_at    timestamptz not null default now()
);

create index if not exists work_agent_messages_session_idx
  on public.work_agent_messages (session_id, created_at);

alter table public.work_agent_messages enable row level security;

drop policy if exists work_agent_messages_select_own on public.work_agent_messages;
create policy work_agent_messages_select_own on public.work_agent_messages
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists work_agent_messages_insert_own on public.work_agent_messages;
create policy work_agent_messages_insert_own on public.work_agent_messages
  for insert to authenticated with check (auth.uid() = user_id);

-- 消息一经写入即为历史事实，不提供 update/delete 给客户端（避免对话被篡改后误导 AI）
grant select, insert on public.work_agent_messages to authenticated;
grant select, insert, update, delete on public.work_agent_messages to service_role;

-- ─── 18.3 generation_history 扩展：版本溯源到会话与方案 ───
-- 为什么这两列必须落到版本行：
--   版本的真相是「为什么变成了这样」。没有 session_id 就无法回放决策过程，
--   没有 revision_plan 就只能看到结果（新正文），看不到用户当初选的是哪个方案。
alter table public.generation_history add column if not exists session_id uuid;
alter table public.generation_history add column if not exists revision_plan jsonb;

comment on column public.generation_history.session_id is
  '产出该版本的 Work Agent 会话 id（work_agent_sessions.id），用于回放共创决策过程';
comment on column public.generation_history.revision_plan is
  '用户确认的修改方案快照 RevisionPlan：{title,expectedImpact,modificationArea,risk,preserveItems,strategy}';

create index if not exists generation_history_session_idx
  on public.generation_history (session_id)
  where session_id is not null;

-- ─── 18.4 验证查询（执行后应全部成功）───
--   select tablename from pg_tables
--    where tablename in ('work_agent_sessions','work_agent_messages');
--   select policyname, cmd from pg_policies where tablename like 'work_agent_%';
--   select column_name, data_type from information_schema.columns
--    where table_name='generation_history' and column_name in ('session_id','revision_plan');
--   select column_name from information_schema.columns
--    where table_name='work_agent_messages' and column_name='selected_index';

