# RabbitVis Partner Embed Stub

最小合作方实现，只有合作方必须提供的三个接口，用来验证整条 Embed 链路。没有登录、余额、签名校验和故障注入；完整的模拟合作方见 `../partner-embed-demo`。

| 接口 | 行为 |
|---|---|
| `POST /api/rabbitvis/embed-session` | 用 Partner Key 调 RabbitVis 创建 Embed Session，把 `embedUrl` 交给页面上的 SDK。用户身份来自页面的 `?user=`，默认 `alice` |
| `POST /rabbitvis/billing/authorize` | 按当前开关返回 `allow`（`authorizationId` 由 `operationId` 派生）或 `deny`（`reason: stub_denied`） |
| `POST /rabbitvis/billing/finalize` | 只记日志，返回 `accepted: true` |

页面顶部有「设为 allow / 设为 deny」两个按钮，切换后再在 iframe 里生成一次即可分别验证放行与拒绝；页面下方的黑色面板实时显示 SDK 事件和三个接口的调用记录，终端里也有同样的日志。

## 启动

```bash
export RABBITVIS_PARTNER_API_KEY='<由 RabbitVis 提供，allowed origin 填 http://127.0.0.1:4182>'
export RABBITVIS_API_BASE_URL=http://127.0.0.1:3002      # RabbitVis API
export RABBITVIS_EMBED_ORIGIN=http://127.0.0.1:5175      # RabbitVis 前端
node server.mjs                                          # 默认监听 127.0.0.1:4182
```

可选环境变量：`PORT`、`HOST`、`PARTNER_STUB_PUBLIC_ORIGIN`、`PARTNER_STUB_AUTHORIZE=deny`（启动时默认拒绝）、`RABBITVIS_EMBED_SDK_DIR`（默认读本仓库的 `sdk/dist`）。

RabbitVis 每次回调都带 HMAC 签名头，这个 stub 不校验；真实接入必须校验签名和时间窗，并按 `eventId` 去重，参考 `../partner-embed-demo`。
