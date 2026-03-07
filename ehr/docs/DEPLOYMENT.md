# NostrEHR Deployment Guide

Self-host the complete NostrEHR stack on a Linux VPS. This guide covers everything from a blank Ubuntu server to a fully running system.

**Time estimate:** 2-3 hours for someone comfortable with Linux.

**Prerequisites:**
- Ubuntu 22.04+ VPS (Hetzner, DigitalOcean, Linode, etc.) — 2 CPU, 4GB RAM minimum
- A domain name with DNS control (e.g., `yourpractice.com`)
- SSH access to the server

---

## 1. DNS Setup

Create A records pointing to your server IP for all subdomains:

```
relay.yourpractice.com      → YOUR_SERVER_IP
portal.yourpractice.com     → YOUR_SERVER_IP
billing.yourpractice.com    → YOUR_SERVER_IP
calendar.yourpractice.com   → YOUR_SERVER_IP
blossom.yourpractice.com    → YOUR_SERVER_IP
fhir.yourpractice.com       → YOUR_SERVER_IP
turn.yourpractice.com       → YOUR_SERVER_IP   (for telehealth)
```

---

## 2. Server Base Setup

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Install PM2 globally
npm install -g pm2

# Install build tools (needed for nostr-rs-relay)
apt install -y build-essential git nginx certbot python3-certbot-nginx sqlite3

# Install Rust (needed for nostr-rs-relay)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# Create app user
useradd -m -s /bin/bash nostr

# Create data directories
mkdir -p /var/lib/immutable-health/{attachments}
mkdir -p /home/nostr/{data,backups,scripts,audit}
chown -R nostr:nostr /home/nostr /var/lib/immutable-health
```

---

## 3. Nostr Relay (nostr-rs-relay 0.9.0)

```bash
# Build from source
cd /opt
git clone https://github.com/scsibug/nostr-rs-relay.git
cd nostr-rs-relay
git checkout 0.9.0
cargo build --release
cp target/release/nostr-rs-relay /usr/local/bin/

# Create config directory
mkdir -p /etc/nostr-relay
```

Create `/etc/nostr-relay/config.toml`:

```toml
[info]
relay_url = "wss://relay.yourpractice.com/"
name = "Your Practice Relay"
description = "Private medical relay"

[database]
data_directory = "/home/nostr/data"

[network]
port = 8080
address = "127.0.0.1"

[limits]
max_event_bytes = 65536  # Required for telehealth SDP signaling

[authorization]
# NIP-42 authentication — only whitelisted pubkeys can connect
nip42_auth = true
# Add your practice pubkey and staff pubkeys here (hex format)
pubkey_whitelist = [
  "YOUR_PRACTICE_PUBKEY_HEX",
]

[nip42_dms]
# Allow kind 1059 (NIP-17 gift wraps) from any pubkey
# Gift wraps use throwaway keys that won't be on the whitelist
restrict_to_authenticated = false
```

### NIP-17 Relay Patch

nostr-rs-relay 0.9.0 needs a small patch to accept kind 1059 events from non-whitelisted pubkeys (NIP-17 gift wraps use throwaway keys).

Edit `src/db.rs` — find the NIP-42 authentication check and add an exemption for kind 1059:

```rust
// Before the whitelist rejection, add:
if event.kind == 1059 {
    // NIP-17 gift wraps use throwaway keys — exempt from whitelist
    // The relay will still only deliver to authenticated recipients
}
```

Rebuild after patching:

```bash
cd /opt/nostr-rs-relay
cargo build --release
cp target/release/nostr-rs-relay /usr/local/bin/
```

Create systemd service at `/etc/systemd/system/nostr-relay.service`:

```ini
[Unit]
Description=Nostr Relay
After=network.target

