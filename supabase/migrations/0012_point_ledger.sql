-- ============================================================
-- 0012_point_ledger.sql
-- 积分账户 + 积分流水：让「每一分积分都可追溯」
--
-- 一句话：此前 user_balances.balance 是**唯一事实**——余额变了就是变了，
--   谁改的、为什么改、改了几次，全都不留痕。这套表现在把余额变成
--   「流水的累积结果」：余额负责快，流水负责真。
--
-- 三张表 / 四个函数的分工：
--   point_config   价格与门槛的唯一出处（改价不碰代码）
--   user_balances  既有表，继续作为余额快照（本迁移只补索引，不改结构）
--   point_ledger   append-only 流水（**唯一索引兜底幂等**）
--
-- 两条不可退让的原则：
--   ① 幂等靠数据库约束，不靠代码先查后写。
--      「先 select 看看有没有、没有再 insert」在并发下必然有窗口；
--      这里用 unique(user_id, type, reference_id) 让第二次插入直接撞约束，
--      撞上就是已处理过，余额一分不动。
--   ② 加积分与写流水必须在**同一个函数内**完成。
--      Supabase JS 客户端没有跨表事务，任何「先 update 余额再 insert 流水」
--      的两趟调用都可能只成功一半（加了分没流水 / 有流水没加分）。
--
-- 记账单位：积分（numeric(14,2)，与既有 user_balances.balance 同族）。
--   积分可以为负变动（消费），但**余额永不为负**（表级 check + 函数内判定）。
--
-- 汇率：POINTS_PER_YUAN = 20（1 元 = 20 积分）。存量赠金不换算。
-- ============================================================

-- ─── 1. 价格与门槛配置（改价只动这张表，不改代码）──────────
create table if not exists public.point_config (
  key        text primary key,
  value      numeric(14, 4) not null,
  updated_at timestamptz   not null default now(),
  updated_by uuid
);

comment on table public.point_config is
  '积分系统配置：汇率/充值下限/赠金额度/AI 预扣门槛；服务端与 SQL 函数同读此表，杜绝两处硬编码漂移';

insert into public.point_config (key, value) values
  ('POINTS_PER_YUAN',        20),   -- 1 元 = 20 积分
  ('MIN_RECHARGE_AMOUNT',     5),   -- 人工审核成本考虑：低于 5 元不受理
  ('REGISTER_BONUS_POINTS',  20),   -- 新用户注册赠送（幂等，一生一次）
  ('MIN_GENERATION_COST',     1),   -- 单次 AI 消费保底积分（防极小用量抹成 0）
  ('AI_PRECHARGE_GENERATION',10),   -- 正文生成：调用前的余额门槛（预扣口径）
  ('AI_PRECHARGE_BLUEPRINT',  5),   -- 创作蓝图
  ('AI_PRECHARGE_DIAGNOSIS',  5),   -- 五维诊断
  ('AI_PRECHARGE_CHAT',       3)    -- Work Agent 单轮对话
on conflict (key) do nothing;

alter table public.point_config enable row level security;

-- 汇率要对用户可见（充值页要算「预计获得多少积分」），所以放开读；
-- 写只给 service_role（改价是管理员动作，绝不能让客户端碰）
drop policy if exists "point_config_select_all" on public.point_config;
create policy "point_config_select_all"
  on public.point_config for select to authenticated using (true);

grant select on public.point_config to authenticated;
grant select, insert, update on public.point_config to service_role;

-- ─── 2. 积分流水（append-only）──────────────────────────────
create table if not exists public.point_ledger (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  type           text not null
                 check (type in ('REGISTER_BONUS','RECHARGE','AI_CONSUMPTION','MANUAL_ADJUSTMENT','REFUND')),
  amount         numeric(14, 2) not null check (amount <> 0),
  balance_before numeric(14, 2) not null,
  balance_after  numeric(14, 2) not null,
  source         text not null default 'system',
  reference_id   text,
  description    text,
  created_by     uuid,
  created_at     timestamptz not null default now()
);

