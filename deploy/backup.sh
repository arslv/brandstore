#!/bin/sh
# Ночная копия базы и загруженных фото в /var/backups/brandstore, хранятся 14 дней.
D=/var/backups/brandstore
DAY=$(date +%F)
mkdir -p "$D"
sqlite3 /opt/brandstore/data/brandstore.db ".backup '$D/brandstore-$DAY.db'"
tar -czf "$D/uploads-$DAY.tar.gz" -C /opt/brandstore/public uploads 2>/dev/null || true
find "$D" -type f -mtime +14 -delete
