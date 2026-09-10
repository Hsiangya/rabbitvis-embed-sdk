import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpsConfigurator;
import com.sun.net.httpserver.HttpsServer;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Deque;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

/**
 * RabbitVis Partner Hosted Embed — 合作方（平台方）后端 Java 参考实现，用于联调。
 *
 * 零依赖（JDK 21），单文件：`java PartnerServer.java`。
 *
 *   https://localhost:8443/                      合作方页面（假登录 + SDK 挂载 iframe + 余额/回调日志）
 *   POST /api/login                              假登录，写 Cookie
 *   POST /api/rabbitvis/embed-session            验登录态 + Origin → 调 RabbitVis 创建嵌入会话 → 返回 { embedUrl }
 *   GET  /api/me                                 当前用户余额
 *   GET  /api/ledger                             最近收到的回调
 *   POST /rabbitvis/billing/authorize            RabbitVis 回调：验签 → 按 operationId 幂等 → 预占 1 次 → allow/deny
 *   POST /rabbitvis/billing/finalize             RabbitVis 回调：验签 → 按 eventId 幂等 → 实扣 / 退回
 *
 * 回调既挂在页面端口上，也挂在一个纯 HTTP 端口（默认 18080，CALLBACK_PORT=0 关闭）上。
 * 部署在反向代理后面时：PAGE_TLS=false、BIND_HOST=0.0.0.0、BASE_PATH=/java（整站挂在子路径下）。
 * 账务全部在内存里，重启即清空；生产实现必须换成数据库 + Redis（nonce、幂等记录要跨实例共享）。
 */
public class PartnerServer {

    static final String CONTRACT = "partner-billing-v1";
    static final long TOLERANCE_SECONDS = 300;

    static final int PAGE_PORT = intEnv("PAGE_PORT", 8443);                                  // 本服务监听端口
    static final boolean PAGE_TLS = !"false".equalsIgnoreCase(env("PAGE_TLS", "true"));      // true=本服务自己用自签证书起 HTTPS；部署在反向代理（已终止 TLS）后面时设 false
    static final String BIND_HOST = env("BIND_HOST", "127.0.0.1");                           // 监听地址；容器里设 0.0.0.0
    static final String BASE_PATH = env("BASE_PATH", "").replaceAll("/+$", "");              // 整站挂在子路径下时填，如 /java；页面、接口、回调都在它下面
    static final int CALLBACK_PORT = intEnv("CALLBACK_PORT", 18080);                         // 额外的纯 HTTP 回调端口（只挂 billing 两个接口），0 表示不开
    static final String PAGE_ORIGIN = env("PAGE_ORIGIN", "https://localhost:" + PAGE_PORT);  // 你们嵌入 iframe 的页面 origin；必须在 RabbitVis 的 allowedOrigins 白名单里，也用于 CSRF 校验
    static final String RABBITVIS_ORIGIN = required("RABBITVIS_ORIGIN");                     // 必填，RabbitVis 提供：嵌入 origin，即 SDK 的 rabbitVisOrigin
    static final String RABBITVIS_API_BASE = env("RABBITVIS_API_BASE", RABBITVIS_ORIGIN);    // RabbitVis 提供：合作方 API 基址，默认同 RABBITVIS_ORIGIN
    static final String PARTNER_ID = required("PARTNER_ID");                                 // 必填，RabbitVis 提供：partnerId，回调头 X-RabbitVis-Partner-Id 必须等于它
    static final String PARTNER_API_KEY = required("PARTNER_API_KEY");                       // 必填，RabbitVis 提供：rvpk_<clientId>.<secret>，只放后端，绝不进浏览器
    static final String BILLING_SIGNING_SECRET = required("BILLING_SIGNING_SECRET");         // 必填，RabbitVis 提供：回调验签用的 HMAC-SHA256 密钥
    static final String TENANT_ID = env("TENANT_ID", "tenant_demo");                         // 你们的租户编号，和用户 id 一起决定 RabbitVis 侧的用户身份
    static final Path SDK_DIST = Path.of(env("SDK_DIST", "../../sdk/dist")).toAbsolutePath().normalize(); // 页面加载的 SDK 构建产物目录
    static final Path KEYSTORE = Path.of(env("KEYSTORE", "local-keystore.p12"));             // PAGE_TLS=true 时用的 PKCS12 证书，run.sh 会自动生成自签的
    static final String KEYSTORE_PASSWORD = env("KEYSTORE_PASSWORD", "changeit");            // 上面证书的口令，仅本地自签证书用

