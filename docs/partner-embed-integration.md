# RabbitVis 合作方托管嵌入（Partner Hosted Embed）对接文档

> 版本：v1（协议 `partner-billing-v1`）· 更新：2026-09-04
> 读者：合作方（平台方）的后端与前端工程师
> 目标：把 RabbitVis 设计编辑器以 iframe 嵌入你们的平台，用户身份由你们的系统决定，每次生成/改图前由**你们**决定是否允许，用量由 RabbitVis 回调告知，费用由你们按自己的规则收取。

---

## 0. 整体流程（先看这张图）

```
你们的用户                你们的前端页面              你们的后端                     RabbitVis
   │                          │                          │                              │
   │ 打开页面                  │                          │                              │
   │─────────────────────────▶│                          │                              │
   │                          │ POST /你们的 embed-session 接口（带你们自己的登录态）      │
   │                          │─────────────────────────▶│                              │
   │                          │                          │ ① POST /v1/partner/embed-sessions
   │                          │                          │   （API Key + 外部用户/项目 id）│
   │                          │                          │─────────────────────────────▶│
   │                          │                          │◀──── 201 { embedUrl, ... } ───│
   │                          │◀──── { embedUrl } ───────│                              │
   │                          │ ② SDK 把 iframe 挂进页面（src = embedUrl）                 │
   │                          │═════════════════════════════════════════════════════════▶│
   │                          │                          │      iframe 内部：用 60 秒一次性 code 换 token
   │                          │◀──────── 事件 ready ─────┼──────────────────────────────│
   │                          │                          │                              │
   │ 输入提示词 / 点"放大"     │                          │                              │
   │─────────────────────────▶│                          │                              │
   │                          │                          │ ③ AUTHORIZE（确认接口，同步等你们回答）
   │                          │                          │◀─────────────────────────────│
   │                          │                          │── allow / deny ─────────────▶│
   │                          │◀──── 事件 run.started ───┼──────────────────────────────│
   │                          │                          │      （生成中……）             │
   │                          │◀──── 事件 run.settled ───┼──────────────────────────────│
   │                          │                          │ ④ FINALIZE / RELEASE（结算，异步，会重试）
   │                          │                          │◀─────────────────────────────│
   │                          │                          │── accepted ─────────────────▶│
   │                          │ 刷新你们自己的余额显示    │                              │
   │                          │                          │ ⑤（可选）GET /v1/partner/usage-events 对账
```

四个关键点：

1. **身份映射**：你们传 `tenantId + externalUserId`，RabbitVis 内部映射成一个普通用户；第一次调用自动创建，之后复用。用户在 iframe 里能看到并操作自己名下的所有项目。
2. **扣费前先问你们**：每一次会产生用量的操作（对话生成、以及扩图/放大/擦除/去背景/多角度/全景/文字编辑等直接改图动作），RabbitVis 都会**先同步调用你们的 AUTHORIZE 接口**，你们说 `allow` 才执行，说 `deny` 就拒绝。**这是你们唯一的、也是决定性的控费闸门。**
3. **不扣 RabbitVis 的积分**：合作方用户在 RabbitVis 这边不扣任何积分，只记录用量流水；钱怎么收、收多少，完全由你们在 AUTHORIZE / FINALIZE 里按自己的规则决定。iframe 里也**不显示**任何 RabbitVis 的价格或用量数字。
4. **结算是异步的**：操作结束后 RabbitVis 通过 FINALIZE（有实际用量）或 RELEASE（零用量，释放预占）告诉你们结果，失败会自动重试最多 16 次、跨度最长数小时。

---

## 1. 接入前准备

### 1.1 RabbitVis 会交付给你们的东西

| 名称 | 用途 | 保管要求 |
|---|---|---|
| `partnerId` | 你们在 RabbitVis 的合作方编号，回调请求头 `X-RabbitVis-Partner-Id` 的值 | 非机密 |
| `partnerApiKey` | 形如 `rvpk_<clientId>.<secret>`，调用 RabbitVis 合作方 API 时放在 `Authorization: Bearer` | **只能放在你们的后端**，绝不能进浏览器 |
| `billingSigningSecret` | HMAC-SHA256 密钥，用来**验证** RabbitVis 回调你们的请求是真的 | **只能放在你们的后端** |
| `allowedOrigins` | 允许嵌入 iframe 的你们页面的 Origin 白名单（精确到协议+域名+端口） | 有新域名要提前告知 RabbitVis 加白 |
| `billingTimeoutMs` | RabbitVis 等你们 AUTHORIZE/FINALIZE 回应的超时，默认 5000ms（范围 100–10000） | 你们的接口必须在这个时间内回应 |
| `maxConcurrentRuns` | RabbitVis 侧对你们的并发生成保护上限，默认 20 | 超过时用户会看到"并发已达上限"，稍后重试 |
| RabbitVis API 基址 | 由 RabbitVis 提供 | 联调与生产各一套 |
| RabbitVis 嵌入基址 | 由 RabbitVis 提供 | SDK 的 `rabbitVisOrigin` 填它的 origin |
| Embed SDK | `@rabbitvis/embed-sdk` 的构建产物（ESM） | 引入到你们的前端页面 |

### 1.2 你们需要提供给 RabbitVis 的东西

| 名称 | 说明 |
|---|---|
| 回调基址（HTTPS） | RabbitVis 会调用 `<你们的基址>/rabbitvis/billing/authorize` 和 `<你们的基址>/rabbitvis/billing/finalize`。**生产环境必须是公网可达的 HTTPS**，内网地址、http、带用户名密码的 URL 都会被 RabbitVis 拒绝，且 RabbitVis **不跟随重定向**。 |
| 页面 Origin 白名单 | 你们会嵌入 iframe 的所有页面的 origin，例如 `https://app.example.com`。 |
| 时钟同步 | 回调验签依赖时间戳（建议容忍 ±300 秒），请保证服务器 NTP 同步。 |

### 1.3 术语

