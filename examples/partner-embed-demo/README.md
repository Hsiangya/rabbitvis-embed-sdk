# RabbitVis Partner Embed Demo

这是一个零第三方依赖的模拟合作方系统，用于本地联调 RabbitVis Hosted Embed。

它同时扮演三个角色：

1. 合作方页面：模拟用户登录，并以 ESM 方式调用真实 `mountRabbitVisEmbed` 挂载 RabbitVis iframe。
2. 合作方 BFF：根据服务端登录 Session 选择 `externalUserId`，调用 RabbitVis 创建 Embed Session。
3. 合作方 Billing：自行维护合作方积分、剩余次数、预占和最终结算；余额只展示在合作方页面，iframe 内不展示。

RabbitVis Partner Key、Billing 签名密钥和合作方用户 ID 都不会下发到浏览器。

## 启动

需要 Node.js 20 或更高版本，不需要执行 `npm install`。

```bash
cd examples/partner-embed-demo

export RABBITVIS_API_BASE_URL=http://127.0.0.1:3001
export RABBITVIS_PARTNER_ID=partner_demo
export RABBITVIS_PARTNER_API_KEY='<RabbitVis 分配的 Partner Key>'
export RABBITVIS_BILLING_SIGNING_SECRET='<双方约定的随机签名密钥>'
export RABBITVIS_EMBED_ORIGIN=http://127.0.0.1:5174

npm start
```

打开：

- `http://127.0.0.1:4180/login?user=alice`
- `http://127.0.0.1:4180/login?user=bob`

进程重启后模拟登录、余额、预占和事件都会清空。

## SDK 配置

Demo 默认从本仓库的 `sdk/dist` 读取构建产物（先在 `sdk/` 里 `npm install && npm run build`），并在
`/assets/rabbitvis-embed-sdk/` 下同源提供 `index.js`、`protocol.js`、
`session-provider.js` 等 ESM 模块。也可以显式选择下面一种方式：

```bash
# 推荐：真实 @rabbitvis/embed-sdk 的 dist 目录
export RABBITVIS_EMBED_SDK_DIR=/absolute/path/to/rabbitvis-embed-sdk/sdk/dist

# 或：支持跨域 ESM/CORS 的浏览器可访问入口
export RABBITVIS_EMBED_SDK_URL=https://cdn.partner.example/rabbitvis-embed-sdk/index.js
```

两项不能同时设置。页面没有自制 iframe fallback：它只调用正式 SDK，并传入
`HTMLElement container`、`rabbitVisOrigin` 和同源 `sessionEndpoint`。SDK 负责校验
`embedUrl`、追加 `instanceId` / `parentOrigin`、过滤 `postMessage`，以及在会话过期时
重新请求合作方的 Session Endpoint。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `PORT` / `PARTNER_DEMO_PORT` | `4180` | Demo HTTP 端口 |
| `HOST` / `PARTNER_DEMO_HOST` | `127.0.0.1` | 监听地址 |
| `PARTNER_DEMO_PUBLIC_ORIGIN` | 根据监听地址生成 | 对外 Origin；经反向代理时必须显式填写 |
| `RABBITVIS_API_BASE_URL` | `http://127.0.0.1:3001` | RabbitVis API 地址 |
| `RABBITVIS_PARTNER_ID` | `partner_demo` | Partner 标识 |
| `RABBITVIS_PARTNER_API_KEY` | 必填 | 只供合作方 BFF 调用 RabbitVis |
| `RABBITVIS_TENANT_ID` | `tenant_demo` | 模拟 Tenant |
| `RABBITVIS_EXTERNAL_PROJECT_PREFIX` | `demo_project` | 服务端生成外部项目 ID 的前缀 |
| `RABBITVIS_EMBED_SCOPES` | `session:read,run:create` | 申请的 Embed Scope |
| `RABBITVIS_EMBED_ORIGIN` | `http://127.0.0.1:5174` | CSP 和 `postMessage` 校验使用的 Embed Origin |
| `RABBITVIS_EMBED_SDK_DIR` | 本仓库的 `sdk/dist` | 本地 ESM SDK 构建目录；Demo 安全地同源提供其中的 JS 模块 |
| `RABBITVIS_EMBED_SDK_URL` | 空 | 跨域 ESM SDK 入口；设置时不能再设置 `RABBITVIS_EMBED_SDK_DIR` |
| `RABBITVIS_BILLING_SIGNING_SECRET` | 必填 | RabbitVis 调用 Billing API 的 HMAC 密钥 |
| `RABBITVIS_SIGNATURE_TOLERANCE_SECONDS` | `300` | 回调重放时间窗 |
| `RABBITVIS_REQUEST_TIMEOUT_MS` | `5000` | BFF 调用 RabbitVis 的超时 |
| `PARTNER_DEMO_INITIAL_POINTS` | `100` | 每个模拟用户的合作方积分 |
| `PARTNER_DEMO_INITIAL_USES` | `10` | 每个模拟用户的可用次数 |
| `PARTNER_DEMO_POINTS_PER_OPERATION` | `5` | Demo 自己定义的单次预占积分 |
| `PARTNER_DEMO_CHARGE_FAILED_OPERATIONS` | `0` | `1` 表示失败操作也消耗合作方预占 |
| `PARTNER_DEMO_CONTROL_TOKEN` | 空 | 设置后启用只供 E2E 使用的状态/故障控制 API |
| `PARTNER_DEMO_COOKIE_SECURE` | `0` | HTTPS 环境设为 `1` |

