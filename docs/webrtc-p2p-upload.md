# WebRTC P2P upload for FileShare

## Operation

The normal web origin remains `https://share.pexserver.com` on Oracle A1.
For **new uploads >= 2 MiB**, the browser tries a WebRTC DataChannel first,
using STUN (`stun:stun.l.google.com:19302`) and ICE hole punching. No inbound
home-router port forwarding or public HTTPS certificate is required.

1. The signed-in client creates a normal upload reservation through A1.
2. The client builds an SDP offer, gathers ICE candidates, and posts it to
   `/api/uploads/:id/webrtc/offer` on the existing HTTPS origin.
3. A8 checks the user's live session, ownership, current upload offset, and
   a per-user signaling rate limit before minting a **5-minute upload-scoped
   ticket**. Only A8 sends this ticket to the local Pion worker over loopback.
4. A8's Pion WebRTC service returns the SDP answer. ICE/STUN tests available
   paths between the client and A8. When a direct path is selected, **file
   payloads never transit A1**.
5. The DataChannel is reliable, ordered and DTLS encrypted. Each existing
   FileShare upload frame is fragmented into <=16,012-byte SCTP messages
   (12-byte metadata header + <=16,000-byte payload) and reassembled by Pion.
   The worker opens a **private PROXY v2 WebSocket connection** to A8's
   existing upload pipeline. Checksums, quota, ACLs, transfer concurrency
   and durable acknowledgment remain owned by FileShare.
6. When P2P negotiation, ICE, or transfer fails, the browser reconciles its
   durable offset with A8, and resumes via the existing public A1->A8
   WebSocket/HTTP upload stream. **Never open a second A1 spool writer over
   a partially received direct upload.**
7. Existing uploads, small files, and browsers without WebRTC retain the
   previous A1 transfer path. IPv6-only direct WSS remains separately
   configurable; it is not required for WebRTC.

## Worker and deployment

Worker source: `deploy/webrtc` (Go 1.25+, Pion WebRTC v4).
Build:
```bash
cd deploy/webrtc
go mod download
go test ./...
go build -trimpath -o fileshare-webrtc .
```

A8 user service: `deploy/fileshare-webrtc.service`; binary expected at
`/home/pexserver-home/.local/opt/pex-fileshare/fileshare-webrtc`.
The signaling worker listens **only at 127.0.0.1:19883**.
No public signaling port is needed. WebRTC itself uses outbound UDP with
locally chosen ephemeral ports. The worker authenticates indirectly by
bridging to A8's signed, session-checked private upload WebSocket.

Config on A8 (`~/.config/pex-fileshare/config.json`):

```json
{
  "proxy": {
    "enabled": true,
    "trustedPeers": ["100.98.217.24", "100.69.76.52"]
  },
  "edgeSpool": { "enabled": true, "trustedIp": "100.98.217.24", "path": "/edge-upload" },
  "webrtc": { "enabled": true, "signalPort": 19883 },
  "directIpv6": { "enabled": false, "host": "upload-v6.pexserver.com", "port": 8443 }
}
```

Preserve all other configuration keys; the snippet shows only affected
sections. Self-IP in `proxy.trustedPeers` permits the local worker to
submit PROXY v2 connections, while A1 remains trusted. Port 8100 is still
Tailscale-only. Never expose 8100 or 19883 on a public interface.

Health:
```bash
systemctl --user is-active fileshare fileshare-webrtc
curl -fsS http://127.0.0.1:19883/healthz
curl -fsS https://share.pexserver.com/api/me
```

The Pion worker uses 16 peers maximum, a 384 MB systemd memory ceiling,
and the FileShare A8 rate/quota/transfer limits.

## Limitations and fallback

STUN **cannot guarantee** direct P2P, especially with strict/symmetric NAT,
UDP filtering, or enterprise firewalls. No TURN is configured, deliberately:
when ICE fails, the browser uses the existing A1 path; TURN hosted in Osaka
could be added later if a fast non-P2P fallback becomes necessary.

Browser attempts can add an ICE timeout before fallback. No guarantee of
30 MB/s exists without real external-client throughput testing.

WebRTC P2P is currently upload-only; file download and preview remain on
the existing route. A8's residential public IP addresses may become visible
to clients once P2P succeeds. DDoS/privacy requirements may favor a TURN relay.

## Rollback

Set `webrtc.enabled=false` in A8 config and restart FileShare. This stops
new attempts immediately; ordinary uploads remain unchanged. Then optionally
`systemctl --user disable --now fileshare-webrtc`. No DNS or router changes
are needed. Restore the backed-up A8 config and executable if a rollback of
the application build itself is necessary.
