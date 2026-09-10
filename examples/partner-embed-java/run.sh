#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

KEYSTORE="${KEYSTORE:-local-keystore.p12}"
KEYSTORE_PASSWORD="${KEYSTORE_PASSWORD:-changeit}"

if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair -alias partner-local -keyalg EC -groupname secp256r1 -validity 3650 \
    -dname "CN=localhost" -ext "SAN=dns:localhost,ip:127.0.0.1" \
    -storetype PKCS12 -keystore "$KEYSTORE" -storepass "$KEYSTORE_PASSWORD" -keypass "$KEYSTORE_PASSWORD" >/dev/null
  echo "[run] generated self-signed $KEYSTORE (browser will warn once for https://localhost:8443)"
fi

if [ ! -f "${SDK_DIST:-../../sdk/dist}/index.js" ]; then
  (cd ../../sdk && npm install --no-audit --no-fund && npm run build)
fi

exec java PartnerServer.java