[Service]
Type=simple
User=nostr
ExecStart=/usr/local/bin/nostr-rs-relay --config /etc/nostr-relay/config.toml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable nostr-relay
systemctl start nostr-relay
# Verify it's running
curl http://localhost:8080
```

---

## 4. Patient Portal

```bash
cd /home/nostr
git clone https://github.com/YOUR_ORG/NostrEHR.git
cp -r NostrEHR/patient-portal /home/nostr/patient-portal
cd /home/nostr/patient-portal
```

Create `.env.local`:

```env
NEXT_PUBLIC_DEFAULT_PRACTICE_NAME=Your Practice Name
NEXT_PUBLIC_DEFAULT_RELAY=wss://relay.yourpractice.com
NEXT_PUBLIC_DEFAULT_PRACTICE_PK=YOUR_PRACTICE_PUBKEY_HEX
NEXT_PUBLIC_DEFAULT_BILLING_API=https://billing.yourpractice.com
NEXT_PUBLIC_DEFAULT_CALENDAR_API=https://calendar.yourpractice.com
```

```bash
npm install
npm run build
pm2 start npm --name patient-portal -- start -- -p 3001
pm2 save
```

---

## 5. Billing Dashboard

```bash
cp -r /home/nostr/NostrEHR/billing /opt/immutable-health-billing
cd /opt/immutable-health-billing
```

Create `.env`:

```env
PORT=3002
DATABASE_PATH=/var/lib/immutable-health/billing.db
DASHBOARD_PASSWORD_HASH=YOUR_SHA256_HASH_HERE
NOSTR_NSEC=nsec1YOUR_PRACTICE_NSEC_HERE
RELAY_URL=wss://relay.yourpractice.com
RESEND_API_KEY=re_YOUR_RESEND_KEY
RESEND_FROM=billing@yourpractice.com
PRACTICE_NAME=Your Practice Name
MONTHLY_FEE_CENTS=15000
BILLING_URL=https://billing.yourpractice.com
```

Generate the password hash:

```bash
echo -n "your_dashboard_password" | sha256sum | cut -d' ' -f1
```

Initialize the database:

```bash
sqlite3 /var/lib/immutable-health/billing.db < schema.sql
```

```bash
npm install
npm run build
pm2 start npm --name billing -- start
pm2 save
```

---

## 6. Calendar

```bash
cp -r /home/nostr/NostrEHR/calendar /opt/immutable-health-calendar
cd /opt/immutable-health-calendar
```

Create `.env`:

```env
PORT=3003
CALENDAR_PASSWORD_HASH=YOUR_SHA256_HASH_HERE
```

```bash
npm install
pm2 start server.js --name calendar
pm2 save
```

---

## 7. Blossom File Server (NIP-B7)

```bash
mkdir -p /opt/immutable-health-blossom
cd /opt/immutable-health-blossom
```

Create `config.yml`:

```yaml
storage:
  local:
    dir: /var/lib/immutable-health/attachments

upload:
  requireAuth: true
  maxFileSize: 26214400  # 25MB

list:
  requireAuth: true

expiration:
  enabled: false  # Medical records never expire

media:
  enabled: false  # Encrypted blobs, not displayable media
```

```bash
PORT=3004 pm2 start "npx blossom-server-ts" --name blossom --cwd /opt/immutable-health-blossom
pm2 save
```

---

## 8. FHIR REST API

```bash
cp -r /home/nostr/NostrEHR/fhir-api /opt/immutable-health-fhir-api
cd /opt/immutable-health-fhir-api
```

Create `.env`:

```env
PORT=3005
PRACTICE_SK_HEX=YOUR_PRACTICE_SECRET_KEY_HEX
PRACTICE_PK_HEX=YOUR_PRACTICE_PUBKEY_HEX
RELAY_URL=wss://relay.yourpractice.com
KEYS_DB_PATH=/var/lib/immutable-health/fhir-keys.db
ADMIN_PASSWORD_HASH=YOUR_SHA256_HASH_HERE
ALLOWED_ORIGINS=https://billing.yourpractice.com
```

**CRITICAL:** `PRACTICE_SK_HEX` can decrypt all patient records. Protect this file.

```bash
chmod 600 .env
npm install
pm2 start server.js --name fhir-api
pm2 save