| 术语 | 含义 |
|---|---|
| `tenantId` | 你们内部的租户/组织编号，和 `externalUserId` 一起决定用户身份 |
| `externalUserId` | 你们系统里的用户唯一 id。RabbitVis 只存它的 HMAC 哈希，**明文不落库、不进日志** |
| `externalProjectId` | 你们系统里的项目 id。同一个 (tenant, user, project) 永远映射到 RabbitVis 同一个项目 |
| `billingSubjectRef` | **计费主体**。回调里原样带回给你们，你们靠它找到"该扣谁的钱"。通常等于你们的用户 id 或账户 id |
| `sessionId` | RabbitVis 内部的项目/会话 id（`sess_...`），回调里会带，用于关联 |
| `turnId` | 一次操作的编号（`turn_...`）。SDK 事件、AUTHORIZE、FINALIZE 都带同一个值，是**前端事件和后端账单的对账钥匙** |
| `operationId` | 一次计费操作的编号（`puo_...`），AUTHORIZE 的幂等键 |
| `eventId` | 一次结算事件的编号（`pufe_...`），FINALIZE/RELEASE 的幂等键 |
| `rabbitvisUsageUnits` | RabbitVis 内部用量单位，只是事实报告，**不是**你们的积分，也不决定你们收多少钱 |

---

## 2. 第一步（后端）：创建嵌入会话

浏览器**永远不直接**调这个接口。流程是：你们的前端 → 你们的后端（验你们自己的登录态）→ 你们的后端调 RabbitVis。

### 2.1 请求

```http
POST {RabbitVis API 基址}/v1/partner/embed-sessions
Authorization: Bearer rvpk_<clientId>.<secret>
Content-Type: application/json
Idempotency-Key: <你生成的唯一键，建议 uuid 或 "embed_<userId>_<时间戳>">
```

```json
{
  "tenantId": "tenant_demo",
  "externalUserId": "demo_user_alice",
  "externalProjectId": "demo_project_alice",
  "billingSubjectRef": "demo_billing_alice",
  "origin": "https://app.example.com",
  "scopes": ["session:read", "run:create"],
  "sessionTitle": "我的设计"
}
```

| 字段 | 必填 | 约束 | 含义 |
|---|---|---|---|
| `tenantId` | 是 | 1–128 字符 | 你们的租户 id |
| `externalUserId` | 是 | 1–512 字符 | 你们的用户 id |
| `externalProjectId` | 是 | 1–512 字符 | 你们的项目 id。**用户进来会落在 RabbitVis 首页，这个项目作为"默认项目"出现在他的项目列表里**；如果你们不区分项目，传一个每用户固定的值即可（例如 `default_<userId>`） |
| `billingSubjectRef` | 是 | 1–256 字符 | 计费主体，回调原样带回 |
| `origin` | 是 | 合法 URL；生产必须 `https://`；必须在白名单内 | 将要嵌入 iframe 的页面 origin |
| `scopes` | 是 | 1–2 个，只能是 `session:read`、`run:create` | 权限范围。要让用户能生成/改图，**两个都传** |
| `sessionTitle` | 否 | 1–160 字符 | 只在**首次创建**该项目时用作项目名；已存在的项目不会被改名 |

请求限制：`Content-Type` 必须是 `application/json`，请求体不超过 16 KB。

### 2.2 响应（201）

```json
{
  "embedSessionId": "pes_9f1c...",
  "embedUrl": "<RABBITVIS_EMBED_BASE_URL>#code=boot_XXXXXXXX",
  "bootstrapCode": "boot_XXXXXXXX",
  "bootstrapExpiresAt": "2026-09-04T08:00:60.000Z",
  "expiresIn": 60,
  "sessionId": "sess_6272b9adb7494d1bb7fa0375"
}
```

| 字段 | 含义 |
|---|---|
| `embedUrl` | **直接交给前端 SDK 的地址**。里面的 `#code=` 是一次性启动码 |
| `bootstrapCode` | 同上那个启动码，单独给出。**60 秒内有效、只能用一次**，用过即作废 |
| `bootstrapExpiresAt` / `expiresIn` | 启动码过期时间 / 秒数（60） |
| `embedSessionId` | 本次嵌入会话 id，排障时给 RabbitVis 用 |
| `sessionId` | 映射出的 RabbitVis 项目 id |

⚠️ 因为启动码只有 60 秒，**前端每次要挂载 iframe 时都要实时向你们后端要一次新的 `embedUrl`**，不要缓存。

### 2.3 幂等

- 相同 `Idempotency-Key` + 相同请求体 → 返回**同一个**启动码（用于网络断了重试，不会产生第二个会话）。
- 相同 `Idempotency-Key` + 不同请求体 → `409 partner.idempotency_conflict`。

### 2.4 错误

响应统一形状：`{ "error": { "code": "...", "message": "..." } }`

| HTTP | code | 原因 |
|---|---|---|
| 401 | `partner.unauthorized` | API Key 不对或已停用 |
| 400 | `partner.idempotency_key_required` / `partner.invalid_idempotency_key` | 没带或格式不对 |
| 400 | `invalid_request` | 字段缺失/超长/类型不对（见 2.1 约束） |
| 400 | `invalid_json` | 请求体不是合法 JSON |
| 400 | `partner.invalid_origin` / `partner.https_origin_required` | origin 不是合法 URL / 不是 https |
| 403 | `partner.origin_not_allowed` | origin 不在白名单 |
| 400 | `partner.invalid_scopes` / `partner.required_scope_missing` | scopes 为空或缺必需项 |
| 403 | `partner.scope_not_allowed` | 申请了未授权的 scope |
| 400 | `partner.invalid_billing_subject` | billingSubjectRef 不合法 |
| 409 | `partner.idempotency_conflict` | 见 2.3 |
| 413 / 415 / 405 | `body_too_large` / `invalid_content_type` / `method_not_allowed` | 请求体超 16KB / 不是 JSON / 不是 POST |

### 2.5 你们后端接口的安全要求

你们暴露给自己前端的那个"要 embedUrl"的接口（例如 `POST /api/rabbitvis/embed-session`）：

