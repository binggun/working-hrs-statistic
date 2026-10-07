# Pawhub PostgreSQL 数据库设计草案

依据 [产品设计](product-design.md) 和 [API 设计](api-design.md)。本文为设计，尚未创建数据库或迁移。已细化全部 15 张表，包括基础资料、核心签到业务、辅助表及会话、密码链接、照片和邮件任务。

## 1. 表清单

| 表 | 用途 |
| --- | --- |
| accounts | 独立登录账号、身份及激活状态 |
| shops | 门店资料及门店登录账号 |
| workers | 工作人员资料及 Timesheet 配置 |
| account_shops | 管理员门店权限及工作人员归属 |
| sessions | 可撤销登录会话 |
| password_links | 首次激活及重置密码的单次链接 |
| attendance_records | 原始签到/签退、计划时间及操作环境 |
| attendance_adjustments | 新增、修改、删除时间的调整历史 |
| attendance_validations | Manager 验证结果及历史 |
| work_segments | 正式签到/签退配对、小时数及异常状态 |
| photos | 私有自拍文件元数据 |
| email_jobs | 可重试的邀请及 Timesheet 邮件队列 |
| api_operations | 请求去重及幂等结果 |
| report_exports | PDF 快照、文件及导出状态 |
| audit_logs | 账号、权限及管理操作的审计历史 |

## 2. 通用约定

内部主键使用 UUID；四位登录 ID 使用 varchar(4)，不使用整数。对外 API 的 accountId 为内部 UUID，workerId/shopId 为四位业务 ID；数据库关系始终引用 UUID，避免修改显示编号破坏历史。

时间字段使用 timestamptz，created_at / updated_at 由服务端写入；业务日期按 Pacific/Auckland 转换。通用 status 不代替角色权限检查。历史相关外键默认 RESTRICT，停用代替直接删除，不级联删除签到、验证或审计记录。

四位 ID 已确定全系统唯一：同一 groomer 始终使用同一个 ID，跨门店签到和调店时不变。账号停用不释放该 ID，恢复沿用原 ID；不提供 ID 修改接口。邮箱存于 accounts，不在 workers 重复保存；保存前按统一规则规范化并检查空字符串。

## 3. accounts：登录账号

| 字段 | 类型 | 约束/用途 |
| --- | --- | --- |
| id | uuid | 主键 |
| role | varchar(20) | SHOP、WORKER、MANAGER、SUPER_MANAGER、IT |
| login_code | varchar(4) | SHOP / WORKER 必填，其他角色为空；非空值唯一 |
| email | text | WORKER / MANAGER 必填；SHOP 为空；其他角色登录规则待定 |
| display_name | text | 管理账号显示名称；工作人员姓名以 workers 为准 |
| password_hash | text | 待邀请激活可为空；ACTIVE 必须非空，使用安全密码哈希 |
| status | varchar(20) | PENDING、ACTIVE、DISABLED |
| activated_at | timestamptz | 未激活为空 |
| created_by_account_id | uuid | 可空外键至 accounts，初始化账号允许为空 |
| created_at / updated_at | timestamptz | 必填 |

CHECK：SHOP 的 login_code 满足 `^00[0-9]{2}$` 且不是 0000；WORKER 满足 `^[1-9][0-9]{3}$`。账号不能有多个角色，同一人兼任 manager / groomer 创建两个账号。

邮箱唯一性已确认：MANAGER、SUPER_MANAGER、IT 共用后台邮箱命名空间，非空邮箱在该范围内唯一；WORKER 的非空邮箱在工作人员范围内唯一。同一邮箱可分别属于一个后台账号和一个 WORKER 账号，身份及密码独立。采用两个 lower(email) 部分唯一索引分别约束后台角色与 WORKER，而非仅按单个 role 唯一。后台登录由规范化邮箱确定唯一后台账号；Super Manager / IT 的初始化及 IT 登录权限仍需明确。

索引：login_code 唯一索引、后台及工作人员规范化邮箱部分唯一索引、status。账号停用应使现有会话不可用；密码变化撤销全部会话。

## 4. shops：门店

| 字段 | 类型 | 约束/用途 |
| --- | --- | --- |
| id | uuid | 主键 |
| account_id | uuid | 非空、唯一，外键至 accounts，必须为 SHOP |
| name | text | 非空、非空白 |
| address | text | 必填 |
| latitude | numeric(9,6) | 必填，-90 至 90 |
| longitude | numeric(9,6) | 必填，-180 至 180 |
| status | varchar(20) | ACTIVE / DISABLED |
| created_at / updated_at | timestamptz | 必填 |

门店四位 shopId 来自关联 accounts.login_code，不重复存一份。签到半径按当前业务固定 500 米，无需增加可随意更改的配置。账号类型与门店资料必须在同一事务校验，必要时使用数据库触发器约束跨表角色。

停用门店保留历史，拒绝新签到；坐标更新不重写历史签到的定位结果。坐标变更和离线签到范围判断的版本规则后续设计。

## 5. workers：工作人员

| 字段 | 类型 | 约束/用途 |
| --- | --- | --- |
| id | uuid | 主键 |
| account_id | uuid | 非空、唯一，外键至 accounts，必须为 WORKER |
| name | text | 非空、非空白 |
| contact | text | 联系方式，具体必填规则待定 |
| address | text | 地址，具体必填规则待定 |
| timesheet_frequency | varchar(20) | 可空，候选 WEEKLY / FORTNIGHTLY / MONTHLY，最终周期未确定 |
| created_at / updated_at | timestamptz | 必填 |

