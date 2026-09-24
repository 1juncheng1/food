-- ============================================================
-- 0016_work_publish_event.sql
-- 让「发布」进入创作者事实流（creator_events）
--
-- 为什么需要这个事件：
--   发布此前只体现在 posts.source_project_id 上，从未进入 creator_events。
--   后果是「发布意愿」只能靠反查 posts 得知，而反查踩到两个坑：
--     1. service key 对 posts 缺少 GRANT 权限，后台统计会静默得到 0 行
--        （看起来像"没人发布过"）；
--     2. 项目被删后 source_project_id 变成孤儿引用，发布证据丢失——
--        实测就有用户明明发布过，却被算成从未发布。
--   入流后发布成为一等信号：兴趣画像能看到用户愿意公开什么，
--   发布意愿指标也不必再依赖反查。
--
-- 为什么权重高于 work_finalize(3.0)：
--   定稿 = 「我认可这个作品」；发布 = 「我愿意让世界看到它」。
--   后者是更强的创作意图表达，故取 4.0。
--
-- ⚠️ 不执行本迁移的后果：
--   插入 work_publish 会被数据库 CHECK 拒绝，而 trackEvent 的铁律是
--   永不抛异常、只 console.error —— 事件静默丢失、业务照常跑，
--   要等画像长期不准才会被发现。（已加 eventRegistry.test.ts 兜底防漂移。）
-- ============================================================

alter table public.creator_events drop constraint if exists creator_events_event_type_check;
alter table public.creator_events add constraint creator_events_event_type_check check (
  event_type in (
    'work_generate','work_finalize','work_unfinalize','work_delete','work_publish',
    'feedback_like','feedback_dislike','work_edit','work_regenerate',
    'material_save','material_delete',
    'post_like','post_unlike','post_save','post_unsave','post_style_resonate',
    'inspiration_analyze','topic_search',
    'recommend_impression','recommend_click','recommend_adopt','recommend_dismiss'
  )
);
