# 数据库备份与恢复手册

> 最后一次确认：2026-09-27
> 适用范围：本项目 Supabase（PostgreSQL）实例的全量备份与恢复。

---

## 为什么需要它

Supabase **免费版不提供 PITR（时间点恢复）和每日自动备份**。
在没有本机制之前，一次 `delete from posts` 忘带 `where`、一次迁移脚本写错，
就是不可逆的全量数据丢失，且没有任何补救手段。

备份是本项目目前最大的单点风险，优先级 P0。

---

## 一、快速开始

### 1. 配置环境变量

在 `.env.local` 中补齐（REST 模式需要的两项通常已经有了）：

```bash
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...        # service_role，绕过 RLS，只放本地/服务端
SUPABASE_DB_URL=postgresql://postgres.xxxx:PASSWORD@aws-0-ap-xxx.pooler.supabase.com:6543/postgres
```

`SUPABASE_DB_URL` 获取方式：Supabase 控制台 → Project Settings → Database →
Connection string → **Session pooler**（端口 6543）。密码是建库时设的数据库密码，
不是 anon key 也不是 service_role key。

`.env.local` 已被 `.gitignore` 排除（规则 `.env*`），不会误提交。
备份产物目录 `/backups/` 同样已被排除。

### 2. 跑一次备份

```bash
npm run backup
```

脚本会自动选择模式：

| 模式 | 触发条件 | 产物 | 恢复方式 |
|---|---|---|---|
| `pg_dump`（首选） | 配了 `SUPABASE_DB_URL` 且本机有 `pg_dump` | `db-YYYYMMDD-HHMMSS.sql.gz` | `pg_restore` 直接恢复到空库 |
| `rest`（兜底） | 其余情况 | `db-YYYYMMDD-HHMMSS.json.gz` | `npm run restore <文件>` |

Windows 通常没装 PostgreSQL 客户端，会自动走 REST 模式——
它不需要任何额外安装，开箱即用。

只想要 REST 模式（例如 CI 环境）：

```bash
npm run backup:rest
```

### 3. 确认产物

```bash
ls backups/
# db-20260927-030000.json.gz
```

**把备份同步到另一处**（对象存储 / 移动硬盘 / 另一台机器）。
只留在本机的备份，在硬盘故障面前等于没有。

---

## 二、定时备份（Windows）

已提供一键脚本 `scripts/backup-daily.bat`，它会调用备份命令并把输出追加到日志。

注册为每日计划任务（管理员 PowerShell 执行一次）：

```powershell
schtasks /Create `
  /TN "FoodDBBackup" `
  /TR "cmd /c cd /d C:\Users\王俊澄\Desktop\food && scripts\backup-daily.bat" `
  /SC DAILY /ST 03:00 /F
```

说明：

- `/ST 03:00` 是每天凌晨 3 点，业务低峰
- 日志落在 `backups/backup.log`
- 备份保留策略默认**最近 30 份**（`--keep=30`），超出自动清理
- 任务是否真的在跑，看 `backups/` 里有没有当天的新文件，别假设它成功

Linux / macOS / CI 用 crontab：

```cron
0 3 * * * cd /path/to/food && node scripts/backup-db.mjs >> backups/backup.log 2>&1
```

---

## 三、恢复

### 先看这里：选对模式

| 场景 | 用什么 |
|---|---|
| 误删了几条数据 / 改错几行 | `merge`（默认） |
| 整库回滚到某个快照 / 恢复到空库 | `replace --force` |

### merge（默认，安全）

按主键 upsert：备份里有的行覆盖回去，**备份之后新增的行保持不动**。
幂等，可以重复执行。

```bash
# 先看一眼要恢复什么（不写入）
node scripts/restore-db.mjs backups/db-20260927-030000.json.gz --dry-run

# 只恢复某几张表
node scripts/restore-db.mjs backups/db-20260927-030000.json.gz --tables=posts,comments

# 真正执行
npm run restore backups/db-20260927-030000.json.gz
```

### replace（危险）

先按外键依赖顺序清空整表，再灌入快照数据，最终与快照完全一致。

```bash
node scripts/restore-db.mjs backups/db-20260927-030000.json.gz --mode=replace --force
```

**执行前必须先跑一份当前库的新备份**，否则没有回滚的余地。

### pg_dump 产物的恢复

```bash
gunzip -c backups/db-20260927-030000.sql.gz | pg_restore --clean --if-exists -d "$SUPABASE_DB_URL"
```

---

## 四、维护约定

1. **新增表时必须同步 `scripts/backup-db.mjs` 的 `TABLES` 列表**，否则该表不会被快照覆盖。
   对照方法：

   ```bash
   grep -h "create table" supabase/setup.sql supabase/migrations/*.sql
   ```

2. **新增表时同步 `scripts/restore-db.mjs` 的 `PRIMARY_KEYS`**（upsert 需要冲突列）与
   `DELETE_ORDER`（replace 模式的清空顺序：先引用方，后被引用方）。

3. **每季度做一次恢复演练**。没有验证过的备份不是备份——
   找个测试库真实恢复一次，确认产物可用。

4. **service_role key 只在本地和服务端使用**，不要提交、不要放进任何
   `NEXT_PUBLIC_` 变量（那会被打进前端 bundle）。

---

## 五、常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| `✗ 缺少配置` | `.env.local` 里没有 URL 或 service_role key | 补齐环境变量 |
| 某张表显示 `✗ 失败` | 该表对应的迁移未执行 | 先跑迁移；其它表已正常导出 |
| 恢复时报 `HTTP 409` | 主键映射写错 | 核对 `PRIMARY_KEYS` |
| 恢复时报外键错误 | replace 模式的清空顺序不对 | 调整 `DELETE_ORDER` |
| 备份文件异常小 | 多半只导出了空表 | 用 `--mode=rest` 看每张表的行数日志 |