    static final Map<String, Integer> INITIAL_BALANCE = Map.of("alice", 5, "bob", 0);

    static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    static final SecureRandom RANDOM = new SecureRandom();

    static final Map<String, String> sessions = new ConcurrentHashMap<>();
    static final Map<String, Account> accounts = new ConcurrentHashMap<>();
    static final Map<String, Long> nonces = new ConcurrentHashMap<>();
    static final Map<String, Map<String, Object>> authorizeResults = new ConcurrentHashMap<>();
    static final Map<String, Reservation> reservations = new ConcurrentHashMap<>();
    static final Map<String, String> finalizedEvents = new ConcurrentHashMap<>();
    static final Deque<Map<String, Object>> ledger = new ArrayDeque<>();
    static final AtomicLong authzSeq = new AtomicLong();

    static final class Account {
        int available;
        int held;
        int spent;
        Account(int available) { this.available = available; }
    }

    record Reservation(String operationId, String billingSubjectRef, String authorizationId) {}

    public static void main(String[] args) throws Exception {
        INITIAL_BALANCE.forEach((user, balance) -> accounts.put(user, new Account(balance)));

        InetSocketAddress pageAddress = new InetSocketAddress(BIND_HOST, PAGE_PORT);
        HttpServer page;
        if (PAGE_TLS) {
            HttpsServer https = HttpsServer.create(pageAddress, 0);
            https.setHttpsConfigurator(new HttpsConfigurator(sslContext()));
            page = https;
        } else {
            page = HttpServer.create(pageAddress, 0);
        }
        page.createContext("/", PartnerServer::route);
        page.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        page.start();

        if (CALLBACK_PORT > 0) {
            HttpServer callbacks = HttpServer.create(new InetSocketAddress("127.0.0.1", CALLBACK_PORT), 0);
            callbacks.createContext("/", PartnerServer::routeCallbacksOnly);
            callbacks.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
            callbacks.start();
        }

        System.out.println("""
                [partner] page        %s%s/  (listening %s://%s:%d)
                [partner] callbacks   %s%s/rabbitvis/billing/{authorize,finalize}%s
                [partner] RabbitVis   origin=%s api=%s
                [partner] partnerId   %s  tenant=%s
                [partner] sdk dist    %s
                """.formatted(PAGE_ORIGIN, BASE_PATH, PAGE_TLS ? "https" : "http", BIND_HOST, PAGE_PORT,
                PAGE_ORIGIN, BASE_PATH, CALLBACK_PORT > 0 ? "  (also http://127.0.0.1:" + CALLBACK_PORT + ")" : "",
                RABBITVIS_ORIGIN, RABBITVIS_API_BASE, PARTNER_ID, TENANT_ID, SDK_DIST));
    }

    static SSLContext sslContext() throws Exception {
        if (!Files.exists(KEYSTORE)) {
            throw new IllegalStateException("缺少 " + KEYSTORE + "，先运行 ./run.sh（会用 keytool 生成自签证书）");
        }
        KeyStore store = KeyStore.getInstance("PKCS12");
        try (InputStream in = new FileInputStream(KEYSTORE.toFile())) {
            store.load(in, KEYSTORE_PASSWORD.toCharArray());
        }
        KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        kmf.init(store, KEYSTORE_PASSWORD.toCharArray());
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(kmf.getKeyManagers(), null, null);
        return context;
    }

    static String appPath(String rawPath) {
        if (BASE_PATH.isEmpty()) return rawPath;
        if (rawPath.equals(BASE_PATH)) return "/";
        return rawPath.startsWith(BASE_PATH + "/") ? rawPath.substring(BASE_PATH.length()) : null;
    }

