#!/bin/bash
# encrypt-for-upload.sh <file>
#
# Shared by every backup script on the VM: age-encrypts <file> to the master
# backup key, proves the result decrypts back to the same content, removes the
# plaintext, and prints the new path (<file>.age) for the caller to upload:
#
#   OUTFILE=$(/home/ofir/scripts/encrypt-for-upload.sh "$OUTFILE")
#   gsutil cp "$OUTFILE" "gs://m84-backups/<app>/$(basename "$OUTFILE")"
#
# Fails (non-zero, nothing printed) rather than ever letting a caller upload
# plaintext. restore-drill.sh decrypts .age objects with the private key.
# Security review 2026-11-28.
set -euo pipefail
f="${1:?usage: encrypt-for-upload.sh <file>}"
PUB=/home/ofir/.config/age/m84-backups.pub
KEY=/home/ofir/.config/age/m84-backups.key
[ -s "$f" ]   || { echo "encrypt-for-upload: $f missing or empty" >&2; exit 1; }
[ -s "$PUB" ] || { echo "encrypt-for-upload: $PUB missing - refusing" >&2; exit 1; }
age -R "$PUB" -o "$f.age" "$f"
chmod 600 "$f.age"
age -d -i "$KEY" "$f.age" | cmp -s - "$f" || { rm -f "$f.age"; echo "encrypt-for-upload: verification failed for $f" >&2; exit 1; }
rm -f "$f"
echo "$f.age"
