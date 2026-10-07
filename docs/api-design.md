# Pawhub 后端 API 设计草案

本文以 [产品设计](product-design.md) 为业务依据，用于下一步 Express.js / PostgreSQL 实现；接口尚未实现。字段和协议是建议方案，未确认的业务规则在文末列出。 数据表及约束见 [数据库设计草案](database-design.md)。

## 接口总览（App 与 Manager 网站）

所有路径均以 `/api/v1` 为前缀。App 与桌面网站共用同一后端；manager 接口使用 `/manager` 区分管理权限，不是独立 API 系统。详细请求、响应和权限见后续各节。

| 接口 | 功能 | 使用端 |
| --- | --- | --- |
| `POST /auth/login` | 门店或工作人员登录 | App |
| `POST /manager/auth/login` | 管理账号登录 | 网站 |
| `POST /auth/logout`、`GET /me` | 退出、当前账号 | 两端 |
| `POST /auth/password-links` | 请求密码重置邮件 | 两端 |
| `POST /auth/password-links/consume` | 设置密码、邀请激活 | 两端 |
| `GET /shops` | 查询可访问门店 | App |
| `POST /photos`、`GET /photos/:photoId` | 上传及授权查看自拍 | 上传由 App；查看由两端 |
| `GET /attendance/status` | 当天签到状态及计划时间输入要求 | App |
| `POST /attendance` | 签到、签退及离线同步 | App |
| `GET /attendance`、`GET /attendance/summary` | 本人或门店范围的记录、工时查询 | App |
| `GET /attendance/:recordId/history` | 调整及验证历史 | App |
| `POST /attendance-adjustments` | 新增、修改、删除时间记录 | App |
| `GET /manager/shops`、`GET /manager/workers` | 门店及人员筛选列表 | 网站 |
| `GET /manager/attendance` | 按月份、个人、门店查询记录 | 网站 |
| `GET /manager/attendance/:recordId/history` | 查看原始、调整及验证历史 | 网站 |
| `GET /manager/attendance/summary` | 按完整筛选范围统计工时 | 网站 |
| `POST /manager/reports/pdf` | 生成签到记录或工时 PDF | 网站 |
| `GET /manager/validations` | 查询待验证及已处理记录 | 网站 |
| `POST /manager/validations/:adjustmentId/decision` | 批准或拒绝验证 | 网站 |
| `POST /manager/attendance/:recordId/corrections` | Manager 调整管辖门店内任意签到/签退时间 | 网站 |
| `POST /manager/workers` | 添加 groomer 并发送邀请 | 网站 |
| `POST /manager/managers` | Super Manager 添加 manager 并发送邀请 | 网站 |
| `GET /manager/invitations` | 查询邀请及邮件发送状态 | 网站 |
| `POST /manager/accounts/:accountId/invitations` | 重发首次激活邀请 | 网站 |

## 1. 通用约定

- 基础路径 `/api/v1`，通过 HTTPS 访问。普通请求及响应使用 JSON；照片上传使用 multipart。
- 四位账号 ID 使用字符串，保留前导零。资源 ID、操作 ID 使用 UUID。
- 时间使用包含时区的 RFC 3339 时间戳，响应统一 UTC；日期参数使用 `YYYY-MM-DD`，按 `Pacific/Auckland` 解析成半开区间，不固定 UTC 偏移。
- App 和后台采用可撤销的服务端会话，请求携带 `Authorization: Bearer <sessionToken>`；会话有效期另行确定。密码设置或重置成功撤销该账号所有会话。
- 成功返回 `{ "data": ... }`。失败返回 `{ "error": { "code": "...", "message": "...", "fields": [] }, "requestId": "..." }`。字段错误含字段路径和错误码，日志不记录密码、会话凭证或密码链接令牌。
- `201` 表示新建成功，`200` 表示查询、决策或重复提交返回已有结果。错误使用 `400`（格式）、`401`（未登录）、`403`（无权限）、`404`（授权范围内不存在）、`409`（状态或版本冲突）、`422`（字段或业务校验）、`429`（限流）、`503`（临时不可用）。资源查询先限定权限范围，避免泄露其他店铺记录。

