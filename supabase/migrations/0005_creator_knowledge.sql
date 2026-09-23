-- ============================================================
-- 0005_creator_knowledge.sql
-- Creator Knowledge System：跨素材聚合后的「知识单元」
--
-- 与 Phase 0/1 的分工：
--   - scripts.knowledge            = 单条素材的 AI 理解（6 维标签 + claims）
--   - creator_knowledge            = 跨多条素材归纳出的知识单元（本篇新增）
-- 知识单元由 claims 跨素材聚合而来，而不是由标签统计而来。
--
-- ⚠ 复用优先原则（显式写在这里，避免后续又新造一层）：
--   1. 素材原文不复制进本表 —— source_item_ids 弱引用 scripts(id)，
--      与 ci_items.excerpt 的版权红线一致
--   2. 不新建「人物 / 项目 / 流派」实体表 —— 这些概念已存在于
--      interest_clusters、interest_profile.topics、scripts.related_topics，
--      domain_scope 直接复用同一套受控词表，靠 join/引用而非复制
--   3. kind 复用 claims 的受控四值（事实/数据/观点/经历），不另设枚举
--   4. 不为知识单元再建一套向量检索 —— 检索先按 domain_scope/topics 收敛候选，
--      再由 Phase 3 的相关性仲裁做 LLM 判断，避免"人类有知识库、AI 有另一套 ESA"
--
-- 为什么仍需要一张表而不是塞进 style_profiles 的 jsonb：
--   每条单元有自己的生命周期（候选→已确认/已拒绝/已过期）、独立时间戳与置信度，
--   且需要逐条被用户确认。jsonb 整块读写会让并发写入互相覆盖。
-- ============================================================

create table if not exists public.creator_knowledge (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null,

  -- 聚合键：同一「概念」的稳定标识。
  -- 措辞不同但指同一件事时靠它收敛，避免同一个意思因说法差异分裂成多条单元。
  concept        text not null,

  -- 知识本体：可被引用的完整命题（写成句子，不是标签）
  claim          text not null,

  -- 主张种类：复用 claims 的受控四值
  kind           text not null default '观点'
                 check (kind in ('事实', '数据', '观点', '经历')),

  -- 适用选题范围：Phase 3 相关性判断的第一道闸。
  -- 值域复用 scripts.related_topics 的受控词表，不另立一套。
  domain_scope   text[] not null default '{}',

  confidence     numeric not null default 0.5
                 check (confidence >= 0 and confidence <= 1),

  -- 候选 → 已确认 / 已拒绝 / 已过期。
  -- 默认候选：AI 的归纳未经用户确认前，不进入 Prompt 注入。
  status         text not null default '候选'
                 check (status in ('候选', '已确认', '已拒绝', '已过期')),

  -- 来源素材：弱引用 scripts(id)，不复制原文
  source_item_ids uuid[] not null default '{}',
  source_count   integer not null default 0,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  confirmed_at   timestamptz
);

alter table public.creator_knowledge enable row level security;

-- 清理旧策略后重建规范四条（与 material_groups 一致）
do $$
declare r record;
begin
  for r in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'creator_knowledge'
  loop
    execute format('drop policy if exists %I on public.creator_knowledge', r.policyname);
  end loop;
end $$;

create policy creator_knowledge_select_own on public.creator_knowledge
  for select to authenticated using (auth.uid() = user_id);

create policy creator_knowledge_insert_own on public.creator_knowledge
  for insert to authenticated with check (auth.uid() = user_id);

create policy creator_knowledge_update_own on public.creator_knowledge
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy creator_knowledge_delete_own on public.creator_knowledge
  for delete to authenticated using (auth.uid() = user_id);

-- 同一用户对同一「概念 + 种类」只保留一条，聚合时走 upsert 而不是重复插入
create unique index if not exists creator_knowledge_user_concept_uniq
  on public.creator_knowledge (user_id, concept, kind);

-- 列表查询：按用户 + 状态 + 时间倒序
create index if not exists creator_knowledge_user_status_idx
  on public.creator_knowledge (user_id, status, updated_at desc);

-- 候选召回：按适用选题范围做数组重叠查询（&&）
create index if not exists creator_knowledge_domain_gin
  on public.creator_knowledge using gin (domain_scope);

comment on column public.creator_knowledge.domain_scope is
  '适用选题范围（受控词表，与 scripts.related_topics 同源）；Phase 3 先用 && 重叠粗筛候选，再交给 LLM 做相关性仲裁';
comment on column public.creator_knowledge.source_item_ids is
  '来源素材 scripts.id 弱引用，不存原文 —— 保持可追溯且不复制用户资产';

-- ── 验证查询（执行后应全部成功）────────────────────────────
--   select tablename from pg_tables where tablename = 'creator_knowledge';
--   select policyname, cmd from pg_policies where tablename = 'creator_knowledge';
--   select indexname from pg_indexes where tablename = 'creator_knowledge';