workerId 来自 accounts.login_code；邮箱、密码及账号激活状态不重复保存。Timesheet 配置为空表示尚未配置，不自动默认每两周；四周不能等同自然月。工作人员停用由账号状态控制。

创建工作人员、关联门店、创建邀请和邮件任务须在同一事务完成。随机四位 ID 的并发冲突由数据库唯一约束兜底，再有限次数重新生成，不能仅执行“查询不存在”后插入。

## 6. account_shops：账号与门店关系

| 字段 | 类型 | 约束/用途 |
| --- | --- | --- |
| account_id | uuid | 外键至 accounts |
| shop_id | uuid | 外键至 shops |
| assigned_by_account_id | uuid | 外键至 accounts，授权操作者 |
| assigned_at | timestamptz | 分配时间 |

组合主键 `(account_id, shop_id)`，额外索引 `(shop_id, account_id)`。当前关系存在即表示有效授权/归属；解除关系记录 audit_logs，不删除相关历史签到。

仅 MANAGER / WORKER 使用此表。MANAGER 关系表示管理权限，WORKER 关系表示人员管理归属；不能直接把工作人员归属视为所有签到和历史查询的限制。SHOP 绑定关系由 shops.account_id 表达；SUPER_MANAGER 全局权限由角色表达；IT 不自动获得门店权限。

Super Manager 分配 manager 门店；普通 manager 创建 groomer 时只能关联本人管理门店。人员转店及多人管理同一工作人员的资料修改权限尚待明确，不能通过修改 account_shops 获得越权历史访问。

## 7. api_operations：幂等请求

| 字段 | 类型 | 约束/用途 |
| --- | --- | --- |
| id | uuid | 主键 |
| actor_account_id | uuid | 外键至 accounts |
| operation_id | uuid | 客户端持久保存的请求 ID |
| operation_type | varchar(40) | ATTENDANCE、ADJUSTMENT、VALIDATION、PHOTO_UPLOAD、ACCOUNT_CREATE、INVITATION、PDF_EXPORT 等 |
| request_hash | text | 规范化有效载荷的摘要，包含操作类型；不存密码或令牌 |
| resource_id | uuid | 可空，关联结果资源；多类型关联由服务端校验，不伪称通用外键 |
| response_status | smallint | 成功响应 HTTP 状态 |
| response_data | jsonb | 安全的可重放业务结果，不存密码、令牌、临时签名链接或二进制文件 |
| created_at | timestamptz | 必填 |

唯一约束 `(actor_account_id, operation_id)`，与 API 去重范围一致；跨接口误用同一个操作 ID 返回冲突。同 ID、同摘要返回已有结果，不同摘要返回 409。

数据库业务写入和成功幂等结果同事务提交，不先写“成功”再执行操作。并发请求通过唯一约束及事务锁协调；失败事务不留下成功结果。文件和邮件等外部副作用采用可重试任务，不在数据库事务内假定发送成功。下载或重放前重新鉴权。

离线重试可能很晚，签到相关去重记录不能随意按短周期清理；保留政策尚待确定。文件类操作返回资源 ID，由照片或报告接口查找结果。

## 8. report_exports：PDF 导出

| 字段 | 类型 | 约束/用途 |
| --- | --- | --- |
| id | uuid | 主键 |
| requested_by_account_id | uuid | 外键至 accounts |
| api_operation_id | uuid | 非空、唯一外键至 api_operations |
| report_type | varchar(20) | ATTENDANCE / TIMESHEET |
| filters | jsonb | month（YYYY-MM）、工作人员及门店筛选，保存 Auckland 月初/下月月初边界 |
| authorized_shop_ids | jsonb | 导出时实际授权范围的 UUID 列表，用于审计，不替代下载时鉴权 |
| snapshot_at | timestamptz | 读取报告数据的快照时间 |
| snapshot_data | jsonb | 生成报告的固定数据及汇总，不含照片二进制或秘密 |
| status | varchar(20) | PENDING / READY / FAILED / EXPIRED |
| storage_key | text | 私有 PDF 文件位置，READY 必填，不是公开链接 |
| content_sha256 | text | PDF 文件完整性摘要 |
| error_code | text | 可空，脱敏错误码 |
| created_at / completed_at / expires_at | timestamptz | 生命周期信息 |

小规模先同步响应 PDF，但保留导出记录。生成失败不标 READY；重试使用同一快照。已过期文件不能宣称仍可下载，重复操作返回明确状态，新生成使用新操作 ID。生成和下载都检查门店权限；撤销权限后不能通过旧报告访问被撤销门店内容。报告保留及清理政策尚待确定。

## 9. audit_logs：管理审计

| 字段 | 类型 | 约束/用途 |
| --- | --- | --- |
| id | uuid | 主键 |
| actor_account_id | uuid | 可空外键至 accounts，后台任务可为空 |
| actor_type | varchar(20) | ACCOUNT / SYSTEM |
| action | varchar(60) | 账号创建、停用、门店授权变更、邀请重发、PDF 导出等 |
| resource_type | varchar(40) | 资源类别 |
| resource_id | uuid | 资源 UUID，由服务端校验 |
| shop_id | uuid | 可空外键至 shops，跨店铺操作另存受影响范围 |
| request_id | text | 请求追踪 ID，可空 |
| before_data / after_data | jsonb | 白名单选取的必要变更摘要 |
| created_at | timestamptz | 必填 |