## 2. 身份与权限

| 登录身份 | 权限边界 |
| --- | --- |
| SHOP | 绑定店铺内的签到、查询及时间调整；须提供 workerId，无需工作人员密码 |
| WORKER | 仅本人签到、查询及时间调整；workerId 从会话确定，传入他人 ID 时拒绝 |
| MANAGER | 仅已分配店铺内的管理查询、调整与验证 |
| SUPER_MANAGER | 全店铺管理及 manager 账号和店铺授权管理 |
| IT | 权限待设计；不默认赋予业务管理权限 |

shopId、workerId、操作者及角色均须后端校验；操作者、提交来源、接收时间、验证人不可由请求指定。个人可查询其他店铺的本人记录，具体可签到店铺列表需结合后续店铺分配规则确定。

## 3. 登录与账号

| 接口 | 请求 | 返回 |
| --- | --- | --- |
| `POST /auth/login` | `accountId`, `password` | `sessionToken`, `expiresAt`, `account`（SHOP 或 WORKER） |
| `POST /manager/auth/login` | `email`, `password` | 同上，后台账号身份 |
| `POST /auth/logout` | 无请求体 | `loggedOut: true`，撤销当前会话 |
| `GET /me` | 无 | 当前身份及允许访问的店铺范围 |
| `POST /auth/password-links` | 工作人员 `accountId` 或 manager `email`，二者择一 | 统一受理响应，不暴露账号是否存在 |
| `POST /auth/password-links/consume` | `token`, `newPassword` | 密码设置结果；单次使用、七天有效，原子消费并撤销会话 |

SHOP 不通过邮件链接重置密码，由授权后台管理。首次设置链接由后台创建账号流程发出，不提供公开注册。邮件发送失败须可追踪及重试，不能宣称已发送。

## 4. 店铺与照片

`GET /shops` 返回当前身份可访问的店铺：`shopId`, `name`, `address`, `latitude`, `longitude`, `radiusMeters`（500）。返回列表不替代具体操作的权限检查。

建议第一版使用 `POST /photos` 上传单张自拍（multipart 字段 `file`），返回 `photoId`。文件存私有存储，检查真实图片格式和大小；具体限制在实现时配置。照片绑定上传会话及权限范围，不允许引用他人照片。离线时保存本地照片，联网后先上传，再提交签到；上传本身也使用固定 `operationId` 去重。未关联照片的清理策略待实现时确定。

照片查看使用授权接口 `GET /photos/:photoId`，返回短期访问地址及有效期；须先验证对应签到记录的查询权限，不公开长期地址。

## 5. 当天状态查询

`GET /attendance/status?workerId=1234&shopId=0001`

- SHOP 的 shopId 可省略，后端使用绑定店铺；指定其他店铺拒绝。
- WORKER 的 workerId 可省略；shopId 指当前选择店铺。
- 返回 `localDate`, `timezone`, `serverTime`, `nextAction`, `requiresPlannedStart`, `latestRecordId`, `stateVersion`。
- nextAction 为 SIGN_IN 或 SIGN_OUT，按当天调整后的最新有效记录判断；删除记录不参与。requiresPlannedStart 表示此工作人员当天是否尚无首次签到，不按单个设备判断。
- 工时待验证不阻止签到状态变化。午夜恢复 SIGN_IN，不生成签退、不删除历史。
- “首次签到”和签到状态是否跨店铺统一，以及跨设备离线冲突的最终处理尚待确认；接口不能仅以当前店铺查询结果认定首次签到。

## 6. 提交签到及离线同步

`POST /attendance`

```json
{
  "operationId": "a8f38351-9c56-4a5a-810a-5a2a5cd6787a",
  "workerId": "1234",
  "shopId": "0001",
  "type": "SIGN_IN",
  "occurredAt": "2026-10-07T20:10:00Z",
  "plannedStartAt": "2026-10-07T20:00:00Z",
  "offline": false,
  "cameraStatus": "AVAILABLE",
  "photoId": "624a4b47-8285-4312-b902-24a9eaa9ea4b",
  "location": {
    "status": "AVAILABLE",
    "latitude": -36.8485,
    "longitude": 174.7633,
    "accuracyMeters": 20
  }
}
```