# Create your first API key
node manage-keys.js create --name "billing" --scope "Patient,Encounter"
```

---

## 9. Nginx Reverse Proxy

Install certbot for SSL:

```bash
apt install -y certbot python3-certbot-nginx
```

Create nginx configs for each service. Example for the relay at `/etc/nginx/sites-available/relay.yourpractice.com`:

```nginx
server {
    server_name relay.yourpractice.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }

    # Audit trail (basic auth)
    location /audit {
        auth_basic "Audit Trail";
        auth_basic_user_file /etc/nginx/.htpasswd_audit;
        alias /home/nostr/audit/reports;
        autoindex on;
    }

    listen 80;
}
```

Portal at `/etc/nginx/sites-available/portal.yourpractice.com`:

```nginx
server {
    server_name portal.yourpractice.com;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    listen 80;
}
```

Repeat for billing (3002), calendar (3003), blossom (3004), fhir-api (3005).

For Blossom, block the public UI:

```nginx
server {
    server_name blossom.yourpractice.com;
    client_max_body_size 25m;

    location = / { return 404; }
    location = /main.js { return 404; }
    location /lib/ { return 404; }

    location / {
        proxy_pass http://127.0.0.1:3004;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    listen 80;
}
```

Enable all sites and get SSL certs:

```bash
ln -s /etc/nginx/sites-available/relay.yourpractice.com /etc/nginx/sites-enabled/
ln -s /etc/nginx/sites-available/portal.yourpractice.com /etc/nginx/sites-enabled/
ln -s /etc/nginx/sites-available/billing.yourpractice.com /etc/nginx/sites-enabled/
ln -s /etc/nginx/sites-available/calendar.yourpractice.com /etc/nginx/sites-enabled/
ln -s /etc/nginx/sites-available/blossom.yourpractice.com /etc/nginx/sites-enabled/
ln -s /etc/nginx/sites-available/fhir.yourpractice.com /etc/nginx/sites-enabled/

nginx -t && nginx -s reload

# Get SSL certs (one at a time or all at once)
certbot --nginx -d relay.yourpractice.com
certbot --nginx -d portal.yourpractice.com
certbot --nginx -d billing.yourpractice.com
certbot --nginx -d calendar.yourpractice.com
certbot --nginx -d blossom.yourpractice.com
certbot --nginx -d fhir.yourpractice.com
```

---

## 10. Coturn (Telehealth TURN Server)

Required for video visits to work across NAT/firewalls.

```bash
apt install -y coturn
```

Edit `/etc/turnserver.conf`:

```
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0
external-ip=YOUR_SERVER_IP
realm=turn.yourpractice.com
server-name=turn.yourpractice.com

# Static credentials (shared with EHR + portal config)
lt-cred-mech
user=YOUR_TURN_USERNAME:YOUR_TURN_PASSWORD

# TLS (use your Let's Encrypt certs)
cert=/etc/letsencrypt/live/turn.yourpractice.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.yourpractice.com/privkey.pem

# Logging
log-file=/var/log/turnserver.log
verbose

# Security
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
```

```bash
# Get SSL cert for TURN subdomain
certbot certonly --standalone -d turn.yourpractice.com

# Open firewall ports
ufw allow 3478/tcp
ufw allow 3478/udp
ufw allow 5349/tcp
ufw allow 5349/udp
ufw allow 49152:65535/udp  # TURN relay ports

# Enable and start
systemctl enable coturn
systemctl start coturn
```

---

## 11. Audit Trail

Create the audit report generator at `/home/nostr/audit/generate-audit-report.sh`:

```bash
#!/bin/bash
# Generates hourly audit report from relay database
RELAY_DB="/home/nostr/data/nostr.db"
REPORT_DIR="/home/nostr/audit/reports"
mkdir -p "$REPORT_DIR"
TIMESTAMP=$(date +%Y-%m-%d_%H%M)
REPORT="$REPORT_DIR/audit-$TIMESTAMP.txt"

echo "=== NostrEHR Audit Report ===" > "$REPORT"
echo "Generated: $(date)" >> "$REPORT"
echo "" >> "$REPORT"

# Event counts by kind in the last hour
sqlite3 "$RELAY_DB" "SELECT kind, COUNT(*) FROM event WHERE created_at > strftime('%s','now','-1 hour') GROUP BY kind ORDER BY kind;" >> "$REPORT"

echo "" >> "$REPORT"
echo "Total events (all time): $(sqlite3 "$RELAY_DB" 'SELECT COUNT(*) FROM event;')" >> "$REPORT"
echo "Database size: $(du -h "$RELAY_DB" | cut -f1)" >> "$REPORT"

chmod 644 "$REPORT"
```

```bash
chmod +x /home/nostr/audit/generate-audit-report.sh
```

Set up basic auth for the audit web view:

```bash
apt install -y apache2-utils
htpasswd -c /etc/nginx/.htpasswd_audit admin
```

---

## 12. Cron Jobs

```bash
crontab -e
```

Add:

```cron
# Billing: check for lapsed memberships (daily 1 AM)
0 1 * * * /home/nostr/scripts/check-lapsed-memberships.sh

# Backup: full system backup (daily 2 AM)
0 2 * * * /home/nostr/scripts/backup-all.sh

# Whitelist: sync relay whitelist from billing DB (daily 2 AM)
0 2 * * * /home/nostr/scripts/sync-whitelist.sh

# Telehealth: cleanup old signaling events (daily 3 AM)
0 3 * * * /home/nostr/scripts/cleanup-telehealth-events.sh

# Audit: hourly report
0 * * * * /home/nostr/audit/generate-audit-report.sh

# Billing: send monthly invoices (1st of month, 9 AM)
0 9 1 * * cd /opt/immutable-health-billing && node monthly-billing.js
```

---

## 13. Whitelist Sync Script

Create `/home/nostr/scripts/sync-whitelist.sh`:

```bash
#!/bin/bash
# Syncs relay pubkey whitelist from billing DB
# Run after: check-lapsed-memberships.sh

BILLING_DB="/var/lib/immutable-health/billing.db"
CONFIG="/etc/nostr-relay/config.toml"

# Get active patient pubkeys from billing
PUBKEYS=$(sqlite3 "$BILLING_DB" "
  SELECT DISTINCT npub FROM patients
  WHERE status IN ('active', 'delinquent', 'head_of_household')
  AND npub IS NOT NULL AND npub != '';
" | while read npub; do
  # Convert npub to hex (using node one-liner)
  node -e "
    const BECH32='qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const d='$npub'.slice(5);
    let buf=0,bits=0,r=[];
    for(const c of d.slice(0,-6)){const v=BECH32.indexOf(c);buf=(buf<<5)|v;bits+=5;while(bits>=8){bits-=8;r.push((buf>>bits)&0xff);}}
    console.log(r.map(b=>b.toString(16).padStart(2,'0')).join(''));
  "
done)

# Add practice pubkey and staff pubkeys
PRACTICE_PK="YOUR_PRACTICE_PUBKEY_HEX"

# Build whitelist array
WL="pubkey_whitelist = [\n  \"${PRACTICE_PK}\","
for pk in $PUBKEYS; do
  WL="${WL}\n  \"${pk}\","
done
WL="${WL}\n]"

# Update config.toml
sed -i '/^pubkey_whitelist/,/^\]/d' "$CONFIG"
echo -e "$WL" >> "$CONFIG"

# Restart relay
systemctl restart nostr-relay
```

```bash
chmod +x /home/nostr/scripts/sync-whitelist.sh
```

---

## 14. Backup Script

Create `/home/nostr/scripts/backup-all.sh`:

```bash
#!/bin/bash
BACKUP_DIR="/home/nostr/backups"
DATE=$(date +%Y%m%d)
mkdir -p "$BACKUP_DIR"

# Relay database
sqlite3 /home/nostr/data/nostr.db ".backup '$BACKUP_DIR/relay-$DATE.db'"

# Billing database
sqlite3 /var/lib/immutable-health/billing.db ".backup '$BACKUP_DIR/billing-$DATE.db'"

# FHIR keys database
sqlite3 /var/lib/immutable-health/fhir-keys.db ".backup '$BACKUP_DIR/fhir-keys-$DATE.db'"

# Blossom attachments
tar -czf "$BACKUP_DIR/attachments-$DATE.tar.gz" /var/lib/immutable-health/attachments/

# Configs
tar -czf "$BACKUP_DIR/configs-$DATE.tar.gz" \
  /etc/nostr-relay/config.toml \
  /opt/immutable-health-billing/.env \
  /opt/immutable-health-calendar/.env \
  /opt/immutable-health-fhir-api/.env \
  /home/nostr/patient-portal/.env.local \
  /etc/nginx/sites-available/

# Cleanup backups older than 30 days
find "$BACKUP_DIR" -name "*.db" -mtime +30 -delete
find "$BACKUP_DIR" -name "*.tar.gz" -mtime +30 -delete

echo "Backup complete: $BACKUP_DIR/*-$DATE.*"
```

```bash
chmod +x /home/nostr/scripts/backup-all.sh
```

---

## 15. EHR Setup (Doctor's PC)

The EHR runs locally on the doctor's Windows/Mac/Linux machine, never on the server.

**Option A: Electron installer** (recommended)

Download `NostrEHR-Setup-1.0.0.exe` from Releases. Run the installer. The setup wizard will prompt for your relay URL, practice pubkey, and service URLs.

**Option B: Development mode**

```bash
cd NostrEHR/ehr
npm install
cp .env.example .env.local
# Edit .env.local with your values
npm run dev
```

### Generate Practice Keypair

If you don't have a practice keypair yet, use the EHR setup wizard's "Generate New Practice Keypair" button, or generate one with:

```bash
node -e "
const crypto = require('crypto');
const sk = crypto.randomBytes(32).toString('hex');
console.log('Secret key (hex):', sk);
console.log('Save this securely. You will need it for the FHIR API and billing config.');
"
```

The public key is derived from the secret key when you first login to the EHR.

---

## 16. Verify Everything

```bash
# Check all PM2 processes are running
pm2 status

# Expected:
# patient-portal  │ online │ port 3001
# billing         │ online │ port 3002
# calendar        │ online │ port 3003
# blossom         │ online │ port 3004
# fhir-api        │ online │ port 3005

# Test relay
curl -i https://relay.yourpractice.com

# Test portal
curl -i https://portal.yourpractice.com

# Test billing (should redirect to login)
curl -i https://billing.yourpractice.com

# Test FHIR API
curl -i https://fhir.yourpractice.com/metadata

# Save PM2 process list for auto-restart on reboot
pm2 save
pm2 startup
```

---

## Security Checklist

- [ ] All `.env` files are `chmod 600`
- [ ] `PRACTICE_SK_HEX` only in FHIR API `.env` (not committed to git)
- [ ] SSH key-only auth (disable password login)
- [ ] UFW firewall enabled (allow 80, 443, 3478, 5349, 49152-65535/udp, your SSH port)
- [ ] Relay `nip42_auth = true` with pubkey whitelist
- [ ] Blossom public UI blocked via nginx
- [ ] Audit trail accessible only with basic auth
- [ ] Backups running daily
- [ ] SSL certs auto-renew (certbot handles this)
- [ ] No practice nsec stored on server (only in FHIR API `.env` and billing `.env`)

---

## Troubleshooting

**Portal shows 502 Bad Gateway:** The Next.js process crashed. Check `pm2 logs patient-portal`. Usually needs `cd /home/nostr/patient-portal && npm run build && pm2 restart patient-portal`.

**Relay rejects connections:** Check `config.toml` whitelist. The connecting pubkey must be listed. Run `sync-whitelist.sh` after adding patients.

**Telehealth doesn't connect:** Verify coturn is running (`systemctl status coturn`), firewall ports are open, and TURN credentials match between server config and EHR/portal `.env`.

**Billing invoices not sending:** Check `NOSTR_NSEC` in billing `.env`. The relay must accept kind 1059 from non-whitelisted keys (NIP-17 patch).

**FHIR API returns empty results:** Verify `PRACTICE_SK_HEX` is correct. The API decrypts events using this key — wrong key = no readable data.
