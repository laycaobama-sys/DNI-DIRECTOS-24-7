#!/usr/bin/env bash
# Instala un nodo de emisión de DNI Directos en un servidor dedicado (Ubuntu 24.04 / Debian 12).
# Uso (como root):  bash install.sh https://TU-DOMINIO  nombre-del-nodo  [capacidad]
# Después, pega el ENGINE_TOKEN en /etc/dni-node.env (nunca lo compartas) y arranca:  systemctl start dni-node
set -euo pipefail
API_URL="${1:?Indica la URL de la plataforma, p. ej. https://dni-directos.ejemplo.com}"
NODE_ID="${2:-dedicado-1}"
CAPACITY="${3:-60}"

if [[ "$NODE_ID" == cf-node-* ]]; then echo "El nombre no puede empezar por cf-node- (reservado a Cloudflare)"; exit 1; fi

apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg ca-certificates curl
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
fi

id dni >/dev/null 2>&1 || useradd --system --home /var/lib/dni-node --shell /usr/sbin/nologin dni
install -d -o dni -g dni /var/lib/dni-node /opt/dni-node
install -m 0755 "$(dirname "$0")/dni-node.mjs" /opt/dni-node/dni-node.mjs

if [[ ! -f /etc/dni-node.env ]]; then
  cat > /etc/dni-node.env <<EOF
API_URL=$API_URL
ENGINE_TOKEN=PEGA_AQUI_EL_ENGINE_TOKEN
NODE_ID=$NODE_ID
CAPACITY=$CAPACITY
MEDIA_CONCURRENCY=2
DATA_DIR=/var/lib/dni-node
EOF
  chmod 600 /etc/dni-node.env
fi

cat > /etc/systemd/system/dni-node.service <<'EOF'
[Unit]
Description=DNI Directos - nodo de emision 24/7
After=network-online.target
Wants=network-online.target

[Service]
User=dni
EnvironmentFile=/etc/dni-node.env
ExecStart=/usr/bin/node /opt/dni-node/dni-node.mjs
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30
LimitNOFILE=65536
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=/var/lib/dni-node

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable dni-node >/dev/null
echo
echo "Listo. Falta un paso: edita /etc/dni-node.env y sustituye PEGA_AQUI_EL_ENGINE_TOKEN por tu ENGINE_TOKEN."
echo "Después:  systemctl start dni-node   y   journalctl -u dni-node -f   para ver el registro."