索引 `(resource_type, resource_id, created_at)`、`(actor_account_id, created_at)`、`(shop_id, created_at)`。应用只追加审计记录，不开放修改/删除接口。变更与相应审计记录同事务保存；签到和验证的详细历史仍由专门业务表承担，不能用 audit_logs 替代。

不得记录明文密码、密码哈希、会话或邀请令牌、邮件正文中的秘密、照片二进制。涉及多门店时服务端按完整范围检查审计查询权限，不能只检查一个 shop_id。

## 10. 核心业务表阅读说明

下文定义原始时间、前端有效状态与正式工时的分离。会话、密码链接、照片及邮件表见第 20–23 节。待定业务规则确认后生成 Prisma schema 和迁移，不在设计阶段执行生产数据库变更。

## 11. attendance_records：签到及签退记录

每行表示一次 SIGN_IN 或 SIGN_OUT。原始内容不可覆盖；前端有效状态和正式计算状态是可重建的当前投影，调整和验证历史是追溯依据。

| 字段 | 类型 | 约束/用途 |
| --- | --- | --- |
| id | uuid | 主键 |
| worker_id | uuid | 非空外键至 workers，内部 UUID |
| shop_id | uuid | 非空外键至 shops，内部 UUID |
| submitted_by_account_id | uuid | 非空外键至 accounts，实际提交账号 |
| api_operation_id | uuid | 非空、唯一外键至 api_operations |
| source | varchar(20) | SHOP_DEVICE / PERSONAL_APP / MANUAL_ADD |
| sign_type | varchar(10) | SIGN_IN / SIGN_OUT，创建后不允许调整类型 |
| original_occurred_at | timestamptz | 原始操作时间；App SIGN_IN 为点击按钮的时刻，MANUAL_ADD 为申请新增的时间 |
| received_at | timestamptz | 后台首次保存时间，不随同步重试改变 |
| original_local_date | date | 原始时间对应 Auckland 日期，由服务端计算，原始业务归属保留 |
| planned_start_at | timestamptz | 首次 SIGN_IN 的计划时间，可空；不覆盖 original_occurred_at |
| photo_id | uuid | 可空外键至 photos |
| camera_status | varchar(20) | AVAILABLE / UNAVAILABLE / NOT_APPLICABLE |
| location_status | varchar(20) | IN_RANGE / OUT_OF_RANGE / UNAVAILABLE / NOT_APPLICABLE |
| latitude / longitude | numeric(9,6) | 可空；成功定位时保存本次坐标及检查范围 |
| location_accuracy_meters | numeric | 可空、非负 |
| shop_latitude / shop_longitude | numeric(9,6) | 可空，记录本次距离判断采用的门店坐标 |
| distance_meters | numeric | 可空、非负；后端计算，不信任客户端范围结论 |
| offline | boolean | 非空，记录产生时是否离线，永不因同步成功改为 false |
| effective_occurred_at | timestamptz | 前端当前有效时间，调整提交即可更新 |
| effective_deleted | boolean | 非空，前端当前逻辑删除状态 |
| confirmed_occurred_at | timestamptz | 可空，当前正式计算时间；人工新增未批准时为空 |
| confirmed_deleted | boolean | 非空，正式逻辑删除状态 |
| calculation_status | varchar(20) | CONFIRMED / PENDING，表示是否有未解决的工时相关调整 |
| effective_adjustment_id | uuid | 可空，外键至 attendance_adjustments，当前前端投影来源 |
| confirmed_validation_id | uuid | 可空，外键至 attendance_validations，最近正式结果来源 |
| version | integer | 初始 1、正数，每次有效状态或正式结果变化递增 |
| created_at / updated_at | timestamptz | 非空 |

CHECK：SIGN_OUT 不得带 planned_start_at；普通拍照签到 AVAILABLE 必须有 photo_id，UNAVAILABLE 必须无照片。MANUAL_ADD 不伪造拍照和 GPS，使用 NOT_APPLICABLE。经纬度成对存在并限制合法范围。plan 与 actual 允许早晚不同，不能约束为计划时间必须早于实际时间。

初始投影：普通签到 effective_occurred_at 为实际操作时间，effective_deleted=false；没有待验证调整时 confirmed_occurred_at 为原时间，但首次提前签到的正式时间为计划时间。迟到首次签到保存原时间作为既有依据，另创建计划时间调整，并置 calculation_status=PENDING，涉及的时段不能进入已确认合计。MANUAL_ADD 的 confirmed_occurred_at 为空、calculation_status=PENDING，直到批准。

迟到自动调整的 effective_occurred_at 按申请的计划时间更新，原始时间保留，与其他调整相同；计划时间不能提前成为已确认计算时间。如果时段显示暂估值，必须与 confirmedHrs 分开。

