# partner-embed-java

合作方（平台方）后端的 Java 参考实现：JDK 21，零依赖，单文件 `PartnerServer.java`。

它演示了对接文档里合作方要做的全部事情：

- 页面：假登录（内置 `alice` 5 次、`bob` 0 次），用 SDK 把 RabbitVis 编辑器挂进 iframe，显示余额、SDK 事件和收到的回调；
- `POST /api/rabbitvis/embed-session`：校验自己的登录态和 `Origin`，用 `PARTNER_API_KEY` 调 RabbitVis `POST /v1/partner/embed-sessions`，只把 `embedUrl` 返回给浏览器；
- `POST /rabbitvis/billing/authorize`：验签 → 按 `operationId` 幂等 → 预占 1 次 → 返回 `allow` / `deny`；
- `POST /rabbitvis/billing/finalize`：验签 → 按 `eventId` 幂等 → `FINALIZE + succeeded` 实扣，其余情况退回预占。

账都记在内存里，重启就清空。生产实现要改成数据库，nonce 和幂等记录要放 Redis 这类共享存储。

## 需要 RabbitVis 提供的值

| 环境变量 | 说明 |
|---|---|
| `RABBITVIS_ORIGIN` | 嵌入 origin，即 SDK 的 `rabbitVisOrigin`，例如 `https://<rabbitvis-embed-host>` |
| `RABBITVIS_API_BASE` | 合作方 API 基址；不填则与 `RABBITVIS_ORIGIN` 相同 |
| `PARTNER_ID` | `partnerId` |
| `PARTNER_API_KEY` | `rvpk_<clientId>.<secret>`，**只放后端** |
| `BILLING_SIGNING_SECRET` | 回调验签密钥，**只放后端** |

以上五项都缺一不可，缺少时程序直接退出，不会带默认值启动。

## 需要提供给 RabbitVis 的值

1. **页面 origin**：你们嵌入 iframe 的页面地址，精确到协议、域名和端口，例如 `https://app.example.com`，要加进白名单。本地跑本例时是 `https://localhost:8443`。
2. **回调基址**：公网可达的 HTTPS 地址。RabbitVis 会调用 `<基址>/rabbitvis/billing/authorize` 和 `<基址>/rabbitvis/billing/finalize`，不接受内网地址，也不跟随重定向。

## 方式一：本机运行

```bash
export RABBITVIS_ORIGIN=https://<rabbitvis-embed-host>
export PARTNER_ID=<partnerId>
export PARTNER_API_KEY=<rvpk_...>
export BILLING_SIGNING_SECRET=<secret>
./run.sh          # 首次会用 keytool 生成自签证书 local-keystore.p12，再执行 java PartnerServer.java
open https://localhost:8443/   # 浏览器会提示证书不受信任，手动继续一次
```

- 页面必须是 HTTPS，RabbitVis 线上环境不接受 `http://` 的页面 origin。
- 本机方式下，"创建嵌入会话"和"iframe 加载"都能直接跑通。但生成时 RabbitVis 要**从它的服务器回调你们**，本机没有公网地址是收不到的，用户会看到"合作方授权服务暂时不可用"。想在本机调完整链路，需要自己把 `127.0.0.1:18080`（只提供两个回调接口）通过隧道暴露成公网 HTTPS；否则就用方式二部署到服务器上。

## 方式二：部署到服务器（推荐联调用）

放在已经终止 TLS 的反向代理后面，页面和回调走同一个公网域名：

```bash
docker build -f examples/partner-embed-java/Dockerfile -t partner-embed-java .   # 在仓库根目录执行
docker run -p 8080:8080 \
  -e PAGE_ORIGIN=https://partner.example.com \
  -e BASE_PATH=/java \
  -e RABBITVIS_ORIGIN=https://<rabbitvis-embed-host> \
  -e PARTNER_ID=<partnerId> -e PARTNER_API_KEY=<rvpk_...> -e BILLING_SIGNING_SECRET=<secret> \
  partner-embed-java
```

反向代理把 `https://partner.example.com/java` 转到容器的 8080 端口，并且**不要剥掉路径前缀**（签名覆盖完整路径）。这时：

- 页面：`https://partner.example.com/java/`
- 页面 origin：`https://partner.example.com`
- 回调基址：`https://partner.example.com/java`

镜像里已经设好 `PAGE_TLS=false`、`BIND_HOST=0.0.0.0`、`PAGE_PORT=8080`、`CALLBACK_PORT=0`。

## 其他可选环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PAGE_ORIGIN` | `https://localhost:8443` | 页面 origin，用于 CSRF 校验，也会作为 `origin` 传给 RabbitVis |
| `BASE_PATH` | 空 | 整站挂在子路径下时填写 |
| `PAGE_TLS` | `true` | `false` 表示用普通 HTTP，TLS 由反向代理负责 |
| `BIND_HOST` | `127.0.0.1` | 监听地址 |
| `PAGE_PORT` / `CALLBACK_PORT` | `8443` / `18080` | `CALLBACK_PORT=0` 表示不开独立回调端口 |
| `TENANT_ID` | `tenant_demo` | 租户编号 |
| `SDK_DIST` | `../../sdk/dist` | SDK 构建产物目录 |

## 联调时怎么看结果

- `alice` 点生成：左侧先出现 `AUTHORIZE → allow`，余额减 1、预占 1；生成结束后收到 `FINALIZE`（实扣）或 `RELEASE`（退回）。
- `bob` 点生成：返回 `deny`，iframe 里提示"当前套餐或用量不允许执行此操作"，SDK 收到 `run.settled { outcome: 'rejected', code: 'partner.usage_denied' }`。
- 扩图、放大这类改图动作**不会**产生 SDK 事件，但同样会走两个回调。