| 字段 | 校验与含义 |
| --- | --- |
| operationId | 必填；客户端在本地持久保存，所有重试沿用；以登录提交账号与操作 ID 为去重范围 |
| type | SIGN_IN 或 SIGN_OUT，不因同步时状态而改写原操作类型 |
| occurredAt | 必填；Sign In 取点击签到按钮的时刻，在弹出计划时间对话框前固定；确认、提交及重试不能改写。后台另存 receivedAt；时间可信度和允许误差待定 |
| plannedStartAt | 当天首次 SIGN_IN 必填，对话框默认值为本次点击签到按钮的时刻（occurredAt），用户可修改计划时间；SIGN_OUT 不接收；后续 SIGN_IN 不要求。离线重复首次冲突不能静默覆盖 |
| offline | 必填布尔值；产生于离线的标签永久保留，与是否已同步分开 |
| cameraStatus | AVAILABLE 或 UNAVAILABLE；AVAILABLE 需有效 photoId，UNAVAILABLE 不传照片 |
| location | SHOP 可为 null；WORKER 需 AVAILABLE（有效坐标）或 UNAVAILABLE（不含坐标） |

后台根据店铺坐标计算范围结果，返回 IN_RANGE、OUT_OF_RANGE、UNAVAILABLE 或 NOT_APPLICABLE；范围外或定位失败仍接受签到。离线期间店铺坐标变化的取值规则待确认，不直接信任客户端范围结论。

首次签到的事务同时保存原始记录和计划时间：

1. 实际时间早于计划时间：正式计算开始时间使用计划时间，原始时间仍保留。
2. 实际时间等于计划时间：正式计算开始时间使用该时间。
3. 实际时间晚于计划时间：创建 `PLANNED_START` 待验证调整（原时间 → 计划时间），不要求前端再调用调整接口。未通过验证不能把计划时间作为已确认时间。

签到、自动调整和幂等结果必须在同一数据库事务内保存。重复 operationId 且载荷一致返回原结果，不重复创建记录；同一 ID 的有效载荷不同返回 `409 IDEMPOTENCY_CONFLICT`。权限失效时仍须重新鉴权。

响应示例：

```json
{
  "data": {
    "recordId": "afab2431-2078-477b-87ee-a382e98c045e",
    "operationId": "a8f38351-9c56-4a5a-810a-5a2a5cd6787a",
    "syncStatus": "SYNCED",
    "validationStatus": "PENDING",
    "adjustmentId": "d5ac0a75-cabd-4cfc-a5b0-484c73339153"
  }
}
```

幂等响应保持原结果；当前 nextAction 通过状态查询获得，避免重试返回过期按钮状态。SYNCED 仅表示后台已保存，不代表工时已经验证。

离线队列先持久保存全部操作数据及照片，再显示本地保存成功；网络恢复后按原始操作顺序逐条提交、逐条确认。失败不丢弃队列；401 需重新登录，422/409 需显示或转交人工处理，不能无限自动重试。服务端依据原时间归属日期，不能以收到请求的日期处理旧记录。乱序及多设备冲突在最终规则确定前不能静默修改历史。

## 7. 查询记录与工时

`GET /attendance?workerId=1234&shopId=0001&fromDate=2026-10-01&toDate=2026-10-07&limit=50&cursor=...`

fromDate/toDate 为含首尾的 Auckland 日期。limit 默认 50、上限 100，日期范围建议最多 31 天，采用稳定游标分页。SHOP 限本店指定工作人员，WORKER 限本人所选店铺。后台查询使用独立的 `GET /manager/attendance`，限制授权店铺。

返回 `data.items` 及 `data.nextCursor`。每条记录至少包含：

- recordId、workerId、shopId、type、originalOccurredAt、receivedAt、plannedStartAt。
- effectiveOccurredAt（用于按钮状态的调整后时间）、effectiveDeleted。
- confirmedOccurredAt、confirmedDeleted（用于正式工时，与前端有效状态分离）。
- cameraStatus、photoId、locationStatus、offline、validationStatus、version。

