# Pawhub 数据库备份设置

配置日期：2026-10-28（新西兰时间）。

## 已部署

- 服务器：Pawhub EC2，Sydney / ap-southeast-2。
- 数据库：Docker 中的 PostgreSQL 17 / pawhub。
- 定时：每天 03:00，Pacific/Auckland；自动跟随夏令时，开机后补跑错过的任务。
- 首次成功备份：2026-10-28 18:03:40 NZDT（文件名时间）；文件 56,929 字节。
- 下次计划：2026-10-29 03:00 NZDT。
- 私有桶：pawhub-signin-backups-877955776267，database/ 前缀。
- 安全：阻止全部公共访问、禁用 ACL、强制 TLS、AES256 服务端加密、启用版本控制。
- 服务器权限：仅备份目录上传、读取、读取版本和中止未完成分段上传；无删除权限。监控写入仅限 Pawhub/Backup 命名空间。
- 保留：当前版本 30 天到期；到期产生的旧版本再经过 1 天清理；过期删除标记也会清理。S3 生命周期异步执行，不代表精确在第 30 天立即永久删除。
- 备份格式：pg_dump custom，包含该数据库的结构、表数据和序列；不包含 PostgreSQL 全局角色、服务器配置、应用密钥、应用代码或照片文件。
- 生产数据库不重启，不覆盖生产数据。

## 验证

2026-10-28 18:06:40 NZDT 完成从 S3 指定版本下载、SHA256 校验、独立数据库完整恢复。

恢复环境关闭网络，无生产数据卷，使用临时内存数据目录，验证后清理。恢复了 19 张业务表、77 行记录；未验证外键数量为 0。校验报告和备份清单一同存入 S3。

成功备份键：
`database/2026-10-28T05-03-40Z-0e9f97b8.dump`

SHA256：
`caf143decd4d9894395c373a3e2960dce625ad177e284d60a8c7f704a9704030`

## 失败通知

- CloudWatch 告警：Pawhub-DatabaseBackup-Unhealthy。
- 每 5 分钟检查；最近一次备份失败，或超过 26 小时没有成功备份，会上报不健康。
- 连续两个 5 分钟监控周期不健康时告警；缺失监控数据也按异常处理。AWS 评估和投递可能有额外延迟。
- 仅配置异常状态通知，没有每日成功邮件。
- SNS 主题：pawhub-backup-alerts。
- 接收邮箱：liangtian4176@gmail.com。
- 检查时仍是 PendingConfirmation：请点击 AWS Notifications 邮件中的 Confirm subscription。确认前无法收到告警邮件；尚未验证实际邮件投递。
- 健康逻辑已验证：正常、失败、状态缺失、超过 26 小时、未来时间戳。

## 维护命令

以下在 EC2 Ubuntu 终端执行。

查看计划及最近执行结果：

```bash
sudo systemctl list-timers 'pawhub*' --all --no-pager
sudo systemctl status pawhub-db-backup.service --no-pager
sudo journalctl -u pawhub-db-backup.service -n 60 --no-pager
sudo cat /var/lib/pawhub-backup/state.json
```

手动备份一次：

```bash
sudo systemctl start pawhub-db-backup.service
```

再次进行独立恢复验证（只验证最近一次成功备份，不覆盖生产数据库）：

```bash
sudo /usr/local/sbin/pawhub-db-restore-check
sudo cat /var/lib/pawhub-backup/restore-verification.json
```

部署文件：

- `/usr/local/sbin/pawhub-db-backup`
- `/usr/local/sbin/pawhub-db-restore-check`
- `/etc/pawhub-backup.json`
- `/etc/systemd/system/pawhub-db-backup.service`
- `/etc/systemd/system/pawhub-db-backup.timer`
- `/etc/systemd/system/pawhub-backup-health.service`
- `/etc/systemd/system/pawhub-backup-health.timer`

原 `deploy/backup.sh` 已改为调用新备份程序，消除了末尾 `ser` 报错。原版本保存在服务器 `/var/lib/pawhub-backup/original-backup.sh`。

## 范围与费用

这是每日逻辑备份，最坏情况下可能损失最近约一天的数据库变更；不提供按秒恢复。没有配置跨区域或跨账号副本。签到照片桶保持原配置，数据库备份不包含照片二进制文件。

会产生 S3 存储与请求、CloudWatch 自定义指标和告警及 SNS 使用费用，具体取决于 AWS 计费及免费额度。参见 [S3 定价](https://aws.amazon.com/s3/pricing/)、[CloudWatch 定价](https://aws.amazon.com/cloudwatch/pricing/) 和 [SNS 定价](https://aws.amazon.com/sns/pricing/)。