- 必须验证你们自己的登录态（Cookie/Session），**身份只从服务端会话取，不信任请求体里的用户 id**。
- 必须有 CSRF 防护：校验 `Origin`/`Referer` 与你们页面一致，或用 CSRF token。
- 返回 `{ "embedUrl": "..." }` 即可，**不要**把 `partnerApiKey` 或任何 RabbitVis token 传给浏览器。

---

## 3. 第二步（前端）：用 SDK 挂载 iframe

```ts
import { mountRabbitVisEmbed } from '@rabbitvis/embed-sdk'

const embed = await mountRabbitVisEmbed({
  container: document.querySelector('#rabbitvis')!,
  rabbitVisOrigin: '<RABBITVIS_EMBED_ORIGIN>',          // RabbitVis 提供的嵌入 origin
  sessionEndpoint: '/api/rabbitvis/embed-session',     // 你们自己的同源接口，返回 { embedUrl }
  onEvent(event) {
    switch (event.type) {
      case 'ready':
        break // iframe 握手完成，可以用了
      case 'run.started':
        // event.payload.turnId：一次操作开始
        break
      case 'run.settled':
        // event.payload.turnId / outcome / code
        // outcome: 'succeeded' | 'failed' | 'cancelled' | 'rejected'
        // rejected 时 code 说明原因，例如 'partner.usage_denied'（你们的 AUTHORIZE 拒绝了）
        if (event.payload.outcome === 'succeeded') refreshMyBalanceUI()
        if (event.payload.outcome === 'rejected') showWhyRejected(event.payload.code)
        break
      case 'session.refresh-requested':
        // token 过期/失效，SDK 会自动再向 sessionEndpoint 要一次新 embedUrl 并重载，你们通常不用处理
        break
      case 'error':
        // { code, recoverable }：启动或重载失败
        break
    }
  },
})

// 可选命令
embed.focus()          // 让 iframe 获得焦点
embed.reloadSession()  // 手动重新拉起一次会话
embed.destroy()        // 卸载
```

要点：

- `rabbitVisOrigin` 必须是**精确的 origin**（协议+域名+端口，无路径），且**不能等于你们页面自己的 origin**。
- `sessionEndpoint` 会被 SDK 用 `POST` + 同源 Cookie 调用，返回必须是 `{ "embedUrl": "..." }`。如果你们有自定义的请求栈，可改用 `getEmbedSession: async () => ({ embedUrl })`，两者二选一。
- SDK 会校验 `embedUrl`：origin 必须等于 `rabbitVisOrigin`、必须 https、路径必须是 `/embed/`、fragment 里只能有 `code`。然后 SDK 自己追加 `instanceId` 和 `parentOrigin`，并把 iframe 的 `referrerPolicy` 设为 `origin`。**请不要自己拼 iframe src**，一律交给 SDK。
- iframe 里的 RabbitVis token 只在内存里，**不会**写你们页面的 localStorage/cookie，也不会通过事件泄露给你们。
- SDK 事件里的 `turnId` 与你们后端收到的 AUTHORIZE / FINALIZE / RELEASE 里的 `turnId` 是**同一个值**，用它把"用户看到的结果"和"账单"对上。
- ⚠️ **`run.started` / `run.settled` 只覆盖对话式生成（`operation: "run"`）。** 扩图、放大、擦除、去背景等**改图动作不会发这两个事件**（用户只在画布内看到进度与结果），但它们**同样会**走 AUTHORIZE 和 FINALIZE/RELEASE 回调。因此**余额 / 次数的最终依据必须是你们后端收到的回调**（或对账接口），SDK 事件只适合用来即时刷新对话生成的界面。

### 3.1 用户在 iframe 里会看到什么

- 落地在 RabbitVis **首页**（提示框 + 最近项目 + 灵感库），与 RabbitVis 自己的产品首页一致；`externalProjectId` 映射的项目出现在项目列表里。
- 用户可以新建项目、切换项目、删除项目、上传/导入图片、做全部画布操作。所有项目都归属同一个映射用户，**所有付费动作都走同一套回调、同一个 `billingSubjectRef`**。
- 页面里**没有** RabbitVis 的账号、登录、套餐、积分、价格、用量数字。余额之类的展示由你们的页面自己做。

---

## 4. RabbitVis 回调你们的接口（重点）

RabbitVis 会主动请求你们的两个接口：

| 接口 | 路径（固定后缀） | 时机 | 同步/异步 |
|---|---|---|---|
| **AUTHORIZE（确认接口）** | `POST <你们基址>/rabbitvis/billing/authorize` | 每次付费操作**开始前** | **同步**：RabbitVis 等你们回答后才执行，超时视为不可用 |
| **FINALIZE / RELEASE（结算接口）** | `POST <你们基址>/rabbitvis/billing/finalize` | 操作结束后 | **异步**：走 RabbitVis 的发件箱，失败自动重试 |

两个接口共用同一套请求头与签名规则（4.1、4.2），再各自定义报文（4.3、4.4）。

### 4.1 通用请求头

RabbitVis 每次请求都会带：

```http
POST /rabbitvis/billing/authorize HTTP/1.1
Content-Type: application/json; charset=utf-8
Accept: application/json
Accept-Encoding: identity
Idempotency-Key: puo_3f2a...            ← AUTHORIZE 是 operationId；FINALIZE/RELEASE 是 eventId
X-RabbitVis-Contract: partner-billing-v1
X-RabbitVis-Partner-Id: partner_demo    ← 你们的 partnerId
X-RabbitVis-Timestamp: 2026-09-04T08:12:31.204Z   ← ISO 8601 UTC
X-RabbitVis-Nonce: 6d5c2a1e-...         ← 每次请求都不同（含重试）
X-RabbitVis-Body-SHA256: <请求体原始字节的 sha256，hex 小写 64 位>
X-RabbitVis-Signature: v1=<base64url 的 HMAC-SHA256，43 位，无 '=' 填充>
```