索引：`(worker_id, shop_id, original_occurred_at, id)` 用于原始记录查询；`(worker_id, effective_occurred_at, id)` 用于当天前端状态；`(shop_id, calculation_status, original_occurred_at)` 用于管理筛选。业务日期若因时间调整跨日，前端状态使用 effective 时间重新归属；正式工时使用 confirmed 时间，不能机械沿用 original_local_date。

没有唯一约束 `(worker_id, local_date, sign_type)`，同一天允许多次签到。首次签到的识别范围及并发/离线冲突仍待确认，不能先按门店或日期建立不正确的唯一约束。定位结果保存后不因门店坐标变化重算；离线坐标版本策略尚待确认。

## 12. attendance_adjustments：时间调整

每行是一次申请或 manager 调整。必须保留修改前后值，不能就地改写旧申请。原始记录不删除；DELETE 是逻辑删除申请。

| 字段 | 类型 | 约束/用途 |
| --- | --- | --- |
| id | uuid | 主键 |
| record_id | uuid | 非空外键至 attendance_records |
| api_operation_id | uuid | 可空外键至 api_operations；迟到自动调整共用签到操作 |
| source | varchar(30) | WORKER_EDIT / PLANNED_START / MANAGER_EDIT |
| action | varchar(10) | ADD / UPDATE / DELETE |
| actor_account_id | uuid | 非空外键至 accounts；自动计划调整记录签到提交账号 |
| base_record_version | integer | 申请基于的记录版本，正数 |
| before_occurred_at | timestamptz | ADD 可空；其他操作保存提交时有效时间 |
| after_occurred_at | timestamptz | ADD / UPDATE 必填；DELETE 为空 |
| before_deleted | boolean | 修改前有效删除状态 |
| after_deleted | boolean | DELETE 为 true，ADD / UPDATE 为 false |
| status | varchar(20) | PENDING / APPROVED / REJECTED；SUPERSEDED 用于明确解决被替代申请后，不自动按最后修改设置 |
| created_at | timestamptz | 非空 |

CHECK：PLANNED_START 必须为 UPDATE，目标是首次 SIGN_IN，after 时间等于该记录 planned_start_at；后两项属于跨表规则，需要事务或触发器校验。MANAGER_EDIT 可用于 manager 管辖门店内任何签到/签退时间记录，包括正常及已确认记录；必须保留审计和对应确认历史，不覆盖原始记录。

ADD 在同事务创建 MANUAL_ADD 记录及 ADD 调整；UPDATE / DELETE 不允许修改工作人员、门店及类型。当前申请不要求原因字段。记录变更、version 增长、调整写入、api_operations 及审计在同事务保存。

索引 `(record_id, created_at, id)` 及 `(status, created_at, id)`；计划时间自动调整可设部分唯一索引 `(record_id) WHERE source='PLANNED_START'`，避免重复生成同一原始签到的自动调整。人工多次申请保留历史，不添加“每条记录只能一个调整”的业务限制。

effective 投影表示员工当前提出的状态；confirmed 投影仅根据明确的验证决定更新。多次调整共存时验证必须针对具体 adjustment_id 和记录当前版本，不能自动按最后修改或 actor 身份决定正式优先级。

## 13. attendance_validations：验证历史

每行是对一项调整的明确决策，包含当时申请和正式结果快照。验证记录只追加，不能修改旧验证结果。

| 字段 | 类型 | 约束/用途 |
| --- | --- | --- |
| id | uuid | 主键 |
| adjustment_id | uuid | 非空外键至 attendance_adjustments |
| validated_by_account_id | uuid | 非空外键至 accounts，仅授权 MANAGER / SUPER_MANAGER |
| api_operation_id | uuid | 非空、唯一外键至 api_operations |
| decision | varchar(20) | APPROVE / REJECT；拒绝保留正式值，错误未修正则继续待处理 |
| expected_record_version | integer | 请求携带的乐观锁版本 |
| resulting_record_version | integer | 成功确认后的新版本 |
| proposed_occurred_at | timestamptz | 被确认调整的申请时间；DELETE 可空 |
| proposed_deleted | boolean | 被确认的申请删除状态 |
| previous_confirmed_at | timestamptz | 验证前正式时间，可空 |
| previous_confirmed_deleted | boolean | 验证前正式删除状态 |
| resulting_confirmed_at | timestamptz | 验证后正式时间，新增/修改批准时必填 |
| resulting_confirmed_deleted | boolean | DELETE 批准时为 true |
| validated_at | timestamptz | 服务端验证时间 |

索引 `(adjustment_id, validated_at, id)`、`(validated_by_account_id, validated_at)`。当前一次申请只允许一次终结决定，可加 UNIQUE(adjustment_id)；需要重新申请时创建新调整而非改旧决策。被撤销或重做的验证若将来支持，应另行设计关联事件，不能直接覆盖本行。

批准流程在同事务锁定目标记录和调整：重新检查授权门店、状态和 expected_record_version，保存快照，将调整置 APPROVED，更新 confirmed 投影及 version，再重建受影响时段。仍有未解决相关调整时保持 PENDING，不仅因一项获批就将所有工时确认。已终结调整再次提交不同决策返回冲突；同一 operationId 重试返回原结果。

迟到调整批准时 resulting_confirmed_at 为计划上班时间。DELETE 的正式删除不清除原时间、照片和历史。批准较早申请与后续申请冲突时拒绝自动覆盖，要求重新查询并明确处理；REJECT 保留原正式值和拒绝历史，无其他冲突调整时 effective 回到正式投影；正式值不符合规则则仍待处理，须 manager 手动修正。