`GET /attendance/:recordId/history` 返回该记录的原始内容、全部新增/修改/删除调整及验证历史，权限与列表一致。

`GET /attendance/summary` 使用相同身份、店铺和日期筛选，返回 `confirmedHrs`、`pendingSegmentCount`、`invalidSegmentCount` 和时段列表；汇总必须覆盖完整筛选范围，不仅当前分页。hrs 是小时数，与确认时间戳分开；待验证或异常时段的 confirmedHrs 为 null，不伪装为 0。小时数字段统一使用两位小数字符串，例如 "8.08"。

有效时段按确认后的 SIGN_IN / SIGN_OUT 配对，精确分钟数除以 60，四舍五入保存两位小数，多个时段按已保存 hrs 汇总。缺少配对、时间倒置、重叠等不能静默修复；跨午夜时段标错误，提交 manager 处理；不自动截断或批准跨日计薪。未验证调整涉及的时段不进入已确认合计。原始已确认结果及新待验证调整须可追溯。

## 8. 工作人员时间调整

`POST /attendance-adjustments`

- 通用字段：operationId、action（ADD / UPDATE / DELETE）。
- ADD：workerId、shopId、type、occurredAt；选择新增签到或签退类型。
- UPDATE：recordId、expectedVersion、occurredAt；不能更换工作人员、店铺或已有记录类型。
- DELETE：recordId、expectedVersion；逻辑删除，保留原始记录及历史。
- 不要求填写原因；操作者身份从会话取得。返回 adjustmentId、validationStatus=PENDING、recordId、version。

提交后立即更新前端有效记录状态，正式计算时间和删除状态在 manager 验证前保持分离。expectedVersion 防止覆盖并发调整，过期返回 `409 VERSION_CONFLICT`，前端重新查询。该接口同样要求幂等事务。ADD 创建可追踪的人工新增记录及待验证调整，不能伪装成拍照签到。

## 9. Manager 验证

`GET /manager/validations?month=2026-10&shopId=0001&status=PENDING&limit=50&cursor=...`

返回 adjustmentId、recordId、workerId、shopId、来源（WORKER_EDIT / PLANNED_START）、action、修改前后时间、createdAt、recordVersion。只返回授权店铺。

`POST /manager/validations/:adjustmentId/decision`

```json
{
  "operationId": "f49c0db3-4c72-4193-8aa8-d592cf2038b3",
  "decision": "APPROVE",
  "expectedRecordVersion": 3
}
```

APPROVE 对指定调整进行验证：检查权限和版本，在同一事务内保存验证人、验证时间及结果，更新正式时间并重新计算受影响工时。迟到调整通过后采用计划上班时间。重复操作返回同一结果；陈旧版本或相互冲突的调整返回 409，不能通过“最后一次修改优先”自动覆盖。

decision 支持 APPROVE / REJECT。REJECT 保存拒绝历史，保留符合规则的既有正式值；不符合规则则保留待处理状态，由 manager 手动修正。存在后续调整冲突时返回 409，不能直接覆盖。异常队列同时返回 OPEN 错误记录，区分 itemType=ADJUSTMENT / RECORD_ERROR，不能只查询待验证调整。

建议新增 `POST /manager/attendance/:recordId/corrections`：operationId、expectedRecordVersion、occurredAt，适用于当前 manager 管辖门店内的任何签到或签退记录，包括正常和已确认记录，不限于错误记录。创建 MANAGER_EDIT 调整并由当前授权 manager 确认，完整保存原始记录、修改前后值与验证历史，禁止覆盖原始时间。工作人员、门店及已有类型不可修改。响应包含 recordId、adjustmentId、validationId、version 及 resolutionStatus；修正仍须通过同日、时间顺序及完整配对检查，不能仅批准错误数据。

## 10. Manager 网站 API

网站以桌面操作为主，管理接口与 App 共用业务规则和数据库。网站不直接连接数据库，所有筛选、统计、导出和操作由后端鉴权。以下为建议字段和接口。

### 10.1 记录、统计及验证查询