建议使用随机值：

```bash
openssl rand -hex 32
```

不要把任何真实密钥写入仓库、前端配置或浏览器 URL。

## Embed Session 接口

浏览器只调用合作方同源接口：

```http
POST /api/rabbitvis/embed-session
Content-Type: application/json
Cookie: partner_demo_session=<opaque-session>
Origin: <partner-demo-origin>
```

请求体中的身份字段会被忽略。这个接口只接受与合作方页面完全一致的 `Origin`，这就是它的 CSRF 防护；接入自己的系统时必须保留同等校验（或 CSRF token）。Demo 从 HttpOnly Session Cookie 找到当前用户，再由服务端调用：

```http
POST <RABBITVIS_API_BASE_URL>/v1/partner/embed-sessions
Authorization: Bearer <RABBITVIS_PARTNER_API_KEY>
Idempotency-Key: demo_embed_...
X-RabbitVis-Partner-Id: partner_demo
```

```json
{
  "tenantId": "tenant_demo",
  "externalUserId": "demo_user_alice",
  "externalProjectId": "demo_project_alice",
  "billingSubjectRef": "demo_billing_alice",
  "origin": "http://127.0.0.1:4180",
  "scopes": ["session:read", "run:create"]
}
```

## Billing 协议

两个地址固定为：

```text
POST /rabbitvis/billing/authorize
POST /rabbitvis/billing/finalize
```

RabbitVis 每次请求都需要发送：

```text
Content-Type: application/json; charset=utf-8
Accept: application/json
Accept-Encoding: identity
Idempotency-Key: <requestId | operationId | eventId>
X-RabbitVis-Contract: partner-billing-v1
X-RabbitVis-Partner-Id: partner_demo
X-RabbitVis-Timestamp: <ISO 8601 timestamp>
X-RabbitVis-Nonce: <unique nonce>
X-RabbitVis-Body-SHA256: <hex sha256 of the exact JSON body bytes>
X-RabbitVis-Signature: v1=<base64url hmac sha256>
```

签名原文严格为：

```text
v1
POST
<path+query>
<timestamp>
<nonce>
<idempotency-key>
<body-sha256>
```

校验签名时除了比对 HMAC，还必须：

- 拒绝 `X-RabbitVis-Timestamp` 与本地时间偏差超过 `RABBITVIS_SIGNATURE_TOLERANCE_SECONDS` 的请求，返回 `401 signature_expired`；
- 在该时间窗内记住已使用过的 `X-RabbitVis-Nonce`，重复出现返回 `401 nonce_replayed`。Demo 用进程内 Map 实现，多实例部署要换成共享存储；
- RabbitVis 的 outbox 重试每次都带新的 nonce，业务去重只能依赖 `Idempotency-Key`（AUTHORIZE 是 `operationId`，FINALIZE 是 `eventId`）。

### AUTHORIZE

```json
{
  "schemaVersion": "1",
  "operationId": "op_xxx",
  "partnerId": "partner_demo",
  "tenantId": "tenant_demo",
  "billingSubjectRef": "demo_billing_alice",
  "sessionId": "sess_xxx",
  "turnId": "turn_xxx",
  "operation": "run",
  "estimate": {
    "operation": "run",
    "rabbitvisUsageUnits": null
  }
}
```

允许时：

```json
{
  "schemaVersion": "1",
  "decision": "allow",
  "authorizationId": "authz_demo_xxx"
}
```