### 4.2 验签（注意：是"验签"，不是"解密"）

回调报文是**明文 JSON**，没有加密；`X-RabbitVis-Signature` 是用 `billingSigningSecret` 对请求做的 **HMAC-SHA256 签名**。你们要做的是**用同一个密钥重新算一遍签名并比对**，证明请求确实来自 RabbitVis 且未被篡改。

#### 签名原文（canonical string）

把下面 7 行用 `\n`（LF）拼接，**不要**有多余空格或结尾换行：

```
v1
POST
<path+query>              ← 例：/rabbitvis/billing/authorize（有 query 就带上 ?a=b）
<X-RabbitVis-Timestamp>
<X-RabbitVis-Nonce>
<Idempotency-Key>
<X-RabbitVis-Body-SHA256>
```

然后：`signature = base64url( HMAC_SHA256( key = billingSigningSecret, data = canonical ) )`，与请求头 `X-RabbitVis-Signature` 去掉前缀 `v1=` 后比对。

#### 逐步验证（按顺序，任一步失败返回 401）

1. **检查头是否齐全且正确**：`X-RabbitVis-Contract` 必须是 `partner-billing-v1`；`X-RabbitVis-Partner-Id` 必须等于你们的 `partnerId`；方法必须是 `POST`；`Content-Type` 以 `application/json` 开头；`Accept` 是 `application/json`；`Accept-Encoding` 是 `identity`；`X-RabbitVis-Nonce` 和 `Idempotency-Key` 非空。
2. **检查时间戳**：解析 `X-RabbitVis-Timestamp`，与本机当前时间的偏差超过容忍窗口（建议 300 秒）→ `401 signature_expired`。
3. **检查请求体摘要**：对**收到的原始字节**（不要先 JSON.parse 再 stringify，那会改变字节）算 sha256 hex，与 `X-RabbitVis-Body-SHA256` **常量时间比较**，不等 → `401 invalid_signature`。
4. **重算并比对签名**：按上面的原文重算 HMAC，与 `X-RabbitVis-Signature` 的 `v1=` 之后部分**常量时间比较**，不等 → `401 invalid_signature`。
5. **防重放**（只在签名验证通过之后做）：把 `X-RabbitVis-Nonce` 记入缓存，保留 2 倍容忍窗口的时间；如果这个 nonce 已经出现过 → `401 nonce_replayed`。**多实例部署要用共享存储（Redis 等）记 nonce**，不能用进程内 Map。

⚠️ 顺序很重要：第 5 步放在验签之后，否则任何人都能用假请求塞满你们的 nonce 缓存，把 RabbitVis 真正的请求挡在外面。

⚠️ RabbitVis 的重试**每次都用新的 nonce**，所以 nonce 只用来防重放，**业务去重只能靠 `Idempotency-Key`**（AUTHORIZE 用 `operationId`，FINALIZE/RELEASE 用 `eventId`）。

#### 参考实现（Node.js，可直接改用）

```js
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

const TOLERANCE_SECONDS = 300

function safeEqual(a, b) {
  const x = Buffer.from(a, 'utf8'), y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

function sign(secret, { method, target, timestamp, nonce, idempotencyKey, bodyDigest }) {
  const canonical = ['v1', method, target, timestamp, nonce, idempotencyKey, bodyDigest].join('\n')
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('base64url')
}

/**
 * @param req        Node 的 IncomingMessage（或等价对象）
 * @param rawBody    请求体原始字节（Buffer 或 string），不要经过任何反序列化
 * @param cfg        { partnerId, billingSigningSecret }
 * @param nonceStore { has(nonce): Promise<boolean>, put(nonce, ttlMs): Promise<void> }  // 多实例用 Redis
 */
export async function verifyRabbitVisCallback(req, rawBody, cfg, nonceStore) {
  const h = (name) => String(req.headers[name] ?? '')
  const contract = h('x-rabbitvis-contract')
  const partnerId = h('x-rabbitvis-partner-id')
  const timestamp = h('x-rabbitvis-timestamp')
  const nonce = h('x-rabbitvis-nonce')
  const idempotencyKey = h('idempotency-key')
  const claimedDigest = h('x-rabbitvis-body-sha256')
  const sigHeader = h('x-rabbitvis-signature')
  const signature = sigHeader.startsWith('v1=') ? sigHeader.slice(3) : ''

  // 1. 头是否齐全正确
  if (
    contract !== 'partner-billing-v1'
    || partnerId !== cfg.partnerId
    || req.method !== 'POST'
    || !h('content-type').toLowerCase().startsWith('application/json')
    || h('accept').toLowerCase() !== 'application/json'
    || h('accept-encoding').toLowerCase() !== 'identity'
    || !nonce || !idempotencyKey
  ) throw Object.assign(new Error('invalid_signature'), { status: 401 })

  // 2. 时间戳窗口
  const ts = Date.parse(timestamp)
  if (!Number.isFinite(ts)) throw Object.assign(new Error('invalid_signature'), { status: 401 })
  if (Math.abs(Date.now() - ts) / 1000 > TOLERANCE_SECONDS) {
    throw Object.assign(new Error('signature_expired'), { status: 401 })
  }

  // 3. 请求体摘要（对原始字节算）
  const bodyDigest = createHash('sha256').update(rawBody).digest('hex')
  if (!/^[a-f0-9]{64}$/.test(claimedDigest) || !safeEqual(bodyDigest, claimedDigest)) {
    throw Object.assign(new Error('invalid_signature'), { status: 401 })
  }

  // 4. 重算签名
  const url = new URL(req.url ?? '/', 'http://placeholder.invalid')
  const expected = sign(cfg.billingSigningSecret, {
    method: 'POST',
    target: `${url.pathname}${url.search}`,
    timestamp, nonce, idempotencyKey, bodyDigest,
  })
  if (!/^[A-Za-z0-9_-]{43}$/.test(signature) || !safeEqual(expected, signature)) {
    throw Object.assign(new Error('invalid_signature'), { status: 401 })
  }

  // 5. 防重放（验签通过后才记 nonce）
  if (await nonceStore.has(nonce)) throw Object.assign(new Error('nonce_replayed'), { status: 401 })
  await nonceStore.put(nonce, TOLERANCE_SECONDS * 2 * 1000)

  return JSON.parse(rawBody.toString('utf8'))   // 验签通过后再解析业务字段
}
```

