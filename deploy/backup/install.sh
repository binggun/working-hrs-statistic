#!/usr/bin/env bash
set -euo pipefail
cd /tmp/pawhub-backup-setup
install -d -m 700 /var/lib/pawhub-backup
docker pull public.ecr.aws/aws-cli/aws-cli:2.38.5
image=$(docker image inspect public.ecr.aws/aws-cli/aws-cli:2.38.5 --format '{{index .RepoDigests 0}}')
python3 - "$image" <<'PY'
import json,pathlib,sys
p=pathlib.Path('/etc/pawhub-backup.json')
p.write_text(json.dumps({'bucket':'pawhub-signin-backups-877955776267','db_container':'working-hrs-statistic-db-1','aws_image':sys.argv[1]},indent=2)+'\n')
p.chmod(0o600)
PY
install -m 750 pawhub-db-backup /usr/local/sbin/pawhub-db-backup
install -m 644 pawhub-db-backup.service pawhub-db-backup.timer pawhub-backup-health.service pawhub-backup-health.timer /etc/systemd/system/
python3 -m py_compile /usr/local/sbin/pawhub-db-backup
systemd-analyze verify /etc/systemd/system/pawhub-db-backup.service /etc/systemd/system/pawhub-db-backup.timer /etc/systemd/system/pawhub-backup-health.service /etc/systemd/system/pawhub-backup-health.timer
systemd-analyze calendar '*-*-* 03:00:00 Pacific/Auckland'
cp -p /opt/pawhub/working-hrs-statistic/deploy/backup.sh /var/lib/pawhub-backup/original-backup.sh
printf '#!/usr/bin/env bash\nset -euo pipefail\nexec /usr/local/sbin/pawhub-db-backup "$@"\n' > /opt/pawhub/working-hrs-statistic/deploy/backup.sh
chmod 750 /opt/pawhub/working-hrs-statistic/deploy/backup.sh
systemctl daemon-reload
systemctl start pawhub-db-backup.service
systemctl enable --now pawhub-db-backup.timer pawhub-backup-health.timer
systemctl start pawhub-backup-health.service
systemctl list-timers 'pawhub*' --all --no-pager
