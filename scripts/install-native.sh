#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "$(id -u)" -ne 0 ]]; then
  echo 'install-native.sh must run as root.' >&2
  exit 1
fi

id feather >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin feather

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl unzip \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 fonts-liberation

CHROMIUM_INSTALL_DIR=/opt/chrome-headless-shell bash "$ROOT/scripts/install-chromium.sh"

LIGHTPANDA_VERSION="${LIGHTPANDA_VERSION:-0.3.7}"
case "$(uname -m)" in
  x86_64|amd64) LIGHTPANDA_ASSET=lightpanda-x86_64-linux ;;
  aarch64|arm64) LIGHTPANDA_ASSET=lightpanda-aarch64-linux ;;
  *) echo "Unsupported Lightpanda architecture: $(uname -m)" >&2; exit 2 ;;
esac
curl -fsSL "https://github.com/lightpanda-io/browser/releases/download/${LIGHTPANDA_VERSION}/${LIGHTPANDA_ASSET}" -o /usr/local/bin/lightpanda
chmod 0755 /usr/local/bin/lightpanda
/usr/local/bin/lightpanda --version

corepack pnpm install --frozen-lockfile=false
corepack pnpm --filter @feather/execution-agent build

install -d -o feather -g feather /opt/feather-runtime /etc/feather-runtime
cp -a "$ROOT/." /opt/feather-runtime/
chown -R feather:feather /opt/feather-runtime
install -m 0644 "$ROOT/infra/systemd/feather-lightpanda.service" /etc/systemd/system/feather-lightpanda.service
install -m 0644 "$ROOT/infra/systemd/feather-agent.service" /etc/systemd/system/feather-agent.service

echo 'Create /etc/feather-runtime/agent.env, then:'
echo '  systemctl daemon-reload && systemctl enable --now feather-lightpanda feather-agent'
