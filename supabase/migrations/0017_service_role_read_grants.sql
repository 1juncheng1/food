-- ============================================================
-- 0017_service_role_read_grants.sql
-- 补 service_role 对 posts / creative_projects 的只读授权
--
-- 背景（2026-09-24 实测，见 CURRENT.md §5.3）：
--   用 SUPABASE_SERVICE_ROLE_KEY 直连真实库做后台统计/诊断时，
--   posts 与 creative_projects 均返回 42501 permission denied for table。
--   这是 GRANT 层缺失，**不是 RLS** —— 补 RLS 策略修不好它，
--   实测当时是靠 anon key + RLS 绕过去才拿到数据的。
--
-- 危害的隐蔽性（这才是必须修的理由）：
--   42501 不会抛异常到业务层。PostgREST 返回 403，supabase-js 把它放进
--   error 字段，而统计类代码习惯性 `?? []` 兜底 —— 于是后台脚本
--   安静地得到 0 行，看起来像"没有人发布过作品 / 没有项目"。
--   本次就是这么被坑的：发布率校准差点得出 0% 的结论。
--
-- 为什么只授 SELECT：
--   两张表是用户业务数据，运行时一律走用户 token（authenticated + RLS）。
--   service_role 只需要**读**权限做统计与诊断，不需要写；
--   多授写权限等于给后台脚本开了绕过 RLS 改用户数据的口子。
-- ============================================================

grant select on public.posts to service_role;
grant select on public.creative_projects to service_role;

-- 验证（应在 SQL Editor 返回 posts / creative_projects 各一行，不报错）：
--   select table_name, grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_name in ('posts','creative_projects')
--      and grantee = 'service_role';
--
-- 或用 key 直连验证（都应返回 200，不再是 403/42501）：
--   curl "<SUPABASE_URL>/rest/v1/posts?select=id&limit=1" -H "apikey: <SERVICE_KEY>" -H "Authorization: Bearer <SERVICE_KEY>"
--   curl "<SUPABASE_URL>/rest/v1/creative_projects?select=id&limit=1" -H "apikey: <SERVICE_KEY>" -H "Authorization: Bearer <SERVICE_KEY>"