> 其他语言照同样步骤实现即可：sha256 用 hex 小写；HMAC-SHA256 输出用 **base64url 且不带 `=` 填充**（RFC 4648 §5）；比较用常量时间函数。

### 4.3 AUTHORIZE —— 确认接口

**时机**：用户每触发一次付费操作，RabbitVis 在真正执行前调用它，并**同步等待**你们的回答（最多 `billingTimeoutMs`，默认 5 秒）。

#### 请求体

```json
{
  "schemaVersion": "1",
  "operationId": "puo_c2312d11c9204ba8ad8ae0492a5d972c",
  "partnerId": "partner_demo",
  "tenantId": "tenant_demo",
  "billingSubjectRef": "demo_billing_alice",
  "sessionId": "sess_6272b9adb7494d1bb7fa0375",
  "turnId": "turn_36d6018e77de",
  "operation": "image_action",
  "estimate": {
    "operation": "image_action",
    "action": "upscale",
    "rabbitvisUsageUnits": 110
  }
}
```

| 字段 | 类型 | 含义 |
|---|---|---|
| `schemaVersion` | `"1"` | 协议版本，固定 |
| `operationId` | string | 本次计费操作的唯一编号。**AUTHORIZE 的幂等键**（= 请求头 `Idempotency-Key`）。同一个 operationId 可能因网络重试被再次发来，必须返回和第一次相同的决定，**不要重复预占** |
| `partnerId` / `tenantId` | string | 你们的合作方编号 / 你们创建会话时传的租户 id |
| `billingSubjectRef` | string | **该扣谁的钱**。就是你们创建会话时传的值，原样带回 |
| `sessionId` | string | 操作发生在哪个 RabbitVis 项目里（`sess_...`）。用户可能新建了多个项目，这个值会变，**计费不区分项目**，只看 `billingSubjectRef` |
| `turnId` | string | 本次操作编号，与 SDK 的 `run.started/run.settled` 事件、以及之后的 FINALIZE/RELEASE 一致 |
| `operation` | `"run"` \| `"image_action"` | 操作类型，见 4.5 |
| `estimate.operation` | 同上 | 与外层一致 |
| `estimate.action` | string（仅 `image_action` 有） | 具体是哪种改图动作，见 4.5 |
| `estimate.rabbitvisUsageUnits` | number \| **null** | RabbitVis 对本次用量的**预估**。对话生成（`run`）通常是 `null`（事先算不出来）；改图动作有时是固定值。**只是参考，真实用量以 FINALIZE 为准；它不是你们的积分，不要拿它当扣费金额** |
| `estimate.modelId` | string（可选） | 模型标识，仅供参考 |

#### 你们应该怎么决定（"如何控制"）

这一步就是你们的控费闸门。典型做法：

1. 验签（4.2）。
2. 用 `operationId` 查你们的记录：**已存在 → 直接返回上次的决定**（幂等）。
3. 用 `billingSubjectRef` 找到你们的用户/账户，按你们自己的规则判断：余额是否够、次数是否够、套餐是否允许该 `operation`/`action`、是否在黑名单等。
4. 允许 → 在你们那边**预占**（例如冻结 N 积分或 1 次），生成一个 `authorizationId`（你们自己定的字符串，1–256 字符，回头 FINALIZE 会原样带回），返回 `allow`。
5. 不允许 → 返回 `deny` 并给出 `reason`（1–256 字符，例如 `insufficient_balance`、`plan_not_allowed`）。这个 reason 会作为拒绝原因记录，用户在 iframe 里看到的是统一的"当前套餐或用量不允许执行此操作"，SDK 收到 `run.settled { outcome: 'rejected', code: 'partner.usage_denied' }`。

#### 响应（必须 HTTP 200 + JSON；字段**严格**，不能多不能少）

允许：
```json
{ "schemaVersion": "1", "decision": "allow", "authorizationId": "authz_20260904_00017" }
```

拒绝：
```json
{ "schemaVersion": "1", "decision": "deny", "reason": "insufficient_balance" }
```

| 字段 | 约束 |
|---|---|
| `schemaVersion` | 固定 `"1"` |
| `decision` | `"allow"` 或 `"deny"` |
| `authorizationId` | allow 时必填，1–256 字符，你们自定义 |
| `reason` | deny 时必填，1–256 字符，你们自定义 |

⚠️ **拒绝请用 `decision: "deny"`，不要用 HTTP 4xx/5xx 来表示拒绝。** 非 2xx、超时、网络错误、JSON 不合法、多了字段，在 RabbitVis 看来都是"你们的服务不可用"（fail-closed，用户看到"合作方授权服务暂时不可用，请稍后重试"，HTTP 503 `partner.authorize_unavailable`），而不是"你们拒绝了"。响应体不超过 32 KB。

#### 幂等与重放语义

- 同一个 `operationId` 只对应一次操作，内容永远相同。RabbitVis 只会在**响应丢失/进程崩溃**这类情况下重发同一个 `operationId`，你们返回上次结果即可，不要再预占一次。
- 如果同一个 `operationId` 带来了不同内容（理论上不会发生），可返回 4xx 表示协议冲突。

### 4.4 FINALIZE / RELEASE —— 结算接口

**时机**：操作结束后（成功、失败、用户取消、或 RabbitVis 侧异常恢复），RabbitVis 把结果放入发件箱异步投递。可能在 AUTHORIZE 之后几秒到几小时内到达，**必须按 `eventId` 幂等处理**。

同一个接口收两种事件，用 `kind` 区分：