## 14. work_segments：工时时段

每行表示一个可追踪的 Sign In / Sign Out 配对候选及其计算结果，是可重建的统计投影，不替代原始记录。以明确的一对记录计算，不直接汇总所有签到时间戳。

| 字段 | 类型 | 约束/用途 |
| --- | --- | --- |
| id | uuid | 主键 |
| worker_id | uuid | 非空外键至 workers |
| shop_id | uuid | 非空外键至 shops |
| sign_in_record_id | uuid | 可空外键至 attendance_records |
| sign_out_record_id | uuid | 可空外键至 attendance_records |
| start_at / end_at | timestamptz | 正式计算时间快照，可空 |
| start_record_version / end_record_version | integer | 对应记录的版本，可空 |
| duration_minutes | numeric | 仅 CONFIRMED 填写，非负；精确时间差除以 60 秒，保留小数分钟 |
| hrs | numeric(6,2) | 仅 CONFIRMED 填写，ROUND(duration_minutes / 60, 2)，非负 |
| status | varchar(20) | CONFIRMED / PENDING / INVALID / SUPERSEDED |
| issue_codes | jsonb | 缺失签到/签退、时间倒置、重叠、待验证等原因码列表 |
| calculation_revision | bigint | worker/shop 范围重建版本，正数 |
| calculated_at | timestamptz | 计算时间 |
| superseded_at | timestamptz | 已被新配对替代时填写 |

CHECK：至少关联一条签到或签退；CONFIRMED 要求完整配对及 start_at <= end_at，duration_minutes 和 hrs 非空，开始和结束对应同一个 Auckland 日期；PENDING / INVALID 不保存冒充正式结果的 hrs。若批准删除导致配对失效，旧时段标 SUPERSEDED，重新生成候选和异常，不保留在当前合计。

跨表校验两条记录属于同一工作人员及门店，类型分别为 SIGN_IN / SIGN_OUT，正式结果未删除。精确时间差除以 60 秒得到 duration_minutes，再按十进制四舍五入得到两位小数 hrs，不先舍入分钟。API 返回两位小数字符串。

为避免一条记录重复计薪，对未 SUPERSEDED 时段分别建立 sign_in_record_id 和 sign_out_record_id 的非空部分唯一索引。索引 `(shop_id, worker_id, start_at)` 和 `(shop_id, status)` 用于统计与异常查询。

重建使用事务锁或 worker/shop 范围锁，读取一致的记录及验证状态，替代旧投影后再发布新 revision，避免查询读到半完成结果。不同配对导致的旧行标 SUPERSEDED，报告 PDF 另保存自己的数据快照，不能依赖可变投影重现历史报告。

同一天多个有效时段分别计算并保存两位小数 hrs，再汇总；待验证、不闭合或异常时段排除于 confirmedHrs，并单独返回计数。跨午夜时段标 INVALID、issue_codes 包含 CROSS_MIDNIGHT，必须 manager 修正并确认；不生成午夜假签退。跨门店配对禁止；未闭合记录交其所属门店 manager 处理。

## 15. 四表协作示例

实际点击 09:10、计划 09:00、17:00 签退：

1. attendance_records 保存原始 09:10 和计划 09:00；后台收到时间另存。
2. attendance_adjustments 创建 PLANNED_START：09:10 → 09:00，状态 PENDING。
3. 前端有效时间采用待验证调整值，但原始记录保持不变；work_segments 为 PENDING，正式 hrs 为空。
4. Manager 批准后 attendance_validations 保存验证前后正式值和版本，将正式开始时间确认至 09:00。
5. 没有其他待验证或异常时，work_segments 以 09:00–17:00 计算 hrs=8，纳入已确认统计。

以上时间为 Auckland 当地时间示例，实际存储使用 timestamptz。设计中的待定项不作为已实现能力；下一步确定未解决业务规则和运行配置，再生成迁移。

## 16. 已补充的计算与处理规则

### 拒绝验证、错误签退及工时精度

Manager 拒绝调整时保留原始记录和拒绝历史；若既有正式记录符合规则且没有其他未解决问题，可维持原正式结果并重新计算。否则保持错误/待处理状态，由 manager 手动修改并确认，不能把“拒绝”自动当作数据已正确。拒绝后前端有效投影回到可用的正式记录；存在后续冲突调整时返回版本冲突，先明确处理，不能静默覆盖。

不允许跨午夜工时时段。Sign Out 必须处于 Sign In 对应的同一个 Auckland 当地日期；下一日 00:00 起视为跨日，标记 CROSS_MIDNIGHT 错误并进入 manager 验证队列。原始签退仍需保存，不能丢弃、截断为午夜或自动计薪。午夜状态重置不消除该错误；迟到达的离线请求按原操作时间判断。异常数据只有经 manager 修正为符合规则的同日时段并确认后，才能计入工时；仅点击批准不能豁免同日约束。

