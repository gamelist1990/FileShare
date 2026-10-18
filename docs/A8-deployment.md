# A8 deployment — 2026-10-19

## Hardware observed

| Host   | CPU                         | RAM available at inspection      | GPU                    | Disk                  |
| ------ | --------------------------- | -------------------------------- | ---------------------- | --------------------- |
| HomePC | Ryzen Embedded R2514, 4C/8T | ~15GiB / 26GiB                   | Radeon Vega integrated | ~106GiB free / 233GiB |
| A8     | Ryzen 7 8745HS, 8C/16T      | ~3.4GiB / 10GiB visible to Linux | Radeon 780M integrated | ~843GiB free / 937GiB |

HomePC had a load average around 9 and a Java process using about 5 CPU cores. Its additional RAM does not imply spare CPU capacity. No AI service was migrated. A8's existing `ai-inference.service` remains running.

## Installed service

- User: `pexserver-home`
- Unit: `~/.config/systemd/user/fileshare.service`, enabled; user linger is already enabled.
- Binary: `~/.local/opt/pex-fileshare/FileShare`
- Configuration: `~/.config/pex-fileshare/config.json` (0600)
- Storage: `~/.local/share/pex-fileshare` (0700)
- Listen: `100.69.76.52:8100` on Tailscale; PROXY v2 required.
- Public origin: `https://share.pexserver.com` — HTTPS and hostname routing verified on 2026-10-19.
- Application capacity: 200GB total, default personal quota 5GB, 2GB within the total reserved for previews.
- Resources: `CPUQuota=200%`, `MemoryMax=1G`, `Nice=10`, `TasksMax=96`.
- FFmpeg: Ubuntu 26.04 package `8.0.1-3ubuntu2`, CPU only; wrapper at `~/.local/opt/pex-fileshare/ffmpeg`. Needed packages were extracted without sudo; keep the local FFmpeg/libavdevice runtime updated alongside system security updates.
- AI advisory: disabled by default; can use the existing local OpenAI-compatible endpoint when explicitly configured.

The previous dirty checkout at `~/WorkSpace/FileShare` has not been overwritten. Its tracked diff was saved to `~/fileshare-existing-changes-20261019.patch`; existing untracked theme/tests remain there.

## Verification

- Local unit/integration tests cover 17 security/transport scenarios (95 assertions).
- Chromium virtual authenticator: first administrator registration, passkey login, rejection of challenge replay, private upload, publication settings, administrator page, desktop/mobile screenshots.
- A8 real TCP: PROXY v2 request returned HTTP 200; ordinary HTTP returned the Japanese protocol error with HTTP 400.
- A8 CPU media: synthetic MP4 converted successfully; an HLS playlist disguised as MP4 was rejected by the demuxer whitelist.
- Bun dependency audit: no reported vulnerabilities at validation time. This is not an independent security audit.

## Public edge and first administrator

The public edge is `132.145.118.98` (Tailscale `100.98.217.24`). DNS for `share.pexserver.com` points to that public address. `proxy.trustedPeers` is restricted to `100.98.217.24`. FerrumProxy GUI was used to add the exact hostname mapping `share.pexserver.com` with path `/` to `100.69.76.52:8100`, save configuration and restart only the web instance. The existing port 443 listener and fallback to `100.83.127.8:8123` remain. GUI certificate provisioning expanded the certificate to both `play.pexserver.com` and `share.pexserver.com`; it expires 2027-01-16. Both public sites returned HTTPS 200 with normal certificate validation. `/api/me` reports 200GB capacity; `/healthz` returns `{"ok":true}`. The anonymous administrator endpoint returns 401, including with spoofed forwarding/role headers. Automatic renewal uses `snap.certbot.renew.timer`; the proxy reloads changed certificate files for new connections.

Open the public root page and register a real administrator passkey using the local `~/.local/share/pex-fileshare/bootstrap.token` under “管理者の初期設定”. The token expires after 24 hours and is not included in this repository or logs. Do not use the test virtual authenticator for production. Set `registration.enabled=false` if public registration should remain closed during setup.

```sh
systemctl --user status fileshare.service
journalctl --user -u fileshare.service -n 50 --no-pager
systemctl --user restart fileshare.service
```

Back up the entire protected data directory consistently (stop service or use SQLite's online backup API). Copying just the SQLite main file while WAL writes are active is not sufficient. Keep `envelope.key` private. The service enforces a logical quota; no OS disk partition was created.

FerrumProxy deployed versions: core `2026.10.18-89a39ac`, GUI `2026.10.18-faf0043`. Pre-change edge backups are protected under `/home/ubuntu/backups/host-routing-20261019/`.