拒绝时返回 `decision: "deny"`。相同 `operationId` 和相同输入始终返回第一次结果，不会重复预占；相同 `operationId` 配上不同操作会返回 `409 operation_idempotency_conflict`。

### FINALIZE

```json
{
  "schemaVersion": "1",
  "eventId": "evt_xxx",
  "operationId": "op_xxx",
  "partnerId": "partner_demo",
  "tenantId": "tenant_demo",
  "billingSubjectRef": "demo_billing_alice",
  "sessionId": "sess_xxx",
  "turnId": "turn_xxx",
  "kind": "FINALIZE",
  "authorizationId": "authz_demo_xxx",
  "outcome": "succeeded",
  "actualUsage": {
    "rabbitvisUsageUnits": 18
  },
  "occurredAt": "2026-09-01T00:00:00.000Z"
}
```

成功响应只使用这一套形状：

```json
{
  "schemaVersion": "1",
  "accepted": true,
  "eventId": "evt_xxx"
}
```

`rabbitvisUsageUnits` 只是 RabbitVis 报告的内部用量事实，不是合作方用户积分，也不决定 Demo 的扣费金额。Demo 当前策略是每个获批操作固定预占 `PARTNER_DEMO_POINTS_PER_OPERATION` 个合作方积分和一次使用次数。

相同 `eventId` 和相同输入始终返回第一次结算结果。即使第一次处理成功后连接中断，RabbitVis 重试也不会造成重复扣费。

默认策略中，`FINALIZE + succeeded` 确认消耗预占；`failed` 和 `cancelled` 释放预占。`RELEASE` 必须携带零用量并始终释放预占。合作方可通过 `PARTNER_DEMO_CHARGE_FAILED_OPERATIONS=1` 展示另一种自有策略。

Demo 顶部的余额来自合作方自己的 `GET /api/partner-balance`，只用于演示“合作方页面自行展示余额”。SDK 收到 `run.settled` 后由合作方页面刷新该接口；这个接口不是 RabbitVis Embed 契约，RabbitVis 和 iframe 都不会调用它。

## E2E 状态与故障注入

只有设置 `PARTNER_DEMO_CONTROL_TOKEN` 后以下 API 才存在，并且都要求：

```text
Authorization: Bearer <PARTNER_DEMO_CONTROL_TOKEN>
```

查询当前余额、Reservation、Finalize 和事件：

```bash
curl -H "Authorization: Bearer $PARTNER_DEMO_CONTROL_TOKEN" \
  http://127.0.0.1:4180/__demo/state
```

注入一次“AUTHORIZE 已经预占成功，但连接在返回前断开”：

```bash
curl -X POST \
  -H "Authorization: Bearer $PARTNER_DEMO_CONTROL_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"action":"authorize","mode":"commit_then_drop","times":1}' \
  http://127.0.0.1:4180/__demo/faults
```

支持的 Action：`authorize`、`finalize`。

支持的 Mode：

- `deny`：AUTHORIZE 返回业务拒绝，不创建有效预占。
- `500`：处理前返回 500。
- `timeout`：处理前延迟，再返回 504。
- `commit_then_drop`：先持久化内存状态，再主动断开连接，用于验证幂等重试。
- `none`：清除指定 Action 的故障。

重置余额、Reservation、Finalize、事件和故障：

```bash
curl -X POST \
  -H "Authorization: Bearer $PARTNER_DEMO_CONTROL_TOKEN" \
  http://127.0.0.1:4180/__demo/reset
```

这些控制接口仅供本地和 E2E，未配置 Token 时返回 404。状态输出不会包含 Partner Key、Billing 签名密钥或浏览器 Session Token。

## 测试

```bash
cd examples/partner-embed-demo
npm test
```

测试覆盖：

- 页面按真实 ESM 契约调用 `mountRabbitVisEmbed`，且相对模块图可加载。
- 页面不再使用会遗漏 `instanceId` / `parentOrigin` 的手写 iframe fallback。
- 浏览器不能伪造 `externalUserId` 和 `billingSubjectRef`。
- 余额 UI 位于合作方页面，iframe 内不包含余额协议或余额展示。
- Partner Key 与签名密钥不进入 HTML。
- Origin 校验。
- AUTHORIZE 预占和 operationId 幂等。
- FINALIZE 的 eventId 幂等和内部用量记录。
- 成功后断连接再重试不会重复扣费。
- deny、500、timeout 故障不产生有效预占。
- 缺失、错误和过期签名被拒绝。
