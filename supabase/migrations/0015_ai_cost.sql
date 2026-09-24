-- ============================================================
-- 0015_ai_cost.sql
-- AI 消费计费：退款 RPC + 扩展能力档位
--
-- 为什么需要「退款」这个动作：
--   Phase 4 把 AI 计费改成两阶段——调用前按能力预扣（AI_PRECHARGE_*），
--   调用后按真实 token 结算。真实消耗通常**低于**预扣额度，
--   差额必须退回去，否则"预扣"就变成了偷偷涨价。
--   LLM 调用失败时更要全额退：没生成出东西却扣了积分，是最伤信任的事故。
--
-- 退款走独立的 REFUND 流水而不是把 AI_CONSUMPTION 改小，
--   是为了让流水如实反映"发生过什么"：预扣 10、结算 4、退 6，
--   三步各自留痕。事后对账时一眼能看出这台机器收了多少、退了多少。
-- ============================================================

-- ─── 1. 扩展能力档位（0012 已种 GENERATION/BLUEPRINT/DIAGNOSIS/CHAT）──
-- 分析与知识归纳是后续接入计费的链路，先把档位备好，
-- 免得接入时又要改代码里的兜底常量。
insert into public.point_config (key, value) values
  ('AI_PRECHARGE_ANALYSIS', 5),
  ('AI_PRECHARGE_KNOWLEDGE', 3)
on conflict (key) do nothing;

-- ─── 2. 退款 RPC ──────────────────────────────────────────────
-- 只允许 service_role：退款和加积分是同一类动作，
-- 绝不能出现在用户可触达的路径上（否则就是自助充值）。
create or replace function public.refund_points(
  p_user_id      uuid,
  p_amount       bigint,
  p_reference_id text default null,
  p_description  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_before numeric;
  v_after  numeric;
  v_amount bigint := greatest(coalesce(p_amount, 0), 0);
begin
  if not public.is_service_caller() then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;

  if v_amount <= 0 then
    -- 退 0 也算成功：调用方不必为"无需退款"写分支
    return jsonb_build_object('ok', true, 'duplicated', false, 'refunded', 0);
  end if;

  insert into public.user_balances (user_id, balance)
  values (p_user_id, 0)
  on conflict (user_id) do nothing;

  select balance into v_before
  from public.user_balances
  where user_id = p_user_id
  for update;

  v_before := coalesce(v_before, 0);
  v_after := v_before + v_amount;

  -- 幂等：同一业务号只退一次（唯一索引兜底，撞上就是已退过）
  insert into public.point_ledger
    (user_id, type, amount, balance_before, balance_after, source, reference_id, description, created_by)
  values
    (p_user_id, 'REFUND', v_amount, v_before, v_after, 'ai', p_reference_id,
     coalesce(nullif(trim(coalesce(p_description, '')), ''), 'AI 预扣结算退款'), p_user_id)
  on conflict (user_id, type, reference_id) where reference_id is not null do nothing;

  if not found then
    return jsonb_build_object('ok', true, 'duplicated', true, 'refunded', 0, 'balance', v_before);
  end if;

  update public.user_balances
    set balance = v_after, updated_at = now()
    where user_id = p_user_id;

  return jsonb_build_object(
    'ok', true, 'duplicated', false,
    'refunded', v_amount, 'balance', v_after
  );
end;
$$;

comment on function public.refund_points(uuid, bigint, text, text) is
  'AI 预扣差额退还 / 调用失败全额退：写 REFUND 流水，同一业务号只退一次';

grant execute on function public.refund_points(uuid, bigint, text, text) to service_role;

-- ─── 3. 验证查询 ──────────────────────────────────────────────
--   select public.refund_points('<user_id>', 6, 'gen123:refund', 'AI 结算差额退还');
--   select type, amount, balance_before, balance_after, reference_id
--     from public.point_ledger where user_id = '<user_id>'
--     order by created_at desc limit 20;