统一筛选参数：month（必填，严格 YYYY-MM，有效月份 01–12）、workerId、shopId。个人和门店均可不选；不选时仅查询当前 manager 获授权的全部门店，而非全系统。网站首次进入默认 Auckland 当前月份，并明确传入 month；API 不默默回退当前月份。limit/cursor 沿用普通查询约定，游标绑定筛选条件，换月需重置。管理查询不再接收 fromDate/toDate，避免混用；App 日期范围接口保持原用途。

month 对应当地月初 1 日 00:00（包含）至下个月 1 日 00:00（不包含），分别以 Pacific/Auckland 转换为 UTC 查询边界，不能加固定天数或固定 UTC 偏移。响应包含 period：month、timezone、fromDate、toDate（该月最后一天），让界面和 PDF 显示同一范围。记录列表按 effective_occurred_at 归属月份，正式工时按 confirmed 时段 start_at 归属月份，待验证/错误按目标记录的有效日期筛选；原时间与正式时间调整跨月时应在历史及报告明确显示，不能要求原始记录列表与正式统计无条件一一对应。

| 接口 | 返回 |
| --- | --- |
| `GET /manager/shops` | 已授权门店列表，用于筛选 |
| `GET /manager/workers?shopId=...` | 授权门店范围内人员及激活状态，支持分页 |
| `GET /manager/attendance` | 按组合条件分页返回签到/签退记录及关联验证状态 |
| `GET /manager/attendance/:recordId/history` | 授权记录的完整调整和验证历史 |
| `GET /manager/attendance/summary` | 完整筛选范围内总工时及按个人、门店分组结果，分页不影响合计 |
| `GET /manager/validations` | 支持相同月份、个人、门店筛选及 status；月份指目标记录有效时间所属 Auckland 月份 |
| `POST /manager/validations/:adjustmentId/decision` | 按第 9 节确认指定调整，返回验证状态、正式时间及最新记录版本 |

summary 建议包含 confirmedHrs、pendingSegmentCount、invalidSegmentCount，以及 groups（workerId、shopId、confirmedHrs、待验证及异常计数）。无可确认时段时显示“尚无已确认工时”，不能让缺失或待验证时段看起来已按零小时结算。

月份查询示例：

```http
GET /api/v1/manager/attendance?month=2026-10&workerId=1234&shopId=0001&limit=50
GET /api/v1/manager/attendance/summary?month=2026-10&shopId=0001
GET /api/v1/manager/validations?month=2026-10&shopId=0001&status=PENDING
```

summary 返回整月 confirmedHrs（两位小数字符串）、待验证/异常计数、按个人及门店分组，以及 period。个人合计和门店合计为不同汇总视图，不能将两者再次相加。二月自动处理 28/29 天，其他月份按实际最后一天；当前月份只统计已发生记录。

### 10.2 PDF 生成

建议 `POST /manager/reports/pdf`，请求字段 operationId、month（YYYY-MM）、可选 workerId/shopId，reportType 为 ATTENDANCE 或 TIMESHEET。后端对授权范围内的完整筛选结果生成 PDF，不使用浏览器当前表格页作为报告数据。

初期人数较少，可同步生成，返回 `application/pdf` 与附件下载文件名。报告包含筛选条件、Auckland 时区、生成时间、人员及店铺、原始和正式时间、已确认工时，以及待验证/异常说明；最终排版另行确定。PDF 生成时使用一致的数据快照，保存导出人、筛选范围及生成时间作为审计记录。重复 operationId 且参数一致返回同一快照报告；每次下载仍重新检查当前权限，不以知道文件 ID 代替授权。

报告不可公开存储，不包含密码、会话或邀请令牌。导出请求一次覆盖一个完整月份，与网站筛选及月度统计一致；临时文件与报告保留周期待实现时确定。手动下载 PDF 与自动发送 Timesheet 邮件分开。

### 10.3 添加 groomer 和 manager

`POST /manager/workers`

```json
{
  "operationId": "5737f9ca-c609-414a-9678-0d619ed9ab76",
  "name": "Example Worker",
  "email": "worker@example.com",
  "contact": "",
  "address": "",
  "shopIds": ["0001"]
}
```

