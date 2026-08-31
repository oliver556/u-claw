#!/usr/bin/env bash
set -euo pipefail

FRONT_IP="${FRONT_IP:-64.90.19.251}"
ORIGIN_PORTS="${ORIGIN_PORTS:-3000,8080}"

cat >/usr/local/sbin/uclaw-origin-firewall.sh <<SCRIPT
#!/usr/bin/env bash
set -euo pipefail

FRONT_IP="${FRONT_IP}"
ORIGIN_PORTS="${ORIGIN_PORTS}"

iptables -N DOCKER-USER 2>/dev/null || true

iptables -C DOCKER-USER -p tcp -s 127.0.0.1/32 -m multiport --dports "${ORIGIN_PORTS}" -j ACCEPT 2>/dev/null ||
  iptables -I DOCKER-USER 1 -p tcp -s 127.0.0.1/32 -m multiport --dports "${ORIGIN_PORTS}" -j ACCEPT

iptables -C DOCKER-USER -p tcp -s "${FRONT_IP}" -m multiport --dports "${ORIGIN_PORTS}" -j ACCEPT 2>/dev/null ||
  iptables -I DOCKER-USER 1 -p tcp -s "${FRONT_IP}" -m multiport --dports "${ORIGIN_PORTS}" -j ACCEPT

iptables -C DOCKER-USER -p tcp -m multiport --dports "${ORIGIN_PORTS}" -j DROP 2>/dev/null ||
  iptables -A DOCKER-USER -p tcp -m multiport --dports "${ORIGIN_PORTS}" -j DROP
SCRIPT

chmod 700 /usr/local/sbin/uclaw-origin-firewall.sh
/usr/local/sbin/uclaw-origin-firewall.sh

cat >/etc/systemd/system/uclaw-origin-firewall.service <<SERVICE
[Unit]
Description=Bavi-box origin Docker port allowlist
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/uclaw-origin-firewall.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable --now uclaw-origin-firewall.service
iptables -S DOCKER-USER
