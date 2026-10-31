#!/usr/bin/env bash
# One-time server setup, run once with sudo from the app folder:   sudo bash deploy/server-setup.sh
#   1. the deploy user may run docker (the docker group), so the app is rebuilt and restarted without sudo
#   2. the nginx catch-all site: the bare IP and unknown names go to https://dosije.online (http) or are refused (https)
# The domain itself (its own nginx site and certificate) comes from deploy/domain-setup.sh.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME="${SUDO_USER:-$(stat -c %U "$APP_DIR")}"

echo "1/2  docker grupa za korisnika $USER_NAME"
usermod -aG docker "$USER_NAME"

echo "2/2  nginx: podrazumevani sajt za IP i nepoznata imena"
cp "$APP_DIR/deploy/nginx/catchall.conf" /etc/nginx/sites-available/catchall
ln -sf /etc/nginx/sites-available/catchall /etc/nginx/sites-enabled/catchall
nginx -t
systemctl reload nginx

echo
echo "Gotovo. Sledeće: sudo bash deploy/domain-setup.sh (kad DNS za dosije.online pokazuje na ovaj server)"