| `kind` | 何时 | `actualUsage.rabbitvisUsageUnits` | 你们通常怎么做 |
|---|---|---|---|
| `FINALIZE` | 有实际用量 | **> 0** | 确认扣费（把预占转为实扣） |
| `RELEASE` | 零用量（没做出东西） | **= 0** | 释放预占，不扣费 |

#### 请求体

```json
{
  "schemaVersion": "1",
  "eventId": "pufe_6831452450294d3b800d45e8cd2aa4cf",
  "operationId": "puo_c2312d11c9204ba8ad8ae0492a5d972c",
  "partnerId": "partner_demo",
  "tenantId": "tenant_demo",
  "billingSubjectRef": "demo_billing_alice",
  "sessionId": "sess_6272b9adb7494d1bb7fa0375",
  "turnId": "turn_36d6018e77de",
  "operation": "image_action",
  "kind": "FINALIZE",
  "outcome": "succeeded",
  "authorizationId": "authz_20260904_00017",
  "actualUsage": {
    "rabbitvisUsageUnits": 110,
    "imageCount": 1,
    "modelId": "..."
  },
  "occurredAt": "2026-09-04T08:13:02.118Z"
}
```

| 字段 | 类型 | 含义 |
|---|---|---|
| `schemaVersion` | `"1"` | 固定 |
| `eventId` | string | 本次结算事件编号。**FINALIZE/RELEASE 的幂等键**（= 请求头 `Idempotency-Key`）。重试会带同一个 eventId |
| `operationId` | string | 对应哪次 AUTHORIZE。**一个 operationId 只会有一个结算事件** |
| `partnerId` / `tenantId` / `billingSubjectRef` / `sessionId` / `turnId` / `operation` | 同 AUTHORIZE | 与对应的 AUTHORIZE 完全一致，方便你们关联 |
| `kind` | `"FINALIZE"` \| `"RELEASE"` | 见上表 |
| `outcome` | `"succeeded"` \| `"failed"` \| `"cancelled"` \| `"no_delivery"` | 操作结果：成功 / 执行中出错 / 用户中途取消 / RabbitVis 侧异常、未交付（此时一定是 RELEASE、用量 0） |
| `authorizationId` | string \| **null** | 你们在 AUTHORIZE 里返回的那个 id。极少数情况下为 null（AUTHORIZE 的回应在 RabbitVis 这边丢失但操作已被恢复处理），此时请按 `operationId` 关联 |
| `actualUsage.rabbitvisUsageUnits` | number | **实际用量**（RabbitVis 内部单位）。RELEASE 时恒为 0 |
| `actualUsage.inputTokens` / `outputTokens` / `cacheReadInputTokens` / `imageCount` / `modelId` | 可选 | 用量明细，仅供参考与对账 |
| `occurredAt` | ISO 8601 | 结算发生时间 |

#### 你们应该怎么处理

1. 验签（4.2）。
2. 用 `eventId` 查记录：**已处理 → 直接返回上次结果，并可标 `duplicate: true`**。
3. 用 `operationId` 找到 AUTHORIZE 时的预占。
4. 按 `kind` + `outcome` 结算。RabbitVis 参考实现（demo）的默认策略：
   - `FINALIZE` + `succeeded` → 确认扣费；
   - `FINALIZE` + `failed` / `cancelled` → 释放预占（用户没拿到结果就不收钱；你们也可以选择按实际用量收，这是你们的商业决定）；
   - `RELEASE`（任何 outcome）→ 释放预占。
5. 记录 `eventId` → 结果，保证幂等。
6. 若同一个 `operationId` 已经被另一个不同的 `eventId` 结算过，可返回 4xx（协议冲突），正常情况下不会发生。

#### 响应（必须 HTTP 200 + JSON；字段**严格**）

```json
{ "schemaVersion": "1", "accepted": true, "eventId": "pufe_6831452450294d3b800d45e8cd2aa4cf", "duplicate": false }
```

| 字段 | 约束 |
|---|---|
| `schemaVersion` | 固定 `"1"` |
| `accepted` | 固定 `true` |
| `eventId` | **必须原样回显**请求里的 eventId，否则 RabbitVis 视为投递失败且不再重试 |
| `duplicate` | 可选布尔，重复投递时可标 `true`，仅供你们排障 |

#### 投递保证与重试（你们需要知道的）

- 你们返回 **2xx 且格式正确** → 视为投递成功，不会再发。
- 网络错误、超时、`408`、`429`、`5xx` → RabbitVis **自动重试**：间隔从 15 秒起指数增长（15s、30s、60s……），单次最长 6 小时，最多 16 次。
- 其他 `4xx`（如 400、401、404）→ **立即判定为投递失败，不再重试**，该事件在对账接口里状态为 `dead`。所以：验签失败返回 401 是对的（那是假请求），但**不要**对合法请求用 4xx 表达业务问题。
- 因此，你们的结算接口要做到：验签通过就尽量 200 接收并入库，业务上的异常在自己系统内部处理。

### 4.5 `operation` 与 `action` 枚举

| `operation` | 含义 | `estimate.action` | 用户界面上的动作 |
|---|---|---|---|
| `run` | 对话式生成：用户在输入框提交提示词，AI 生成/修改设计 | 无 | 发送提示词 |
| `image_action` | 对画布上的图片直接执行服务 | `expand` | 扩图 |
| | | `upscale` | 高清放大 |
| | | `erase` | 擦除 |
| | | `matte` | 去背景 |
| | | `multi-angle` | 多角度 |
| | | `panorama` | 全景 |
| | | `text-edit` | 图片文字编辑 |
| | | `decompose` | 图层分解 |
| | | `redo` | 重做上一次图片操作 |

如果你们想按动作差异化收费或限制（例如只允许放大、不允许全景），就在 AUTHORIZE 里按 `operation` + `estimate.action` 判断。以后新增动作会提前通知并更新本表。

### 4.6 推荐的账务模型（一句话版）

**AUTHORIZE = 预占（按 `operationId`），FINALIZE = 实扣，RELEASE = 退回预占；三者都幂等，`billingSubjectRef` 决定扣谁，`turnId` 用来和前端对账。**

