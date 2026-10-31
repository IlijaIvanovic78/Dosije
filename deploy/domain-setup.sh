#!/usr/bin/env bash
# dosije.online on this server, run once with sudo from the app folder (after the DNS records point here):
#   sudo bash deploy/domain-setup.sh
#   1. checks that dosije.online and www.dosije.online resolve to this server (stops if not)
#   2. backs up /etc/nginx
#   3. gets a Let's Encrypt certificate for both names (certbot, nginx plugin); renewals reload nginx on their own
#   4. installs the nginx site deploy/nginx/dosije.online.conf, tests it, reloads nginx (rolls back if the test fails)
#   5. proves the automatic renewal works (certbot renew --dry-run)
# The other sites on the server are not touched.
set -euo pipefail

DOMAIN="dosije.online"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IP="$(hostname -I | awk '{print $1}')"
SITE=/etc/nginx/sites-available/$DOMAIN

echo "1/5  DNS"
for name in "$DOMAIN" "www.$DOMAIN"; do
	got="$(getent ahostsv4 "$name" | awk 'NR==1{print $1}')"
	if [ "$got" != "$IP" ]; then
		echo "  $name -> ${got:-(nema zapisa)}, a treba $IP. Podesite A zapis na Spaceship-u, sačekajte par minuta i pokrenite ponovo."
		exit 1
	fi
	echo "  $name -> $got  OK"
done

echo "2/5  rezervna kopija nginx podešavanja"
BACKUP="/root/nginx-backup-$(date +%Y%m%d-%H%M%S).tgz"
tar czf "$BACKUP" -C / etc/nginx
echo "  $BACKUP"

echo "3/5  sertifikat (Let's Encrypt)"
certbot certonly --nginx --non-interactive --keep-until-expiring \
	--deploy-hook "systemctl reload nginx" \
	-d "$DOMAIN" -d "www.$DOMAIN"

echo "4/5  nginx sajt za $DOMAIN"
cp "$APP_DIR/deploy/nginx/$DOMAIN.conf" "$SITE"
ln -sf "$SITE" "/etc/nginx/sites-enabled/$DOMAIN"
if ! nginx -t; then
	echo "  nginx test nije prošao: sajt $DOMAIN je isključen, ostalo je kao pre"
	rm -f "/etc/nginx/sites-enabled/$DOMAIN"
	exit 1
fi
systemctl reload nginx

echo "5/5  automatsko obnavljanje (proba)"
certbot renew --dry-run --cert-name "$DOMAIN"
systemctl is-active --quiet certbot.timer && echo "  certbot.timer radi (obnavlja dva puta dnevno kad je potrebno)"

echo
echo "Gotovo: https://$DOMAIN  (http i www preusmeravaju ovde)"
