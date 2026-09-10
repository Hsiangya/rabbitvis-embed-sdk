# rabbitvis-embed-sdk

RabbitVis **合作方托管嵌入（Partner Hosted Embed）** 的公开配套物料：浏览器 SDK、对接文档、以及合作方侧的参考实现。

RabbitVis Partner Hosted Embed: the browser SDK, the integration guide and reference partner implementations.

## 目录

| 路径 | 内容 |
|---|---|
| [`docs/partner-embed-integration.md`](docs/partner-embed-integration.md) | **对接文档（必读）**：整体流程、创建嵌入会话、SDK 挂载、回调验签与逐字段说明、对账、错误码、安全清单 |
| [`sdk/`](sdk/) | `@rabbitvis/embed-sdk` 源码、构建产物（`sdk/dist`）与[用法说明](sdk/README.md) |
| [`examples/partner-embed-demo/`](examples/partner-embed-demo/) | 完整可运行的合作方参考实现：验签、防重放、按 `operationId`/`eventId` 幂等、预占/实扣/退回、故障注入 |
| [`examples/partner-embed-java/`](examples/partner-embed-java/) | Java（JDK 21，零依赖）合作方参考实现：页面挂载、创建嵌入会话、回调验签、预占/实扣/退回，可本机运行或用 Dockerfile 部署 |
| [`examples/partner-embed-stub/`](examples/partner-embed-stub/) | 最小回调桩（不验签、开关 allow/deny），只用于最初打通链路 |

## 快速开始

**1. 拿到 SDK**

- 方式一：从 [Releases](../../releases) 下载 `rabbitvis-embed-sdk-<version>.tgz`，`npm install ./rabbitvis-embed-sdk-<version>.tgz`。
- 方式二：直接使用仓库里的 `sdk/dist/*.js`（ESM）。
- 方式三：自己构建：`cd sdk && npm install && npm run build`。

**2. 挂载**

```ts
import { mountRabbitVisEmbed } from '@rabbitvis/embed-sdk'

const embed = await mountRabbitVisEmbed({
  container: document.querySelector('#rabbitvis')!,
  rabbitVisOrigin: '<RABBITVIS_EMBED_ORIGIN>',     // 由 RabbitVis 提供
  sessionEndpoint: '/api/rabbitvis/embed-session', // 你们自己的同源接口，返回 { embedUrl }
  onEvent(event) { /* ready / run.started / run.settled / session.refresh-requested / error */ },
})
```

**3. 后端实现两个回调**：`POST <你们基址>/rabbitvis/billing/authorize`（确认是否允许）和 `POST <你们基址>/rabbitvis/billing/finalize`（结算）。验签规则与字段含义见对接文档第 4 节，参考实现见 `examples/partner-embed-demo/src/demo-server.mjs` 与 `src/billing-store.mjs`（Node），或 `examples/partner-embed-java/PartnerServer.java`（Java）。

## 凭据与环境

`partnerId`、`partnerApiKey`、`billingSigningSecret`、API 基址与嵌入 origin 均由 RabbitVis 通过安全渠道提供，**不会**出现在本仓库中。开通前需要你们提供：公网 HTTPS 的回调基址、会嵌入页面的 Origin 列表、合作方名称。

## 版本

SDK 当前版本 `0.2.0`，协议版本 `partner-billing-v1`。

## 许可证

待定（LICENSE 文件将随后添加）。