每个有效时段的分钟数为实际时间差除以 60 秒，保留秒和亚秒带来的小数分钟，不先截断或取整分钟。`hrs = ROUND(duration_minutes / 60, 2)`，采用十进制四舍五入，保存两位小数。同日多时段汇总已保存的时段 hrs，确保明细与合计一致；该舍入及汇总方式为实现约定。例：485 分钟 / 60 = 8.0833…，记录 8.08；490 分钟记录 8.17。API 使用字符串如 `"8.08"` 表示小时数，避免二进制浮点误差并保留两位小数。

错误记录建议在 attendance_records 增加 issue_codes（jsonb，默认空数组）及 resolution_status（CLEAR / OPEN / RESOLVED），并在 work_segments 使用同样错误码。这与调整的 PENDING 分开，拒绝一项调整不等于解决原记录异常。

Manager 直接修正使用 MANAGER_EDIT 调整及对应验证历史，同事务更新正式结果、关闭已解决异常并重算工时。若错误记录没有调整，验证队列需同时查询 OPEN 异常记录，不仅查询 PENDING 调整。跨日签退不能为了避开配对直接当作次日孤立数据忽略，须保留关联候选或缺失配对异常。

## 17. Manager 对任意记录的时间调整

Manager 的时间调整不以错误、待验证或未确认为前提，仅以当前门店管理权限为边界。每次操作在事务中锁定并检查记录版本，追加 attendance_adjustments（MANAGER_EDIT）及 attendance_validations，更新正式计算时间并重建受影响工时时段；不更新 attendance_records.original_occurred_at、原始计划时间及其他原始提交内容。有效投影有其他未解决申请时执行冲突检查，不能凭 manager 身份静默覆盖申请。原始记录、历次修改、验证和旧报告快照均保留。

## 18. 月度查询及统计

Manager 网站统一用月份查询，每月 Auckland 1 日 00:00 至下月 1 日 00:00 为半开区间，自动处理闰年和夏令时。原始时间不因月度筛选改写；记录列表按 effective 时间、正式时段按 start_at 查询，调整历史保留跨月来源。现有按 shop/worker/time 建立的索引支持查询，不需要新增月度合计表。report_exports 保存 month、时区、实际查询边界及数据快照，保证 PDF 与同条件月度统计可核对。工时合计取完整月份，而非某一分页；待验证和错误单独展示。

## 19. 单一门店闭合与验证归属

不允许跨门店 Sign In / Sign Out 配对。每个工作人员在单一门店内完成签到和签退闭合；其他门店的 Sign Out 不能关闭本店的 Sign In，也不能跨店计算工时。未闭合记录标记为错误/待处理，提交该记录所属门店的 manager 验证；不能转交另一个门店的 manager。按工作人员及门店分别识别配对，保留原始记录，不自动补签到或签退。

存在未闭合 Sign In 时不能仅因刚收到签到就认定错误（正常在岗也暂时未签退）。闭合检查在出现无法合法配对的事件、工作人员转到另一门店签到或 Auckland 当天结束时触发；当天结束仍未签退则进入原店验证队列。另一门店的孤立 Sign Out 进入该签退所属门店的队列，不借用其他店的 Sign In。跨店新签到是否应被阻止仍需另行明确，不能以此规则擅自丢弃实际操作记录。
work_segments 两端必须满足相同 worker_id 和 shop_id，不能通过 manager 批准豁免同店约束。缺失端保持为空并标为待处理异常；新的合法配对或 manager 修正后重新校验。原始记录的 shop_id 不可修改，异常记录通过其所属 shop_id 关联 account_shops 分发，不需要单独保存某个 manager ID，避免门店 manager 更换后遗留任务无人可见。

验证队列覆盖 attendance_records 的 OPEN 异常和未解决调整，不仅依赖 adjustment 行。工作人员在另一店签到时检查其其他门店未闭合记录，检查可用于后台识别异常，但响应不能向当前店 manager 泄露其他店详情。月底或午夜检查需可重试、去重，不能因同步延迟永久漏掉未闭合异常；原店的迟到离线签退到达后重算并保留处理历史。

## 20. sessions：登录会话

App 与 manager 网站共用可撤销的服务端会话；令牌本身只在登录响应中交给客户端，数据库存哈希。

| 字段 | 类型 | 约束/用途 |
| --- | --- | --- |
| id | uuid | 主键 |
| account_id | uuid | 非空外键至 accounts |
| token_hash | text | 非空、唯一，足够随机的会话令牌经 SHA-256 等安全摘要后的值 |
| client_type | varchar(20) | APP / MANAGER_WEB，不能作为权限依据 |
| created_at | timestamptz | 服务端创建时间 |
| expires_at | timestamptz | 非空，必须晚于 created_at |
| last_seen_at | timestamptz | 可空，按需节流更新，非延长有效期的依据 |
| revoked_at | timestamptz | 可空，退出或管理撤销时设置 |
| revoke_reason | varchar(30) | 可空，LOGOUT / PASSWORD_CHANGED / ACCOUNT_DISABLED / ADMIN_REVOKED |

CHECK：revoked_at 与 revoke_reason 同时存在或同时为空。索引 token_hash 唯一索引、`(account_id, expires_at)` 和 expires_at（清理过期会话）。会话验证每次检查令牌匹配、未撤销、未过期、账号 ACTIVE，以及当前权限；不能相信会话创建时缓存的旧门店授权。