comment on table public.point_ledger is
  '积分流水（append-only）：amount 正=入账 负=扣减；同一 (user_id,type,reference_id) 只能有一条，用于幂等';
comment on column public.point_ledger.reference_id is
  '业务关联号：注册赠送=user_id，充值=订单号，AI消费=作品/请求 id，手动调整=调整单号（必填，否则失去幂等保护）';

-- 幂等的物理保证：第二次重复确认/重复赠送在这里撞墙，而不是靠应用代码自觉
create unique index if not exists point_ledger_idem_uidx
  on public.point_ledger (user_id, type, reference_id)
  where reference_id is not null;

create index if not exists point_ledger_user_time_idx
  on public.point_ledger (user_id, created_at desc);

alter table public.point_ledger enable row level security;

-- 用户可读自己的流水；**不授予任何写策略**——写入只能走 security definer 函数
drop policy if exists "point_ledger_select_own" on public.point_ledger;
create policy "point_ledger_select_own"
  on public.point_ledger for select to authenticated using (auth.uid() = user_id);

grant select on public.point_ledger to authenticated;
grant select, insert on public.point_ledger to service_role;

-- ─── 3. 通用小工具：读配置（带默认值，表没数据也不至于算错账）──
-- STABLE + security definer：只读一张小表，返回标量，函数内联无副作用
create or replace function public.point_config_num(p_key text, p_default numeric)
returns numeric
language sql
stable
security definer
set search_path = 'public'
as $$
  select coalesce(
    (select value from public.point_config where key = p_key),
    p_default
  );
$$;

comment on function public.point_config_num(text, numeric) is
  '读取积分配置；键不存在时返回 p_default（配置表被清空也不至于把账算崩）';

grant execute on function public.point_config_num(text, numeric) to authenticated, service_role;

-- 判定调用者是不是服务端（service_role）；管理员动作以此为闸门
create or replace function public.is_service_caller()
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $$
  select coalesce(auth.jwt() ->> 'role', '') = 'service_role';
$$;

comment on function public.is_service_caller() is
  '调用方是否为 service_role（服务端可信通道）；管理员类写操作据此放行';

grant execute on function public.is_service_caller() to authenticated, service_role;

-- ─── 4. 注册赠送（幂等：一生一次）───────────────────────────
--
-- 幂等键 = (user_id, 'REGISTER_BONUS', user_id::text)。
-- 也就是说：只要这个用户曾经拿到过赠金，流水里就躺着这一行，
-- 之后无论刷新页面、重新登录、还是将来余额被清过，都不会再送第二次。
--
-- 允许谁调用：
--   · 用户本人（p_user_id 省略或 = auth.uid()）——首次看余额时自动开户
--   · service_role（显式传 p_user_id）——注册回调 / 管理员补发
create or replace function public.grant_register_bonus(
  p_user_id uuid default null,
  p_points  numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_uid     uuid;
  v_points  numeric;
  v_before  numeric;
  v_after   numeric;
  v_new     boolean := false;
begin
  v_uid := coalesce(p_user_id, auth.uid());
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'unauthenticated');
  end if;
  -- 替别人赠送必须是服务端可信通道，普通用户只能给自己开户
  if p_user_id is not null and p_user_id <> auth.uid() and not public.is_service_caller() then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;

  v_points := greatest(coalesce(p_points, public.point_config_num('REGISTER_BONUS_POINTS', 20)), 0);

  -- 开户（无则建，余额 0；赠金在下一步按流水加，保证有迹可循）
  insert into public.user_balances (user_id, balance)
  values (v_uid, 0)
  on conflict (user_id) do nothing;

  -- 行锁：并发开户/赠送在这里排队
  select balance into v_before
  from public.user_balances
  where user_id = v_uid
  for update;

  v_before := coalesce(v_before, 0);

  -- 幂等闸门：撞上唯一索引 = 已经送过，直接返回当前余额，一分不多加
  insert into public.point_ledger
    (user_id, type, amount, balance_before, balance_after, source, reference_id, description)
  values
    (v_uid, 'REGISTER_BONUS', v_points, v_before, v_before + v_points,
     'register', v_uid::text, '新用户注册赠送')
  on conflict (user_id, type, reference_id) where reference_id is not null do nothing;

  if found then
    v_new := true;
    v_after := v_before + v_points;
    update public.user_balances
      set balance = v_after, updated_at = now()
      where user_id = v_uid;
  else
    v_after := v_before;
  end if;

  return jsonb_build_object(
    'ok', true,
    'granted', v_new,
    'points', case when v_new then v_points else 0 end,
    'balance', v_after
  );
