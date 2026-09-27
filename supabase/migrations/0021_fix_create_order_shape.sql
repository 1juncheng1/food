-- ============================================================
-- 0021_fix_create_order_shape.sql
-- 修 create_recharge_order 的返回形状（订单创建一直失败的真正原因）
--
-- 症状：/recharge 点「生成充值订单」永远报「创建订单失败，请稍后重试」，
--       但查 recharge_orders 表**订单其实已经插进去了**。
--
-- 根因：0013 里的该函数返回的是手工挑的 5 个字段，且改成了 camelCase：
--         { id, orderNo, requestedAmount, status, createdAt }
--       而 lib/recharge.ts 的 normalizeOrder() 按 snake_case 读（它与
--       PostgREST 查表返回的形状一致），并且要求 user_id 必填：
--         order_no 读不到 + user_id 根本没返回 → 返回 null
--       → createRechargeOrder 把 null 当成失败，吐出那句兜底文案。
--       订单建成功了却告诉用户失败，比直接报错更糟。
--
-- 改法：直接返回 to_jsonb(v_row) —— 完整行、snake_case。
--       这样形状与「查表读出来的行」永远一致，以后再加列也自动带上，
--       不会再出现"表里有了、代码里认不出"的脱节。
--
-- 幂等：create or replace，重复执行安全。
-- ============================================================

create or replace function public.create_recharge_order(
  p_amount numeric,
  p_note   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_uid    uuid := auth.uid();
  v_min    numeric;
  v_max    numeric;
  v_amount numeric;
  v_row    public.recharge_orders;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'unauthenticated');
  end if;

  v_amount := coalesce(p_amount, 0);
  v_min := public.point_config_num('MIN_RECHARGE_AMOUNT', 5);
  v_max := public.point_config_num('MAX_RECHARGE_AMOUNT', 5000);

  if v_amount <= 0 then
    return jsonb_build_object('ok', false, 'code', 'bad_amount');
  end if;
  if v_amount < v_min then
    return jsonb_build_object('ok', false, 'code', 'below_min', 'min', v_min);
  end if;
  if v_amount > v_max then
    return jsonb_build_object('ok', false, 'code', 'above_max', 'max', v_max);
  end if;

  insert into public.recharge_orders (order_no, user_id, requested_amount, user_note, status)
  values (
    'RC' || to_char(now(), 'YYMMDD') || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8)),
    v_uid,
    round(v_amount, 2),
    nullif(trim(coalesce(p_note, '')), ''),
    'PENDING'
  )
  returning * into v_row;

  -- 返回完整行（snake_case）。不要在这里手工挑字段、更不要改成 camelCase：
  -- 那正是本次 bug 的来源。
  return jsonb_build_object('ok', true, 'order', to_jsonb(v_row));
end;
$$;

comment on function public.create_recharge_order(numeric, text) is
  '创建充值订单：金额下限/上限由 point_config 控制，订单初始状态 PENDING；返回完整订单行（snake_case）';

grant execute on function public.create_recharge_order(numeric, text) to authenticated;


-- ─── 验证（在 SQL Editor 里跑，注意这里是以 postgres 身份跑，auth.uid() 为 null，
--      所以只能验证「函数存在且返回 unauthenticated」，不能验证真的建单） ───
--   select public.create_recharge_order(10);
--   -- 期望：{"ok": false, "code": "unauthenticated"}
--   -- 若报 "function does not exist" → 0013 没跑，先跑 0013 再跑本文件
--
-- 真正建单的验证走页面：/recharge 选档位 → 生成订单 → 应立刻出现订单号与收款码。
-- 建完后查一下确实落库了：
--   select order_no, requested_amount, status, created_at
--     from public.recharge_orders order by created_at desc limit 5;
