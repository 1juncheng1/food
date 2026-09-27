-- ============================================================
-- 0022_backup_service_role_grants.sql
-- 为 service_role 补齐全表读写授权（备份 / 恢复的前置条件）
--
-- 背景：一次真实备份演练暴露了这个洞——
--   scripts/backup-db.mjs 用 service_role 逐表导出，13 张表直接报
--   42501 "permission denied for table xxx"，备份静默缺失了核心业务数据。
--   （generation_history、comments、follows、user_balances 全在其中。）
--
-- 根因：RLS 与 GRANT 是两套独立的权限机制。
--   service_role 确实**绕过 RLS**，但 PostgreSQL 的**表级权限（GRANT）
--   依然生效**。此前各迁移只 GRANT 了 authenticated，service_role
--   从未被显式授权，于是它对这些表既不能读也不能写。
--   "service_role 什么都能干"是个危险的误解——它只是不受 RLS 约束而已。
--
-- 影响面（都是服务端可信通道，不给前端）：
--   · 备份脚本：需要 SELECT
--   · 恢复脚本：需要 INSERT / UPDATE（merge 模式）
--   · replace 模式恢复：需要 DELETE
--
-- 为什么不只给 SELECT：恢复是备份的另一半。只给读权限的备份体系，
--   等于造了一把打不开的钥匙。
-- ============================================================

-- 与 scripts/backup-db.mjs 的 TABLES 列表保持一一对应。
-- ⚠ 新增表时两边都要同步，否则该表既备份不到也恢复不了。
do $$
declare
  t text;
  tables text[] := array[
    'scripts',
    'generation_history',
    'generation_feedback',
    'style_profiles',
    'creative_projects',
    'posts',
    'post_interactions',
    'comments',
    'follows',
    'user_style_matches',
    'user_characters',
    'user_balances',
    'point_config',
    'point_ledger',
    'payment_settings',
    'recharge_orders',
    'admin_users',
    'ci_items',
    'ci_search_log',
    'creator_events',
    'interest_builds',
    'interest_clusters',
    'interest_suggestions',
    'creator_knowledge',
    'creator_knowledge_links',
    'material_groups',
    'material_usages',
    'work_agent_sessions',
    'work_agent_messages'
  ];
begin
  foreach t in array tables loop
    -- 表可能尚未创建（迁移未全部执行），跳过以免整份迁移失败
    if to_regclass('public.' || t) is not null then
      execute format('grant select, insert, update, delete on public.%I to service_role', t);
    else
      raise notice '跳过 %：表不存在', t;
    end if;
  end loop;
end $$;

-- ── 验证查询（应全部返回 service_role 且有对应权限）──────────
--   select table_name, privilege_type
--     from information_schema.role_table_grants
--    where grantee = 'service_role'
--      and table_schema = 'public'
--    order by table_name, privilege_type;

-- ── 备份演练（授权生效后应全部 ✓，不再出现 42501）────────────
--   npm run backup:rest