密码修改/重置与全部会话撤销同事务；账号停用立即使会话无效。会话到期必须重新登录，具体有效期在配置中明确后实现；当前未设计 refresh token 表或无限滑动续期。SHOP 登录会话绑定其账号，由 shops.account_id 获取门店，不允许请求体切换绑定；换店需按既有密码验证及重新登录流程执行。

会话令牌不得进入 URL、审计、日志或邮件。网站若改用 HttpOnly cookie，需要同步定义 Secure、SameSite 和 CSRF 防护，不能仅把 Bearer 换成 cookie 而保持原安全假设。

## 21. password_links：首次激活及密码重置

邀请注册即后台预建账号后发 FIRST_SETUP 链接，不开放创建账号的公开入口。

| 字段 | 类型 | 约束/用途 |
| --- | --- | --- |
| id | uuid | 主键，作为 invitationId 返回时不泄露令牌 |
| account_id | uuid | 非空外键至 accounts，绑定具体账号而非邮箱推测 |
| purpose | varchar(20) | FIRST_SETUP / PASSWORD_RESET |
| token_hash | text | 非空、唯一，仅存安全随机令牌的哈希 |
| requested_by_account_id | uuid | 可空外键至 accounts，管理员或本人；公开找回请求可空 |
| api_operation_id | uuid | 可空外键至 api_operations；管理创建/重发操作关联 |
| created_at | timestamptz | 非空 |
| expires_at | timestamptz | 非空，自创建/首次发送起七天；后台发送重试不延长 |
| used_at | timestamptz | 可空，成功消费时间 |
| revoked_at | timestamptz | 可空，重发作废旧链接等 |
| revoke_reason | varchar(30) | 可空，REISSUED / PASSWORD_CHANGED / ACCOUNT_DISABLED / ADMIN_REVOKED |

CHECK：expires_at > created_at；已 used 的链接不再接受撤销操作，重发不能清除 used_at。可用状态由未使用、未撤销、未过期计算，不另外存易失同步的 ACTIVE 状态。

索引 token_hash 唯一索引、`(account_id, purpose, created_at)`、expires_at。对 `(account_id, purpose)` 建立 `WHERE used_at IS NULL AND revoked_at IS NULL` 的部分唯一索引；生成新链接前先撤销已有未消费链接（包含已过期行），不能在部分索引中依赖 NOW()。

消费事务锁定链接，检查用途、期限和账号状态，验证 FIRST_SETUP 对应 PENDING，PASSWORD_RESET 对应可重置的已激活账号；写安全密码哈希、设置 used_at、首次 activated_at、撤销其他未使用链接和所有会话，同事务完成。并发消费最多一次成功。SHOP 不生成邮件密码链接；MANAGER 和 WORKER 共用邮箱时也必须分别绑定账号和目的。

为了邮件重试，原始令牌不能保存在本表。服务端生成令牌后，将必要发送载荷加密保存于 email_jobs 的短期受限字段；消费后或发送任务终结时清理该字段。原始令牌不能在管理 API 或审计中返回。七天有效期建议从首次入队时间计起，即本表 created_at，防止每次重试重新延长；邮件长期未发送时明确失败，重发需新链接。

## 22. photos：自拍文件元数据

照片文件存私有对象存储，数据库保存位置及验证后的元数据，不存图片二进制或永久公开 URL。

| 字段 | 类型 | 约束/用途 |
| --- | --- | --- |
| id | uuid | 主键 |
| uploaded_by_account_id | uuid | 非空外键至 accounts |
| api_operation_id | uuid | 非空、唯一外键至 api_operations |
| storage_key | text | 非空、唯一，服务端生成，不接受客户端任意对象路径 |
| status | varchar(20) | UPLOADING / READY / FAILED / DELETED |
| media_type | varchar(50) | 实际解码验证的图片类型；最终支持格式实现时配置 |
| byte_size | bigint | 非负，READY 必填 |
| width / height | integer | 正数，READY 必填 |
| content_sha256 | text | 文件校验摘要，READY 必填；不作为跨用户去重授权依据 |
| created_at / completed_at | timestamptz | 上传创建及成功完成时间 |
| expires_at | timestamptz | 未关联文件的清理期限，可空 |
| deleted_at | timestamptz | 文件清理时间，可空，保留元数据及审计 |
| error_code | varchar(60) | 可空，脱敏上传错误码 |

照片与签到通过 attendance_records.photo_id 关联；建议对其非空 photo_id 建唯一索引，一张自拍只能关联一次实际操作，重复请求由幂等机制复用原记录。只有 READY 且上传身份、门店/个人权限符合的照片才能绑定。MANUAL_ADD 或相机不可用的记录不绑定照片。

索引 `(uploaded_by_account_id, created_at)`、`(status, expires_at)`。签名下载链接每次授权后临时生成，不保存长期 URL；历史照片查看必须通过关联签到的当前查询权限，不能仅检查上传者。

上传与数据库不是一个原子系统：先建立受控上传资源，成功验证并存储后置 READY；失败保留可重试状态，同 operationId 重试不重复创建逻辑照片。使用与 photoId 关联的固定私有对象键或受控版本，处理上传成功但数据库更新失败的恢复。清理未关联照片前锁定/标记资源，绑定同时检查状态，避免上传清理与签到关联竞争。