---

## 5. 对账：拉取用量事件

如果你们想核对"RabbitVis 到底给我发过哪些结算事件、哪些没送达"，可以用这个接口分页拉取 RabbitVis 发件箱里发给你们的全部事件。

```http
GET {RabbitVis API 基址}/v1/partner/usage-events?cursor=0&limit=100
Authorization: Bearer rvpk_<clientId>.<secret>
```

| 参数 | 约束 | 含义 |
|---|---|---|
| `cursor` | 非负整数，默认 0 | 从哪个序号之后开始拉（传上一页的 `nextCursor`） |
| `limit` | 1–200，默认 100 | 每页条数 |

响应：

```json
{
  "events": [
    {
      "sequenceId": 42,
      "id": "pufe_6831452450294d3b800d45e8cd2aa4cf",
      "operationId": "puo_c2312d11c9204ba8ad8ae0492a5d972c",
      "partnerId": "partner_demo",
      "kind": "FINALIZE",
      "state": "delivered",
      "attempts": 1,
      "nextAttemptAt": "2026-09-04T08:13:02.118Z",
      "lockedAt": null,
      "lastError": null,
      "deliveredAt": "2026-09-04T08:13:03.402Z",
      "createdAt": "2026-09-04T08:13:02.118Z",
      "updatedAt": "2026-09-04T08:13:03.402Z",
      "requestHash": "…",
      "payload": { "...与 4.4 的请求体完全相同..." }
    }
  ],
  "nextCursor": 42
}
```

| 字段 | 含义 |
|---|---|
| `events[].payload` | 就是 4.4 里那份 FINALIZE/RELEASE 报文，可用来补账 |
| `events[].state` | `pending` 待发 / `processing` 发送中 / `failed` 失败待重试 / `delivered` 已送达 / `dead` 放弃（重试耗尽或你们返回了非重试的 4xx） |
| `events[].attempts` / `lastError` / `nextAttemptAt` | 已尝试次数 / 最近一次错误码 / 下次重试时间 |
| `nextCursor` | 下一页游标；`null` 表示没有更多 |

建议：定时任务每天用 `cursor` 增量拉取，对 `state=dead` 的事件人工核对补账，对 `delivered` 的事件与你们本地按 `eventId` 核对一致性。

---

## 6. 错误码总表

### 6.1 用户在 iframe 里可能遇到的（与你们的回调直接相关）

| 用户看到 | HTTP / code | 触发原因 | SDK 事件 |
|---|---|---|---|
| 当前套餐或用量不允许执行此操作 | 402 `partner.usage_denied` | 你们 AUTHORIZE 返回 `deny` | `run.settled { outcome: 'rejected', code: 'partner.usage_denied' }`（仅对话生成；改图动作只在画布内提示，无 SDK 事件） |
| 合作方授权服务暂时不可用，请稍后重试 | 503 `partner.authorize_unavailable` | 你们 AUTHORIZE 超时 / 非 2xx / 格式错 / 网络错 | 同上，code 为该值（仅对话生成） |
| 合作方用量服务暂时不可用 | 503 `partner.usage_unavailable` | RabbitVis 侧用量服务异常 | — |
| 合作方当前并发生成数已达上限 | 429 `partner.concurrency_limited` | 超过 `maxConcurrentRuns` | — |
| 该操作仍在处理中 | 409 `partner.operation_in_progress` | 同一操作被重复提交 | — |

### 6.2 你们的回调接口应返回的

| 情况 | 返回 |
|---|---|
| 验签失败 / 头不全 | `401` + `{ "error": "invalid_signature" }`（RabbitVis 对 401 不重试） |
| 时间戳超窗 | `401` + `signature_expired` |
| nonce 重放 | `401` + `nonce_replayed` |
| AUTHORIZE 允许 / 拒绝 | `200` + 4.3 的 allow / deny 报文 |
| FINALIZE/RELEASE 接收 | `200` + 4.4 的 accepted 报文（重复投递也返回 200） |
| 你们内部临时故障 | `503`（RabbitVis 会重试 FINALIZE；对 AUTHORIZE 则用户会看到"暂时不可用"并可重试） |

---

## 7. 安全清单（上线前逐条确认）

- [ ] `partnerApiKey` 与 `billingSigningSecret` 只存在于你们后端（密钥管理/环境变量），从未出现在前端代码、日志、错误信息里。
- [ ] 回调地址是公网 HTTPS，证书有效；不做重定向。
- [ ] 验签顺序正确：头检查 → 时间戳 → 请求体摘要 → HMAC → **最后**才记 nonce；比较全部用常量时间函数。
- [ ] 对**原始请求字节**算 sha256，中间没有任何反序列化/再序列化。
- [ ] 多实例部署时 nonce 缓存与 `operationId`/`eventId` 幂等记录都在共享存储里。
- [ ] 服务器时钟 NTP 同步。
- [ ] AUTHORIZE 在 `billingTimeoutMs`（默认 5 秒）内返回；建议 P99 < 1 秒。
- [ ] 拒绝用 `decision: "deny"`，不用 HTTP 错误码表达业务拒绝。
- [ ] FINALIZE/RELEASE 对合法请求一律 2xx 接收，按 `eventId` 幂等。
- [ ] 前端只通过 SDK 挂载 iframe；`sessionEndpoint` 有登录态校验与 CSRF 防护；`embedUrl` 每次实时获取不缓存。
- [ ] 新增嵌入页面域名前，先联系 RabbitVis 加入 `allowedOrigins`。

---

## 8. 联调与参考实现

### 8.1 联调环境

联调环境的 API 基址、嵌入 origin、演示站地址，以及一个联调用的合作方账号（`partnerId` / `partnerApiKey` / `billingSigningSecret`），由 RabbitVis 在收到你们的回调基址与页面 Origin 后开通并通过安全渠道发送。生产环境的地址与凭据在联调通过后另行提供。

### 8.2 参考实现（RabbitVis 仓库内）