end;
$$;

comment on function public.grant_register_bonus(uuid, numeric) is
  '注册赠送积分（幂等）：同一用户只会产生一条 REGISTER_BONUS 流水；granted=false 表示此前已赠送';

grant execute on function public.grant_register_bonus(uuid, numeric) to authenticated, service_role;

-- ─── 5. 原子扣积分（含流水）─────────────────────────────────
--
-- 与旧 consume_balance 的差别：**同事务写流水**。
-- 重复以同一 reference_id 扣费（重试/并发）会命中唯一索引，判定为已扣，
-- 直接返回当时的余额，绝不二次扣减。
create or replace function public.consume_points(
  p_amount       numeric,
  p_reference_id text default null,
  p_source       text default 'generation',
  p_description  text default null,
  p_user_id      uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_uid    uuid;
  v_amount numeric;
  v_before numeric;
  v_after  numeric;
  v_dup    numeric;
begin
  v_uid := coalesce(p_user_id, auth.uid());
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'unauthenticated');
  end if;
  if p_user_id is not null and p_user_id <> auth.uid() and not public.is_service_caller() then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;

  v_amount := coalesce(p_amount, 0);
  if v_amount <= 0 then
    return jsonb_build_object('ok', false, 'code', 'bad_amount');
  end if;

  -- 幂等：同一业务号已经扣过 → 视为成功，返回上次结果（重试安全）
  if p_reference_id is not null then
    select balance_after into v_dup
    from public.point_ledger
    where user_id = v_uid and type = 'AI_CONSUMPTION' and reference_id = p_reference_id
    limit 1;
    if found then
      return jsonb_build_object('ok', true, 'duplicated', true, 'balance', v_dup);
    end if;
  end if;

  insert into public.user_balances (user_id, balance)
  values (v_uid, 0)
  on conflict (user_id) do nothing;

  select balance into v_before
  from public.user_balances
  where user_id = v_uid
  for update;

  v_before := coalesce(v_before, 0);

  -- 余额不足：不动账、不写流水（"扣不动"不是一次消费事实）
  if v_before < v_amount then
    return jsonb_build_object(
      'ok', false, 'code', 'insufficient_balance', 'balance', v_before
    );
  end if;

  v_after := v_before - v_amount;

  update public.user_balances
    set balance = v_after, updated_at = now()
    where user_id = v_uid;

  insert into public.point_ledger
    (user_id, type, amount, balance_before, balance_after, source, reference_id, description)
  values
    (v_uid, 'AI_CONSUMPTION', -v_amount, v_before, v_after,
     coalesce(p_source, 'generation'), p_reference_id, p_description);

  return jsonb_build_object('ok', true, 'duplicated', false, 'balance', v_after);
end;
$$;

comment on function public.consume_points(numeric, text, text, text, uuid) is
  '原子扣减积分并写流水；余额不足不动账；同一 reference_id 重复调用只扣一次';

grant execute on function public.consume_points(numeric, text, text, text, uuid) to authenticated, service_role;

