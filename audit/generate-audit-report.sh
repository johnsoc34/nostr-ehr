#!/bin/bash
# Audit Log Generator - extracts relay events into audit trail

AUDIT_DIR="/home/nostr/audit"
DB_PATH="/home/nostr/data/nostr.db"
OUTPUT_FILE="$AUDIT_DIR/audit-log.json"

# Query relay database with proper hex encoding
sqlite3 -json $DB_PATH << 'EOF' > $OUTPUT_FILE
SELECT 
    datetime(created_at, 'unixepoch') as timestamp,
    hex(event_hash) as event_id,
    kind,
    hex(author) as author_pubkey,
    CASE kind
        WHEN 1000 THEN 'Patient'
        WHEN 1001 THEN 'Encounter'
        WHEN 1002 THEN 'MedicationRequest'
        WHEN 1003 THEN 'Observation'
        WHEN 1004 THEN 'Condition'
        WHEN 1005 THEN 'AllergyIntolerance'
        WHEN 1006 THEN 'Immunization'
        WHEN 1007 THEN 'Message'
        WHEN 1008 THEN 'ServiceRequest'
        WHEN 1009 THEN 'DiagnosticReport'
        ELSE 'Other'
    END as event_type,
    datetime(first_seen, 'unixepoch') as first_seen_time
FROM event
WHERE kind >= 1000 AND kind <= 1009
ORDER BY created_at DESC
LIMIT 500;
EOF

echo "Audit report generated: $OUTPUT_FILE"
