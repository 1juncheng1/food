-- Material Library 2.0 — Phase 1 一次性数据迁移脚本
-- ============================================================
-- 用途：把 scripts 表中有 knowledge 的老素材，回填 ai_summary / related_topics / material_type 新列
-- 性质：一次性迁移（WHERE ai_summary IS NULL 守护防重复），不属于 setup.sql 幂等整理脚本
--
-- 执行顺序：
--   1. 先跑第 0 段 dry-run 预览影响行数
--   2. 执行第 1-3 段迁移
--   3. 再跑第 0 段对比前后行数
--   4. 跑第 3 段命中率统计，若"其他" > 50% 需在 Phase 2 前补映射规则
--   5. 第 4 段输出 legacy 素材数（knowledge IS NULL 的，本阶段不处理）
-- ============================================================


-- ═════════════════════════════════════════════════════════════════
-- 第 0 段：dry-run 预览（必跑，确认影响行数）
-- ═════════════════════════════════════════════════════════════════

-- 0.1 素材总览：有 knowledge / 无 knowledge / 待迁移
select
  count(*) as total,
  count(*) filter (where knowledge is not null) as has_knowledge,
  count(*) filter (where knowledge is null) as legacy,
  count(*) filter (where knowledge is not null and ai_summary is null) as pending_migration
from public.scripts;

-- 0.2 RPC 现状（确认 match_scripts 签名）
-- select proname, proargnames from pg_proc where proname='match_scripts';


-- ═════════════════════════════════════════════════════════════════
-- 第 1 段：迁移 ai_summary + related_topics（幂等，WHERE ai_summary IS NULL 守护）
-- ═════════════════════════════════════════════════════════════════
-- ai_summary = knowledge.meaning + '\n\n' + knowledge.context
-- related_topics = knowledge.content_tags 数组展开
--
-- 风险缓解：
--   - WHERE knowledge IS NOT NULL AND ai_summary IS NULL 守护防重复
--   - WHERE jsonb_typeof(knowledge->'content_tags') = 'array' 防止非数组报错
--   - knowledge->>'context' 若为 null，CONCAT 自动跳过（不影响 ai_summary）

update public.scripts
set
  ai_summary = concat_ws(
    e'\n\n',
    knowledge->>'meaning',
    knowledge->>'context'
  ),
  related_topics = (
    select array_agg(elem::text)
    from jsonb_array_elements_text(knowledge->'content_tags') as elem
    where jsonb_typeof(knowledge->'content_tags') = 'array'
  ),
  updated_at = now()
where knowledge is not null
  and ai_summary is null
  and jsonb_typeof(knowledge->'content_tags') = 'array';

-- 1.1 补充迁移：content_tags 不是数组但 meaning 有值的素材（related_topics 留空，ai_summary 仍迁移）
update public.scripts
set
  ai_summary = concat_ws(
    e'\n\n',
    knowledge->>'meaning',
    knowledge->>'context'
  ),
  updated_at = now()
where knowledge is not null
  and ai_summary is null
  and knowledge->>'meaning' is not null;

-- 1.2 验证：迁移后 ai_summary 非空数
select
  count(*) as total,
  count(*) filter (where ai_summary is not null) as has_summary,
  count(*) filter (where related_topics is not null) as has_topics
from public.scripts;


-- ═════════════════════════════════════════════════════════════════
-- 第 2 段：material_type 映射（CASE WHEN，幂等，WHERE material_type IS NULL 守护）
-- ═════════════════════════════════════════════════════════════════
-- 映射规则：从 knowledge.content_type（LLM 自由文本）映射到 9 种枚举
-- 映射不上归"其他"
--
-- 注意：knowledge.content_type 是 LLM 自由文本（如"观点分析"/"事实陈述"/"数据引用"），
--        CASE WHEN 用 LIKE 模糊匹配，命中率可能不高，见第 3 段统计

update public.scripts
set
  material_type = case
    when knowledge->>'content_type' ilike '%观点%' then '观点'
    when knowledge->>'content_type' ilike '%事实%' then '事实'
    when knowledge->>'content_type' ilike '%数据%' then '数据'
    when knowledge->>'content_type' ilike '%案例%' then '案例'
    when knowledge->>'content_type' ilike '%金句%' or knowledge->>'content_type' ilike '%名言%' then '金句'
    when knowledge->>'content_type' ilike '%经历%' or knowledge->>'content_type' ilike '%个人%' then '经历'
    when knowledge->>'content_type' ilike '%观察%' then '观察'
    when knowledge->>'content_type' ilike '%灵感%' then '灵感'
    else '其他'
  end,
  updated_at = now()
where knowledge is not null
  and material_type is null
  and knowledge->>'content_type' is not null;


-- ═════════════════════════════════════════════════════════════════
-- 第 3 段：material_type 映射命中率统计（必跑，决定是否补映射规则）
-- ═════════════════════════════════════════════════════════════════
-- 若"其他"占比 > 50%，需在 Phase 2 前补映射规则或重新设计 CASE

select
  material_type,
  count(*) as cnt,
  round(count(*) * 100.0 / sum(count(*)) over (), 2) as pct
from public.scripts
where knowledge is not null
group by material_type
order by cnt desc;

-- 3.1 看看"其他"都是什么 content_type（若占比高，参考这里补规则）
select
  knowledge->>'content_type' as raw_content_type,
  count(*) as cnt
from public.scripts
where knowledge is not null
  and material_type = '其他'
group by knowledge->>'content_type'
order by cnt desc
limit 20;


-- ═════════════════════════════════════════════════════════════════
-- 第 4 段：legacy 素材标记（knowledge IS NULL 的老素材，本阶段不处理）
-- ═════════════════════════════════════════════════════════════════
-- 这些素材 Phase 1 不处理：
--   - material_type IS NULL（match_scripts 的 p_material_type 非空时会被跳过）
--   - ai_summary IS NULL（检索时无摘要可读）
--   - 原文 content 完整保存（用户内容资产不丢失）
--
-- 留给用户确认后单独执行 AI 重分析（涉及 LLM 调用成本）：
--   对每条 legacy 素材调用 /api/creative/analyze-knowledge 重分析并回填 knowledge + 新 7 列

select
  count(*) as legacy_count,
  count(*) filter (where content is not null) as has_content,  -- 原文完整保存
  count(*) filter (where embedding is not null) as has_embedding  -- 向量仍可检索
from public.scripts
where knowledge is null;

-- 4.1 legacy 素材列表（用户确认后可手动 AI 重分析）
-- select id, left(content, 50) as content_preview, created_at
-- from public.scripts
-- where knowledge is null
-- order by created_at;