workerId 由后台随机生成四位数字并检查唯一性，不能由普通 manager 任意指定。shopIds 为建议的人员管理关联字段，仅可包含操作者管理的门店；workerId 已确定全系统唯一、跨店铺永久保持不变；具体跨店铺归属尚待确认。不要把这项关联自动解释为限制个人所有历史查询。

`POST /manager/managers` 仅 SUPER_MANAGER 可调用，提交 operationId、name、email、shopIds；创建独立 manager 账号并分配管理门店。普通 MANAGER 无创建或提升 manager 权限，不能通过请求体 role 提权。Super Manager / IT 初始化另行设计。

两个创建接口均不接收初始明文密码。返回内部 accountId、账号类型、workerId（适用时）、activationStatus=PENDING、invitationId、emailStatus。创建账号、邀请及待发送邮件在同一事务保存，建议使用数据库 outbox 可靠发送。账号创建成功不等于邮件已投递：emailStatus 为 QUEUED / SENT / FAILED；SENT 表示邮件服务已受理，不保证收件箱到达。

创建请求幂等：重试不重复创建账号或邮件。后台账号之间（MANAGER / SUPER_MANAGER / IT）邮箱重复返回明确冲突，工作人员账号之间邮箱重复也返回冲突；后台账号和 groomer 可各自使用同一邮箱，账号及邀请必须独立绑定。

### 10.4 邀请和注册激活

| 接口 | 用途 |
| --- | --- |
| `GET /manager/invitations?accountId=...&limit=50&cursor=...` | 查询授权账号的邀请状态及邮件发送状态，不返回令牌 |
| `POST /manager/accounts/:accountId/invitations` | 使用 operationId 重发首次激活邀请；校验账号管理权限并限流 |
| `POST /auth/password-links/consume` | 受邀人提交 token、newPassword，完成首次密码设置及账号激活 |

邀请链接绑定具体账号及用途，七天有效、单次使用，数据库仅保存令牌哈希。重发建议使旧的未使用首次邀请失效；已激活账号需走密码重置流程。普通 manager 只能为授权门店内的 groomer 发送邀请，manager 账号邀请由 Super Manager 管理。

链接通过邮件交付，不在管理查询 API 返回原始令牌。用户点击网站链接后设置密码，再按对应账号类型登录；无需公开注册或重新创建账号。链接无效、过期或已使用时给出明确提示和联系管理员重发的入口。

店铺创建/更新、门店密码重置及 Timesheet 定期发送接口将在相关规则明确后补充。

## 11. 实现前仍需确认

- 多店铺、跨设备时每日首次签到和当天按钮状态的归属；离线状态冲突处理。
- 多个调整冲突的具体界面及处理流程。
- 跨店新签到是否阻止提交及其他异常检测细则；不擅自扣除休息时间。
- 人员跨店铺归属、会话有效期、实际签到时间可信度、照片限制及保存周期。
- PDF 报告排版及保留周期；邮件域名、网站地址和发送服务在部署时配置。

## 12. 实现后的验收场景

- 门店 A 不能查询、提交或验证门店 B 的受限记录；个人不能操作他人记录。
- 重复签到请求仅生成一条记录和一条迟到调整；相同操作 ID 不同载荷返回冲突。
- 实际 Sign In 固定为点击签到按钮的时刻，对话框填写耗时、提交延迟及重试不改变该时间；计划时间默认使用同一时刻。
- 提前及准时签到计算正确；迟到保留原时间，批准后使用计划时间计算。
- 待验证调整立即改变按钮状态，但不提前确认工时；删除保留完整历史。
- 离线同步使用原时间和离线标签；午夜不生成签退，Auckland 夏令时边界查询正确。
- 失效会话、单次密码链接、并发修改与陈旧验证均返回可处理的错误。

- Manager 按月份、个人及门店组合筛选，验证二月/闰年、12 月跨年及 Auckland 夏令时边界，完整月份范围汇总一致，PDF 不遗漏分页外记录、不包含越权数据；导出时待验证工时明确标记。
- 普通 manager 不能创建 manager 或重发其邀请；账号创建重试不重复发信，邮件失败可重试，邀请链接只能激活绑定账号一次。

以上为待实现的验收场景，本次未执行应用测试。