| 位置 | 内容 |
|---|---|
| `examples/partner-embed-demo/`（本仓库） | **一个完整可运行的"合作方"示例**：登录、向 RabbitVis 要 embedUrl、用 SDK 挂载、实现 authorize/finalize 回调（含验签、防重放、按 operationId/eventId 幂等、预占/实扣/退回），还带故障注入用于联调。建议以它为蓝本 |
| `examples/partner-embed-demo/src/demo-server.mjs` | 回调验签 `verifyBillingSignature` 与签名 `signBillingBody` 的原始实现 |
| `examples/partner-embed-demo/src/billing-store.mjs` | 预占 / 结算 / 幂等的账务参考逻辑 |
| `examples/partner-embed-stub/` | 最小回调桩：**不验签**，AUTHORIZE 按页面开关返回 allow/deny，FINALIZE 只记日志并接收。只用于最初把链路打通，**不能**作为真实实现 |
| `sdk/README.md`（本仓库） | SDK 用法与事件说明 |

### 8.3 建议的联调顺序

1. 先用 `partner-embed-stub`（不验签、按开关 allow）把整条链路跑通：创建会话 → 挂载 → `ready` → 发一次提示词 → 看到 AUTHORIZE 与 FINALIZE 打到你们的日志。
2. 换成真实验签，故意改一个字节验证会返回 401。
3. 实现幂等：把同一条 AUTHORIZE 重放两次，确认只预占一次；同一条 FINALIZE 重放两次，确认只扣一次。
4. 实现 deny：让某个用户余额为 0，确认 iframe 里显示"不允许执行"、SDK 收到 `rejected`、且没有 FINALIZE 到达。
5. 拉一次 `usage-events`，与本地账单逐条核对。

---

## 附录 A：字段速查（合作方视角）

| 我从哪里拿到 | 字段 | 我用它做什么 |
|---|---|---|
| 创建会话请求（我发） | `billingSubjectRef` | 定义"扣谁的钱"，之后所有回调原样带回 |
| 创建会话响应 | `embedUrl` | 交给前端 SDK；60 秒内有效 |
| SDK 事件 | `turnId` | 与回调里的 `turnId` 对上，刷新我自己的余额 UI |
| AUTHORIZE 请求 | `operationId` | 幂等键；预占记录的主键 |
| AUTHORIZE 请求 | `billingSubjectRef` | 找账户 |
| AUTHORIZE 请求 | `operation` / `estimate.action` | 判断该动作是否允许、怎么计价 |
| AUTHORIZE 请求 | `estimate.rabbitvisUsageUnits` | 仅参考（可能为 null） |
| AUTHORIZE 响应（我回） | `authorizationId` | 我自定义；FINALIZE 会带回 |
| FINALIZE/RELEASE 请求 | `eventId` | 幂等键 |
| FINALIZE/RELEASE 请求 | `operationId` / `authorizationId` | 找到预占 |
| FINALIZE/RELEASE 请求 | `kind` + `outcome` | 决定实扣还是退回 |
| FINALIZE/RELEASE 请求 | `actualUsage.rabbitvisUsageUnits` | 实际用量（RELEASE 恒 0），可作为计价依据之一 |
| 对账接口 | `events[].state` / `payload` | 找出未送达（`dead`）的事件补账 |

## 附录 B：两条完整时间线示例

### B.1 对话式生成（`operation: "run"`，有 SDK 事件）

```
T+0.0s  用户在输入框提交"做一张海报"
T+0.0s  RabbitVis → 你们 AUTHORIZE
          Idempotency-Key: puo_c231...   operation=run   estimate.rabbitvisUsageUnits=null
T+0.3s  你们 → RabbitVis  { decision: "allow", authorizationId: "authz_17" }   （你们预占）
T+0.3s  SDK 事件 run.started { turnId: "turn_36d6..." }
T+35s   生成完成，海报落到画布
T+35s   SDK 事件 run.settled { turnId: "turn_36d6...", outcome: "succeeded" }   （你们可即时刷新界面）
T+36s   RabbitVis → 你们 FINALIZE
          Idempotency-Key: pufe_6831...  kind=FINALIZE outcome=succeeded actualUsage.rabbitvisUsageUnits=23
T+36s   你们 → RabbitVis  { accepted: true, eventId: "pufe_6831..." }   （你们把预占转为实扣，这才是账务事实）
```

如果用户在 T+10s 点了"停止"：SDK 收到 `run.settled { outcome: "cancelled" }`，随后回调 `kind=RELEASE outcome=cancelled actualUsage.rabbitvisUsageUnits=0`，你们退回预占。
如果你们在 T+0.3s 返回 `deny`：SDK 收到 `run.settled { outcome: "rejected", code: "partner.usage_denied" }`，**不会有** FINALIZE/RELEASE（没有预占需要结算）。

### B.2 改图动作（`operation: "image_action"`，例如高清放大，**没有** SDK 事件）

```
T+0.0s  用户选中图片，点"高清放大 4K"
T+0.0s  RabbitVis → 你们 AUTHORIZE
          Idempotency-Key: puo_9a4e...   operation=image_action  action=upscale  estimate.rabbitvisUsageUnits=110
T+0.3s  你们 → RabbitVis  { decision: "allow", authorizationId: "authz_18" }   （你们预占）
          （此处没有 run.started）
T+38s   放大完成，图片替换到画布
          （此处没有 run.settled）
T+39s   RabbitVis → 你们 FINALIZE
          Idempotency-Key: pufe_5712...  kind=FINALIZE outcome=succeeded actualUsage.rabbitvisUsageUnits=110
T+39s   你们 → RabbitVis  { accepted: true, eventId: "pufe_5712..." }   （你们把预占转为实扣）
```

如果你们返回 `deny`：用户在画布内看到"当前套餐或用量不允许执行此操作"，**没有** SDK 事件，也**没有** FINALIZE/RELEASE。
所以对改图动作而言，**你们只能通过后端回调（或对账接口）得知它发生过**——这也是为什么余额/次数不能只靠 SDK 事件维护。