    static void route(HttpExchange ex) throws IOException {
        try {
            String path = appPath(ex.getRequestURI().getPath());
            String method = ex.getRequestMethod();
            if (path == null) {
                sendJson(ex, 404, Map.of("error", "not_found"));
            } else if (path.endsWith("/rabbitvis/billing/authorize") || path.endsWith("/rabbitvis/billing/finalize")) {
                handleCallback(ex);
            } else if (method.equals("GET") && (path.equals("/") || path.equals("/index.html"))) {
                send(ex, 200, "text/html; charset=utf-8", PAGE_HTML
                        .replace("__RABBITVIS_ORIGIN__", RABBITVIS_ORIGIN)
                        .replace("__BASE__", BASE_PATH));
            } else if (method.equals("GET") && path.startsWith("/sdk/")) {
                serveSdk(ex, path.substring("/sdk/".length()));
            } else if (method.equals("POST") && path.equals("/api/login")) {
                handleLogin(ex);
            } else if (method.equals("POST") && path.equals("/api/rabbitvis/embed-session")) {
                handleEmbedSession(ex);
            } else if (method.equals("GET") && path.equals("/api/me")) {
                handleMe(ex);
            } else if (method.equals("GET") && path.equals("/api/ledger")) {
                synchronized (ledger) { sendJson(ex, 200, Map.of("entries", new ArrayList<>(ledger))); }
            } else {
                sendJson(ex, 404, Map.of("error", "not_found"));
            }
        } catch (Exception error) {
            error.printStackTrace();
            sendJson(ex, 500, Map.of("error", "internal_error"));
        } finally {
            ex.close();
        }
    }

    static void routeCallbacksOnly(HttpExchange ex) throws IOException {
        try {
            String path = ex.getRequestURI().getPath();
            if (path.endsWith("/rabbitvis/billing/authorize") || path.endsWith("/rabbitvis/billing/finalize")) {
                handleCallback(ex);
            } else {
                sendJson(ex, 404, Map.of("error", "not_found"));
            }
        } catch (Exception error) {
            error.printStackTrace();
            sendJson(ex, 503, Map.of("error", "temporarily_unavailable"));
        } finally {
            ex.close();
        }
    }

    // ---------------------------------------------------------------- 合作方自己的页面接口

    static void handleLogin(HttpExchange ex) throws IOException {
        if (!sameOrigin(ex)) { sendJson(ex, 403, Map.of("error", "bad_origin")); return; }
        Object user = asMap(Json.parse(readBody(ex))).get("user");
        if (!(user instanceof String name) || !accounts.containsKey(name)) {
            sendJson(ex, 400, Map.of("error", "unknown_user"));
            return;
        }
        String sid = randomToken();
        sessions.put(sid, name);
        ex.getResponseHeaders().add("Set-Cookie", "partner_java_sid=" + sid + "; Path=" + (BASE_PATH.isEmpty() ? "/" : BASE_PATH) + "; HttpOnly; Secure; SameSite=Lax");
        sendJson(ex, 200, Map.of("user", name));
    }

    static void handleMe(HttpExchange ex) throws IOException {
        String user = currentUser(ex);
        if (user == null) { sendJson(ex, 401, Map.of("error", "login_required")); return; }
        Account account = accounts.get(user);
        synchronized (account) {
            sendJson(ex, 200, Map.of("user", user, "available", account.available,
                    "held", account.held, "spent", account.spent));
        }
    }