-- ─── 6. 管理员手动调整（必须填原因，必须带调整单号）──────────
--
-- 只允许服务端通道调用：Node 层先做管理员身份校验，再以 service_role 进来。
-- p_reference_id 必填 —— 没有单号就失去幂等，一次手抖点两下就是两笔账。
create or replace function public.adjust_points_manual(
  p_user_id      uuid,
  p_delta        numeric,
  p_reason       text,
  p_reference_id text,
  p_admin_id     uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_delta  numeric;
  v_before numeric;
  v_after  numeric;
begin
  if not public.is_service_caller() then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  if p_user_id is null or p_reference_id is null or coalesce(trim(p_reason), '') = '' then
    return jsonb_build_object('ok', false, 'code', 'bad_params');
  end if;

  v_delta := coalesce(p_delta, 0);
  if v_delta = 0 then
    return jsonb_build_object('ok', false, 'code', 'bad_amount');
  end if;

  insert into public.user_balances (user_id, balance)
  values (p_user_id, 0)
  on conflict (user_id) do nothing;

  select balance into v_before
  from public.user_balances
  where user_id = p_user_id
  for update;

  v_before := coalesce(v_before, 0);
  v_after  := v_before + v_delta;

  -- 扣减不得击穿 0：余额为正是整个系统的底线
  if v_after < 0 then
    return jsonb_build_object('ok', false, 'code', 'insufficient_balance', 'balance', v_before);
  end if;

  insert into public.point_ledger
    (user_id, type, amount, balance_before, balance_after, source, reference_id, description, created_by)
  values
    (p_user_id, 'MANUAL_ADJUSTMENT', v_delta, v_before, v_after,
     'admin', p_reference_id, p_reason, p_admin_id)
  on conflict (user_id, type, reference_id) where reference_id is not null do nothing;

  if not found then
    -- 同一调整单号重复提交：返回当前余额，不重复加减
    return jsonb_build_object('ok', true, 'duplicated', true, 'balance', v_before);
  end if;

  update public.user_balances
    set balance = v_after, updated_at = now()
    where user_id = p_user_id;

  return jsonb_build_object('ok', true, 'duplicated', false, 'balance', v_after);
end;
$$;

comment on function public.adjust_points_manual(uuid, numeric, text, text, uuid) is
  '管理员手动调整积分：必须填原因与调整单号（幂等键）；扣减不允许产生负余额';

grant execute on function public.adjust_points_manual(uuid, numeric, text, text, uuid) to service_role;

-- ─── 7. ensure_balance 改造：开户赠送改为走流水 ───────────────
-- 旧版本是「行不存在就白送 20」，没有流水、无法审计。
-- 这里保留签名（前端 /api/user/balance 与其测试依赖它），内部改走 grant_register_bonus，
-- 从此赠金也能在 point_ledger 里查到。
create or replace function public.ensure_balance(p_grant numeric default null)
returns numeric
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_uid    uuid := auth.uid();
  v_result jsonb;
begin
  if v_uid is null then
    return null;
  end if;

  v_result := public.grant_register_bonus(v_uid, p_grant);
  if (v_result ->> 'ok')::boolean is not true then
    return null;
  end if;

  return (v_result ->> 'balance')::numeric;
end;
$$;

comment on function public.ensure_balance(numeric) is
  '保证余额行存在并触发（幂等的）注册赠送，返回当前余额；赠金写入 point_ledger';

grant execute on function public.ensure_balance(numeric) to authenticated;

-- ─── 8. 验证查询 ────────────────────────────────────────────
--   select * from public.point_config order by key;
--   select public.grant_register_bonus();                     -- 首次 granted:true
--   select public.grant_register_bonus();                     -- 再次 granted:false（幂等）
--   select public.consume_points(1, 'demo-ref-1');            -- ok
--   select public.consume_points(1, 'demo-ref-1');            -- duplicated:true，不重复扣
--   select type, amount, balance_before, balance_after, reference_id, created_at
--     from public.point_ledger order by created_at desc limit 20;
