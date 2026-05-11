#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/mauex-binance"
SERVICE_FILE="/etc/systemd/system/mauex-binance.service"

if [ "$EUID" -ne 0 ]; then
  echo "Ejecuta este instalador con sudo."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

mkdir -p "$APP_DIR"
cp ./mauex-binance-backend.js "$APP_DIR/mauex-binance-backend.js"

if [ ! -f "$APP_DIR/.env" ]; then
  cat > "$APP_DIR/.env" <<'ENV'
BINANCE_KEY=PEGAR_API_KEY_DE_BINANCE
BINANCE_SECRET=PEGAR_SECRET_KEY_DE_BINANCE
PORT=8080
ENV
fi

cat > "$SERVICE_FILE" <<'SERVICE'
[Unit]
Description=MAUex Binance Backend
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/mauex-binance
EnvironmentFile=/opt/mauex-binance/.env
ExecStart=/usr/bin/node /opt/mauex-binance/mauex-binance-backend.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable mauex-binance
systemctl restart mauex-binance

if command -v ufw >/dev/null 2>&1; then
  ufw allow 8080/tcp >/dev/null 2>&1 || true
fi

if command -v iptables >/dev/null 2>&1; then
  iptables -C INPUT -p tcp --dport 8080 -j ACCEPT >/dev/null 2>&1 || \
    iptables -I INPUT -p tcp --dport 8080 -j ACCEPT >/dev/null 2>&1 || true
fi

echo "Instalado. Ahora revisa /opt/mauex-binance/.env y pega tus claves de Binance si todavia no lo hiciste."
echo "Luego ejecuta: sudo systemctl restart mauex-binance"