    /**
     * 文档第 2 节：浏览器 → 这里（验自己的登录态 + CSRF）→ RabbitVis POST /v1/partner/embed-sessions。
     * 用户身份只从服务端会话取；partnerApiKey 永远不出现在浏览器里。
     */
    static void handleEmbedSession(HttpExchange ex) throws IOException, InterruptedException {
        if (!sameOrigin(ex)) { sendJson(ex, 403, Map.of("error", "bad_origin")); return; }
        String user = currentUser(ex);
        if (user == null) { sendJson(ex, 401, Map.of("error", "login_required")); return; }

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("tenantId", TENANT_ID);
        body.put("externalUserId", "local_user_" + user);
        body.put("externalProjectId", "default_" + user);
        body.put("billingSubjectRef", "billing_" + user);
        body.put("origin", PAGE_ORIGIN);
        body.put("scopes", List.of("session:read", "run:create"));
        body.put("sessionTitle", user + " 的设计");

        HttpRequest request = HttpRequest.newBuilder(URI.create(RABBITVIS_API_BASE + "/v1/partner/embed-sessions"))
                .timeout(Duration.ofSeconds(15))
                .header("Authorization", "Bearer " + PARTNER_API_KEY)
                .header("Content-Type", "application/json")
                .header("Idempotency-Key", "embed_" + user + "_" + UUID.randomUUID())
                .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(body)))
                .build();
        HttpResponse<String> response = HTTP.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 201) {
            System.err.println("[partner] embed-sessions " + response.statusCode() + " " + response.body());
            sendJson(ex, 502, Map.of("error", "rabbitvis_embed_session_failed",
                    "status", response.statusCode(), "detail", truncate(response.body(), 300)));
            return;
        }
        Map<String, Object> created = asMap(Json.parse(response.body()));
        System.out.println("[partner] embed session " + created.get("embedSessionId") + " → " + created.get("sessionId"));
        sendJson(ex, 200, Map.of("embedUrl", created.get("embedUrl")));
    }

    // ---------------------------------------------------------------- RabbitVis 回调

    static void handleCallback(HttpExchange ex) throws IOException {
        byte[] raw = ex.getRequestBody().readAllBytes();
        String rejection = verifySignature(ex, raw);
        if (rejection != null) {
            System.err.println("[partner] callback rejected: " + rejection);
            sendJson(ex, 401, Map.of("error", rejection));
            return;
        }
        Map<String, Object> payload = asMap(Json.parse(new String(raw, StandardCharsets.UTF_8)));
        String path = ex.getRequestURI().getPath();
        Map<String, Object> result = path.endsWith("/authorize") ? authorize(payload) : finalizeEvent(payload);
        record(path.endsWith("/authorize") ? "AUTHORIZE" : String.valueOf(payload.get("kind")), payload, result);
        sendJson(ex, 200, result);
    }

    /** 文档 4.2：头检查 → 时间戳 → 请求体摘要 → HMAC → 最后才记 nonce；比较一律常量时间。 */
    static String verifySignature(HttpExchange ex, byte[] raw) {
        var h = ex.getRequestHeaders();
        String contract = header(h, "X-RabbitVis-Contract");
        String partnerId = header(h, "X-RabbitVis-Partner-Id");
        String timestamp = header(h, "X-RabbitVis-Timestamp");
        String nonce = header(h, "X-RabbitVis-Nonce");
        String idempotencyKey = header(h, "Idempotency-Key");
        String claimedDigest = header(h, "X-RabbitVis-Body-SHA256");
        String signatureHeader = header(h, "X-RabbitVis-Signature");
        String signature = signatureHeader.startsWith("v1=") ? signatureHeader.substring(3) : "";

        if (!CONTRACT.equals(contract)
                || !PARTNER_ID.equals(partnerId)
                || !"POST".equals(ex.getRequestMethod())
                || !header(h, "Content-Type").toLowerCase().startsWith("application/json")
                || !"application/json".equalsIgnoreCase(header(h, "Accept"))
                || !"identity".equalsIgnoreCase(header(h, "Accept-Encoding"))
                || nonce.isEmpty() || idempotencyKey.isEmpty()) {
            return "invalid_signature";
        }

        Instant sentAt;
        try {
            sentAt = Instant.parse(timestamp);
        } catch (Exception e) {
            return "invalid_signature";
        }
        if (Math.abs(Duration.between(sentAt, Instant.now()).toSeconds()) > TOLERANCE_SECONDS) {
            return "signature_expired";
        }

        String digest = HexFormat.of().formatHex(sha256(raw));
        if (!claimedDigest.matches("[a-f0-9]{64}") || !constantTimeEquals(digest, claimedDigest)) {
            return "invalid_signature";
        }

        URI uri = ex.getRequestURI();
        String target = uri.getRawPath() + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery());
        String canonical = String.join("\n", "v1", "POST", target, timestamp, nonce, idempotencyKey, digest);
        String expected = Base64.getUrlEncoder().withoutPadding().encodeToString(hmacSha256(BILLING_SIGNING_SECRET, canonical));
        if (!signature.matches("[A-Za-z0-9_-]{43}") || !constantTimeEquals(expected, signature)) {
            return "invalid_signature";
        }

        long now = System.currentTimeMillis();
        nonces.values().removeIf(expiresAt -> expiresAt < now);
        if (nonces.putIfAbsent(nonce, now + TOLERANCE_SECONDS * 2 * 1000) != null) {
            return "nonce_replayed";
        }
        return null;
    }

    /** 文档 4.3：同一个 operationId 永远返回第一次的决定；允许时预占 1 次。 */
    static Map<String, Object> authorize(Map<String, Object> payload) {
        String operationId = String.valueOf(payload.get("operationId"));
        return authorizeResults.computeIfAbsent(operationId, id -> {
            String subject = String.valueOf(payload.get("billingSubjectRef"));
            Account account = accounts.get(subject.replaceFirst("^billing_", ""));
            Map<String, Object> decision = new LinkedHashMap<>();
            decision.put("schemaVersion", "1");
            if (account == null) {
                decision.put("decision", "deny");
                decision.put("reason", "unknown_billing_subject");
                return decision;
            }
            synchronized (account) {
                if (account.available <= 0) {
                    decision.put("decision", "deny");
                    decision.put("reason", "insufficient_balance");
                    return decision;
                }
                account.available -= 1;
                account.held += 1;
            }
            String authorizationId = "authz_local_" + authzSeq.incrementAndGet();
            reservations.put(id, new Reservation(id, subject, authorizationId));
            decision.put("decision", "allow");
            decision.put("authorizationId", authorizationId);
            return decision;
        });
    }

    /** 文档 4.4：按 eventId 幂等；FINALIZE+succeeded 实扣，其余一律退回预占。 */
    static Map<String, Object> finalizeEvent(Map<String, Object> payload) {
        String eventId = String.valueOf(payload.get("eventId"));
        Map<String, Object> ack = new LinkedHashMap<>();
        ack.put("schemaVersion", "1");
        ack.put("accepted", true);
        ack.put("eventId", eventId);
        if (finalizedEvents.putIfAbsent(eventId, String.valueOf(payload.get("operationId"))) != null) {
            ack.put("duplicate", true);
            return ack;
        }
        Reservation reservation = reservations.remove(String.valueOf(payload.get("operationId")));
        if (reservation != null) {
            Account account = accounts.get(reservation.billingSubjectRef().replaceFirst("^billing_", ""));
            boolean capture = "FINALIZE".equals(payload.get("kind")) && "succeeded".equals(payload.get("outcome"));
            synchronized (account) {
                account.held -= 1;
                if (capture) account.spent += 1; else account.available += 1;
            }
        }
        ack.put("duplicate", false);
        return ack;
    }

    static void record(String kind, Map<String, Object> payload, Map<String, Object> result) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("at", Instant.now().toString());
        entry.put("kind", kind);
        entry.put("billingSubjectRef", payload.get("billingSubjectRef"));
        entry.put("operation", payload.get("operation"));
        entry.put("turnId", payload.get("turnId"));
        entry.put("outcome", payload.get("outcome"));
        entry.put("estimate", payload.get("estimate"));
        entry.put("actualUsage", payload.get("actualUsage"));
        entry.put("result", result);
        System.out.println("[partner] " + kind + " " + Json.stringify(entry));
        synchronized (ledger) {
            ledger.addFirst(entry);
            while (ledger.size() > 50) ledger.removeLast();
        }
    }

    // ---------------------------------------------------------------- 工具

    static void serveSdk(HttpExchange ex, String name) throws IOException {
        Path file = SDK_DIST.resolve(name).normalize();
        if (!file.startsWith(SDK_DIST) || !Files.isRegularFile(file)) {
            sendJson(ex, 404, Map.of("error", "sdk_file_not_found", "dir", SDK_DIST.toString()));
            return;
        }
        String type = name.endsWith(".js") ? "text/javascript; charset=utf-8" : "application/json";
        send(ex, 200, type, Files.readString(file));
    }

    static boolean sameOrigin(HttpExchange ex) {
        return PAGE_ORIGIN.equals(header(ex.getRequestHeaders(), "Origin"));
    }

    static String currentUser(HttpExchange ex) {
        for (String cookieHeader : ex.getRequestHeaders().getOrDefault("Cookie", List.of())) {
            for (String part : cookieHeader.split(";")) {
                String[] kv = part.trim().split("=", 2);
                if (kv.length == 2 && kv[0].equals("partner_java_sid")) return sessions.get(kv[1]);
            }
        }
        return null;
    }

    static String header(com.sun.net.httpserver.Headers headers, String name) {
        String value = headers.getFirst(name);
        return value == null ? "" : value;
    }

    static String readBody(HttpExchange ex) throws IOException {
        return new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
    }

    static void sendJson(HttpExchange ex, int status, Object body) throws IOException {
        send(ex, status, "application/json; charset=utf-8", Json.stringify(body));
    }

    static void send(HttpExchange ex, int status, String contentType, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", contentType);
        ex.getResponseHeaders().set("Cache-Control", "no-store");
        ex.sendResponseHeaders(status, bytes.length);
        ex.getResponseBody().write(bytes);
    }

    static byte[] sha256(byte[] data) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(data);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static byte[] hmacSha256(String secret, String data) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return mac.doFinal(data.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static boolean constantTimeEquals(String a, String b) {
        return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }

    static String randomToken() {
        byte[] bytes = new byte[24];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> asMap(Object value) {
        return value instanceof Map<?, ?> map ? (Map<String, Object>) map : Map.of();
    }

    static String truncate(String value, int max) {
        return value.length() <= max ? value : value.substring(0, max);
    }

    static String env(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value.trim();
    }

    static String required(String name) {
        String value = env(name, "");
        if (value.isEmpty()) {
            System.err.println("[partner] 缺少环境变量 " + name + "（由 RabbitVis 提供，见 README）");
            System.exit(2);
        }
        return value;
    }

    static int intEnv(String name, int fallback) {
        return Integer.parseInt(env(name, String.valueOf(fallback)));
    }

    /** 最小 JSON 实现，只为让示例保持零依赖；真实项目用 Jackson / Gson。 */
    static final class Json {
        private final String s;
        private int i;

        private Json(String s) { this.s = s; }

        static Object parse(String text) {
            Json p = new Json(text);
            Object value = p.value();
            p.ws();
            if (p.i != p.s.length()) throw new IllegalArgumentException("trailing json");
            return value;
        }

        static String stringify(Object v) {
            if (v == null) return "null";
            if (v instanceof String str) return quote(str);
            if (v instanceof Number || v instanceof Boolean) return v.toString();
            if (v instanceof Map<?, ?> map) {
                StringBuilder sb = new StringBuilder("{");
                for (var e : map.entrySet()) {
                    if (sb.length() > 1) sb.append(',');
                    sb.append(quote(String.valueOf(e.getKey()))).append(':').append(stringify(e.getValue()));
                }
                return sb.append('}').toString();
            }
            if (v instanceof Iterable<?> list) {
                StringBuilder sb = new StringBuilder("[");
                for (Object item : list) {
                    if (sb.length() > 1) sb.append(',');
                    sb.append(stringify(item));
                }
                return sb.append(']').toString();
            }
            return quote(v.toString());
        }

        private static String quote(String str) {
            StringBuilder sb = new StringBuilder("\"");
            for (char c : str.toCharArray()) {
                switch (c) {
                    case '"' -> sb.append("\\\"");
                    case '\\' -> sb.append("\\\\");
                    case '\n' -> sb.append("\\n");
                    case '\r' -> sb.append("\\r");
                    case '\t' -> sb.append("\\t");
                    default -> {
                        if (c < 0x20 || c == '<' || c == '>') sb.append(String.format("\\u%04x", (int) c));
                        else sb.append(c);
                    }
                }
            }
            return sb.append('"').toString();
        }

        private void ws() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
        }

        private Object value() {
            ws();
            if (i >= s.length()) throw new IllegalArgumentException("unexpected end");
            char c = s.charAt(i);
            if (c == '{') return object();
            if (c == '[') return array();
            if (c == '"') return string();
            if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
            if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
            if (s.startsWith("null", i)) { i += 4; return null; }
            int start = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
            String num = s.substring(start, i);
            if (num.isEmpty()) throw new IllegalArgumentException("bad json at " + start);
            return num.contains(".") || num.contains("e") || num.contains("E") ? Double.parseDouble(num) : Long.parseLong(num);
        }

        private Map<String, Object> object() {
            Map<String, Object> map = new LinkedHashMap<>();
            i++;
            ws();
            if (s.charAt(i) == '}') { i++; return map; }
            while (true) {
                ws();
                String key = string();
                ws();
                if (s.charAt(i++) != ':') throw new IllegalArgumentException("expected :");
                map.put(key, value());
                ws();
                char c = s.charAt(i++);
                if (c == '}') return map;
                if (c != ',') throw new IllegalArgumentException("expected ,");
            }
        }

        private List<Object> array() {
            List<Object> list = new ArrayList<>();
            i++;
            ws();
            if (s.charAt(i) == ']') { i++; return list; }
            while (true) {
                list.add(value());
                ws();
                char c = s.charAt(i++);
                if (c == ']') return list;
                if (c != ',') throw new IllegalArgumentException("expected ,");
            }
        }

        private String string() {
            if (s.charAt(i) != '"') throw new IllegalArgumentException("expected string");
            i++;
            StringBuilder sb = new StringBuilder();
            while (true) {
                char c = s.charAt(i++);
                if (c == '"') return sb.toString();
                if (c != '\\') { sb.append(c); continue; }
                char e = s.charAt(i++);
                switch (e) {
                    case 'n' -> sb.append('\n');
                    case 'r' -> sb.append('\r');
                    case 't' -> sb.append('\t');
                    case 'b' -> sb.append('\b');
                    case 'f' -> sb.append('\f');
                    case 'u' -> { sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; }
                    default -> sb.append(e);
                }
            }
        }
    }

    static final String PAGE_HTML = """
            <!doctype html>
            <html lang="zh-CN">
            <head>
              <meta charset="utf-8">
              <title>Partner (Java) · RabbitVis Embed 本地联调</title>
              <style>
                * { box-sizing: border-box; }
                body { margin: 0; font: 14px/1.5 system-ui, sans-serif; display: grid; grid-template-columns: 320px 1fr; height: 100vh; }
                aside { padding: 16px; border-right: 1px solid #ddd; overflow: auto; background: #fafafa; }
                main { position: relative; }
                #rabbitvis { position: absolute; inset: 0; }
                h1 { font-size: 16px; margin: 0 0 12px; }
                h2 { font-size: 13px; margin: 18px 0 6px; color: #555; }
                button { margin-right: 6px; }
                .balance { font-size: 22px; font-weight: 600; }
                pre { white-space: pre-wrap; word-break: break-all; font-size: 11px; background: #fff; border: 1px solid #eee; padding: 6px; margin: 0 0 6px; }
                .muted { color: #888; }
              </style>
            </head>
            <body>
              <aside>
                <h1>合作方页面（Java 后端）</h1>
                <div>
                  <button data-user="alice">登录 alice（5 次）</button>
                  <button data-user="bob">登录 bob（0 次）</button>
                </div>
                <h2>余额（合作方自己的账）</h2>
                <div id="me" class="muted">未登录</div>
                <h2>SDK 事件</h2>
                <div id="events"></div>
                <h2>收到的回调</h2>
                <div id="ledger" class="muted">暂无</div>
              </aside>
              <main><div id="rabbitvis"></div></main>
              <script type="module">
                import { mountRabbitVisEmbed } from '__BASE__/sdk/index.js'

                let embed = null
                const $ = (id) => document.getElementById(id)
                const log = (text) => {
                  const pre = document.createElement('pre')
                  pre.textContent = new Date().toLocaleTimeString() + ' ' + text
                  $('events').prepend(pre)
                }

                async function refresh() {
                  const me = await fetch('__BASE__/api/me')
                  if (me.ok) {
                    const m = await me.json()
                    $('me').innerHTML = `<div>${m.user}</div><div class="balance">${m.available}</div>
                      <div class="muted">预占 ${m.held} · 已扣 ${m.spent}</div>`
                  }
                  const ledger = await (await fetch('__BASE__/api/ledger')).json()
                  $('ledger').replaceChildren(...ledger.entries.map((e) => {
                    const pre = document.createElement('pre')
                    pre.textContent = JSON.stringify(e, null, 1)
                    return pre
                  }))
                }

                async function login(user) {
                  const res = await fetch('__BASE__/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user }),
                  })
                  if (!res.ok) return log('login failed ' + res.status)
                  embed?.destroy()
                  try {
                    embed = await mountRabbitVisEmbed({
                      container: $('rabbitvis'),
                      rabbitVisOrigin: '__RABBITVIS_ORIGIN__',
                      sessionEndpoint: '__BASE__/api/rabbitvis/embed-session',
                      onEvent(event) {
                        log(event.type + ' ' + JSON.stringify(event.payload))
                        if (event.type === 'run.settled') refresh()
                      },
                    })
                  } catch (error) {
                    log('mount failed: ' + error.message)
                  }
                  refresh()
                }

                document.querySelectorAll('button[data-user]').forEach((b) => b.onclick = () => login(b.dataset.user))
                setInterval(refresh, 4000)
              </script>
            </body>
            </html>
            """;
}