## 工时及错误数据处理补充

### 拒绝验证、错误签退及工时精度

Manager 拒绝调整时保留原始记录和拒绝历史；若既有正式记录符合规则且没有其他未解决问题，可维持原正式结果并重新计算。否则保持错误/待处理状态，由 manager 手动修改并确认，不能把“拒绝”自动当作数据已正确。拒绝后前端有效投影回到可用的正式记录；存在后续冲突调整时返回版本冲突，先明确处理，不能静默覆盖。

不允许跨午夜工时时段。Sign Out 必须处于 Sign In 对应的同一个 Auckland 当地日期；下一日 00:00 起视为跨日，标记 CROSS_MIDNIGHT 错误并进入 manager 验证队列。原始签退仍需保存，不能丢弃、截断为午夜或自动计薪。午夜状态重置不消除该错误；迟到达的离线请求按原操作时间判断。异常数据只有经 manager 修正为符合规则的同日时段并确认后，才能计入工时；仅点击批准不能豁免同日约束。

每个有效时段的分钟数为实际时间差除以 60 秒，保留秒和亚秒带来的小数分钟，不先截断或取整分钟。`hrs = ROUND(duration_minutes / 60, 2)`，采用十进制四舍五入，保存两位小数。同日多时段汇总已保存的时段 hrs，确保明细与合计一致；该舍入及汇总方式为实现约定。例：485 分钟 / 60 = 8.0833…，记录 8.08；490 分钟记录 8.17。API 使用字符串如 `"8.08"` 表示小时数，避免二进制浮点误差并保留两位小数。


## Manager 调整权限补充

Manager 可通过 corrections 接口调整管辖门店内任何签到/签退时间，包括已验证及无异常记录；后端每次重新检查当前门店权限和记录版本。调整写入独立 MANAGER_EDIT 和验证历史，再更新正式时间及重算工时；原始时间不可变。此权限不自动允许修改工作人员、门店或已有操作类型，也不允许对后续员工调整设置自动优先级。PDF 已导出快照保持不变，新查询和新报告使用更新结果。

## 单一门店闭合规则

不允许跨门店 Sign In / Sign Out 配对。每个工作人员在单一门店内完成签到和签退闭合；其他门店的 Sign Out 不能关闭本店的 Sign In，也不能跨店计算工时。未闭合记录标记为错误/待处理，提交该记录所属门店的 manager 验证；不能转交另一个门店的 manager。按工作人员及门店分别识别配对，保留原始记录，不自动补签到或签退。

存在未闭合 Sign In 时不能仅因刚收到签到就认定错误（正常在岗也暂时未签退）。闭合检查在出现无法合法配对的事件、工作人员转到另一门店签到或 Auckland 当天结束时触发；当天结束仍未签退则进入原店验证队列。另一门店的孤立 Sign Out 进入该签退所属门店的队列，不借用其他店的 Sign In。跨店新签到是否应被阻止仍需另行明确，不能以此规则擅自丢弃实际操作记录。

管理验证查询仅返回当前 manager 管辖店铺的未闭合记录，itemType=RECORD_ERROR，issueCode=MISSING_SIGN_OUT 或 MISSING_SIGN_IN；涉及跨店尝试时可补充 CROSS_SHOP_PAIRING 错误码。每条异常保持本店 shopId，权限校验覆盖列表、详情及修正接口。月度队列按目标记录有效日期归属月份，月底未闭合记录不能因进入下个月而丢失。

## 工作人员 ID 唯一性

同一 groomer 始终使用同一个全系统唯一的四位 workerId，不按门店生成不同 ID。创建时随机生成并由全局唯一约束检查；调店、增加门店关联及停用/恢复账号均不改变或释放 ID。接口不提供修改 workerId 的功能，历史查询继续关联同一 workers.id。

## 后台邮箱唯一性

所有后台账号共用唯一的邮箱登录命名空间；WORKER 使用独立命名空间，允许与后台账号共用邮箱。邮箱统一规范化后校验，后台与工作人员密码找回入口必须传明确的账号类型（email 为后台，四位 accountId 为工作人员），不按邮箱在两类账号之间自动选择。
