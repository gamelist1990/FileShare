# FileShare direct IPv6 WSS with safe fallback

## Design

The primary web origin remains `https://share.pexserver.com`, served by the
existing A1/FerrumProxy route. **Do not add an AAAA record to that hostname.**
Direct upload uses **a separate IPv6-only host**,
`upload-v6.pexserver.com:8443`. A8 advertises it only when
`directIpv6.enabled: true`. The browser tries an authenticated, signed WSS
upload for new files of at least 2 MiB, with a 3 s handshake timeout and 30 s
idle timeout. On connection failure it reads the authoritative upload offset
from A8 through the existing route before choosing recovery:

- Any direct connection failure: use the existing A1→A8 standard
  upload WebSocket/HTTP stream, **never** open a conflicting A1 spool writer.
  A block may be committing even when the first status read shows 0.
- Entire file received directly: complete on A8 using the normal session.
- Previously interrupted uploads: resume through the existing A1/A8 workflow.
- Browser without IPv6, blocked WSS port, invalid TLS, or server offline:
  immediate best-effort return to the existing route.

This protects upload receipts and does not expose session cookies to the direct
subdomain. The browser sends a 5-minute HMAC upload capability as the second
WebSocket subprotocol. A8 verifies upload ID, owner, size, live session and
permissions on connection and on every block. The gateway preserves the real
IPv6 client address using PROXY v2. It has no IPv4 listener. Only the standard
`fileshare-upload-v2` WebSocket path accepts the capability. Ordinary HTTP
APIs keep their established cookie/Host/Origin rules.

## Enable only after preflight checks

1. Add an AAAA record for **upload-v6.pexserver.com** pointing to the A8
   global IPv6; keep **share.pexserver.com unchanged**. An A record on the
   direct hostname is unnecessary and may defeat IPv6 preference.
   Public IPv6 addresses can change when the home ISP renumbers the prefix;
   update DNS accordingly.
2. Allow inbound **TCP 8443** to the A8 global IPv6 in the home router's IPv6
   firewall and the A8 host firewall. The domain must have a valid
   browser-trusted HTTPS certificate with DNS SAN `upload-v6.pexserver.com`.
   Arrange **automatic renewal** and private-key permissions (0600).
   DNS-01 authorization is possible when public inbound TCP 80 is not
   available; do not use a self-signed certificate in production.
3. Install the node gateway from `deploy/direct-ipv6-gateway.mjs`,
   environment file from `deploy/fileshare-direct-ipv6.env.example`
   and the user service `deploy/fileshare-direct-ipv6.service` on A8.
   Copy the TLS full chain/key to the configured paths, chmod 0600 and
   enable the service. It binds to A8's IPv6 address and listens on port 8443.
4. In A8 FileShare configuration, append **A8's own Tailscale IP**,
   `100.69.76.52`, to `proxy.trustedPeers`, *without removing* the A1
   address `100.98.217.24`. The local gateway connects to the existing
   Tailscale-only FileShare listener with PROXY v2 and the actual client IPv6.
   Apply this change via a controlled restart after backing up the config.
5. From an **external IPv6-capable network**, verify certificate/SNI and
   WSS connectivity to `upload-v6.pexserver.com:8443`, check WebSocket
   signed-ticket authorization, complete an actual file upload and verify
   SHA-256. Also test IPv4-only and blocked-TCP-8443 clients for fallback.
6. Set `"directIpv6":{"enabled":true,"host":"upload-v6.pexserver.com",
   "port":8443}` in the A8 config and restart FileShare. Until then it
   advertises `enabled:false` and no browser tries the direct path.

**Important:** The A8 account may lack passwordless sudo; changing the host
firewall or privileged ports may require the administrator's manual action.
Never weaken PROXY v2 origin allowlists or open the existing port 8100 on the
public Internet. The gateway uses an unprivileged 8443 listener instead.

## Rollback

Set `directIpv6.enabled=false`, restart FileShare, and then disable the
`fileshare-direct-ipv6.service` user service. All new uploads return to the
unchanged A1 route; no DNS changes to the primary website are required. If an
upload already committed direct bytes, the client rechecks A8's durable offset
and resumes over the existing standard route.
