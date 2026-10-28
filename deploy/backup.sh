#!/usr/bin/env bash
set -euo pipefail
exec /usr/local/sbin/pawhub-db-backup "$@"
