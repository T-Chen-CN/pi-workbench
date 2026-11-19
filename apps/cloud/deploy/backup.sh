#!/usr/bin/env bash
# Pi Cloud 每日备份：账号、加密配置、工单与云端会话记录。
#
# 备份目标是「能恢复出同一台云端」，所以必须包含：
#   accounts.json（管理员口令哈希）/ config.json（AES 密文，要有同一个 PI_CLOUD_ENC_KEY 才能解）
#   devices.json / pairing.json / tasks.json / authorizations.json / units.json
#   agent/sessions/（云端会话 JSONL —— 历史与导出的唯一真相源）
# 保留 7 天；备份目录不在 releases 里，更新不会碰它。
set -euo pipefail

DATA_DIR="${PI_CLOUD_DATA_DIR:-/var/lib/pi-cloud}"
BACKUP_DIR="${PI_CLOUD_BACKUP_DIR:-/var/backups/pi-cloud}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="${BACKUP_DIR}/pi-cloud-${STAMP}.tar.gz"

mkdir -p "${BACKUP_DIR}"

if [ ! -d "${DATA_DIR}" ]; then
  echo "data dir missing: ${DATA_DIR}" >&2
  exit 1
fi

tar czf "${ARCHIVE}.part" \
  -C "${DATA_DIR}" \
  --exclude='workspace' \
  --exclude='cache' \
  --exclude='*.tmp' \
  .

mv "${ARCHIVE}.part" "${ARCHIVE}"
chmod 600 "${ARCHIVE}"

# 留 7 天
find "${BACKUP_DIR}" -name 'pi-cloud-*.tar.gz' -type f -mtime +7 -delete

echo "backup written: ${ARCHIVE} ($(du -h "${ARCHIVE}" | cut -f1))"