已关联照片只按明确的保留政策删除文件，不能级联删除签到。删除后返回明确不可用状态，保留原 camera_status=AVAILABLE（拍摄时的事实），不将历史改写为当时相机不可用。大小、图片格式、未关联超时及已关联保留周期仍需在实现配置中确定。

## 23. email_jobs：可靠邮件发送队列

小规模使用 PostgreSQL outbox 和后台 worker，不需要为 20 人先引入独立消息队列。数据库事务只保存待发送任务，网络发送在事务之外执行。

| 字段 | 类型 | 约束/用途 |
| --- | --- | --- |
| id | uuid | 主键 |
| account_id | uuid | 可空外键至 accounts，收件账号 |
| password_link_id | uuid | 可空外键至 password_links，邀请/重置任务必填 |
| report_export_id | uuid | 可空外键至 report_exports，Timesheet 邮件可关联 |
| email_type | varchar(30) | FIRST_SETUP / PASSWORD_RESET / TIMESHEET |
| recipient_email | text | 非空，发送时使用的地址快照 |
| template_key / template_version | text | 非空，受控邮件模板及版本 |
| template_data | jsonb | 非秘密参数，如显示姓名和月份；不存原始令牌 |
| encrypted_secret_payload | bytea | 可空，仅邀请令牌等必要短期发送数据，使用认证加密 |
| encryption_key_id | text | 可空，加密密钥版本；密钥不存数据库、仓库或此文档 |
| dedupe_key | text | 非空、唯一，逻辑发送任务去重键 |
| status | varchar(20) | QUEUED / PROCESSING / SENT / FAILED / CANCELLED |
| attempt_count | integer | 非负，初始 0 |
| max_attempts | integer | 正数，具体次数为运行配置 |
| next_attempt_at | timestamptz | 下一次允许发送时间 |
| lease_owner | text | 可空，领取任务的 worker 标识 |
| lease_expires_at | timestamptz | 可空，崩溃恢复租约 |
| provider_message_id | text | 可空，邮件服务返回标识 |
| sent_at | timestamptz | 服务商确认受理的时间，不表示收件箱已送达 |
| last_error_code | varchar(60) | 可空，脱敏错误码，不保存包含链接的原始响应 |
| created_at / updated_at | timestamptz | 非空 |

CHECK：PROCESSING 要求 lease_owner/lease_expires_at；SENT 要求 sent_at；秘密载荷与 key_id 成对存在。邀请与重置类型必须有 password_link_id，Timesheet 不附密码链接。索引 `(status, next_attempt_at)`、lease_expires_at、`(account_id, created_at)`。

创建账号/链接和 email_jobs 在同事务入队，接口返回 QUEUED。worker 用 `FOR UPDATE SKIP LOCKED` 领取到期任务、写租约后提交，再执行发送；失败指数退避，达到上限置 FAILED，明确展示状态。租约到期可重新领取，避免 worker 崩溃永久卡住任务。

发送前重新检查链接未撤销、未使用且未过期，并确认账号及收件邮箱仍适用；旧邀请作废时取消尚未发送任务。重发创建新链接和新任务，原有 dedupe_key 不复用；同一创建/重发 API 重试不创建多份任务。

网络邮件无法与数据库保证严格“恰好发送一次”：若服务商已受理但进程未保存结果，重试可能重复邮件。优先使用服务商支持的幂等键和 message ID；否则保证重复邮件使用同一邀请及单次令牌，不虚称绝无重复发送。SENT 后清除秘密载荷，FAILED/CANCELLED/过期也按短期政策清除；仅允许 worker 访问加密载荷，管理 API 仅返回发送状态。

加密密钥、发信地址、邮件服务凭证及邀请网站 URL 是部署配置，不是数据库默认值，不在文档中放秘密。Timesheet 定期发信周期仍待确认，数据库预留类型不代表已经启用发送。

## 24. 设计完成状态

15 张表均已细化用途、字段、关联及关键约束；尚未生成 Prisma schema、SQL 迁移或运行数据库。落地前需确定：人员跨店铺归属、跨店新签到的提交行为、多个调整冲突处理、会话期限及照片/报告/队列的保留配置。

数据库验证应覆盖：邀请并发只能消费一次、密码变更撤销所有会话、幂等请求不重复创建签到、上传与清理竞争不产生失效关联、邮件 worker 崩溃可恢复，以及 manager 操作在撤销店铺授权后被拒绝。上述为待实现验收项，本次仅检查文档格式及内部链接，未执行数据库测试。

## 25. 已确认的工作人员 ID 规则

accounts.login_code 建立非空全局唯一索引，停用账号同样参与唯一约束；WORKER 范围 1000–9999。workers.account_id 与对应账号保持一对一，调店仅改变 account_shops，不创建新的工作人员身份、不更换 login_code。账号和工作人员不直接删除或释放编号，历史始终引用稳定的内部 UUID。

## 26. 已确认的邮箱唯一性

后台索引：`UNIQUE(lower(email)) WHERE role IN ('MANAGER', 'SUPER_MANAGER', 'IT') AND email IS NOT NULL`；工作人员索引：`UNIQUE(lower(email)) WHERE role = 'WORKER' AND email IS NOT NULL`。停用账号仍保留唯一性，不释放邮箱供另一同命名空间账号使用；如需更换邮箱须走授权更新流程，不能更改历史邀请的目标账号。跨后台与工作人员的同邮箱不会合并账号。
