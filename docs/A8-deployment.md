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

- Local unit/integration tests cover 28 security/transport/administration scenarios (220 assertions).
- Chromium virtual authenticator: first administrator registration, passkey login, rejection of challenge replay, private upload, publication settings, administrator page, desktop/mobile screenshots.
- A8 real TCP: PROXY v2 request returned HTTP 200; ordinary HTTP returned the Japanese protocol error with HTTP 400.
- A8 CPU media: synthetic MP4 converted successfully; an HLS playlist disguised as MP4 was rejected by the demuxer whitelist.
- Bun dependency audit: no reported vulnerabilities at validation time. This is not an independent security audit.

## Public edge and first administrator

The public edge is `132.145.118.98` (Tailscale `100.98.217.24`). DNS for `share.pexserver.com` points to that public address. `proxy.trustedPeers` is restricted to `100.98.217.24`. FerrumProxy GUI was used to add the exact hostname mapping `share.pexserver.com` with path `/` to `100.69.76.52:8100`, save configuration and restart only the web instance. The existing port 443 listener and fallback to `100.83.127.8:8123` remain. GUI certificate provisioning expanded the certificate to both `play.pexserver.com` and `share.pexserver.com`; it expires 2027-01-16. Both public sites returned HTTPS 200 with normal certificate validation. `/api/me` reports 200GB capacity; `/healthz` returns `{"ok":true}`. The anonymous administrator endpoint returns 401, including with spoofed forwarding/role headers. Automatic renewal uses `snap.certbot.renew.timer`; the proxy reloads changed certificate files for new connections.

The initial administrator and a real passkey were registered on 2026-10-19; the bootstrap key was consumed. Sign in using that registered passkey. Initial setup is hidden after completion. Do not use a test virtual authenticator for production.

```sh
systemctl --user status fileshare.service
journalctl --user -u fileshare.service -n 50 --no-pager
systemctl --user restart fileshare.service
```

Back up the entire protected data directory consistently (stop service or use SQLite's online backup API). Copying just the SQLite main file while WAL writes are active is not sufficient. Keep `envelope.key` private. The service enforces a logical quota; no OS disk partition was created.

FerrumProxy deployed versions: core `2026.10.18-89a39ac`, GUI `2026.10.18-faf0043`. Pre-change edge backups are protected under `/home/ubuntu/backups/host-routing-20261019/`.

## FileShare 2.1 update

Deployed on 2026-10-19: daily JST review books, persistent AI settings, atomic bulk application rejection, bounded/revocable staff invitations, uploader records, download counters and ACL-filtered rankings, per-file retention, administrator file policies, file-type SVG icons and modal focus/scroll handling. New uploads default to at most 5GB per file and a user-selected lifetime from one minute to 30 days. These limits and public metadata/ranking switches are editable in Admin. Existing files retain their prior data and have no expiry until configured. File deadlines block access immediately; a lightweight minute task purges expired blobs, while broader orphan/session cleanup remains hourly.

The SQLite migration adds tables and indexes without altering the existing item/upload column layouts. Before deployment, an online SQLite backup, binary and config were saved under `~/.local/opt/pex-fileshare/backups/admin-2.1-20261019T001804Z/`. Before/after row counts, total stored bytes and the administrator count matched; no existing file was expired or purged during this update. Binary SHA-256: `85ea24ff46340fbffcb9a8c991673d2d87569f722b69e3b74ca94b3045b5df8a`.

Browser CI also verifies invited staff registration and login with a virtual WebAuthn authenticator, the absence of administrator navigation for staff, and rejection of a spent invitation reopened within the same page. Test credentials are isolated from production.

## FileShare 2.2 mobile layout

Login, previews, file settings, folder creation and deletion confirmation now use full-viewport task pages with a sticky Back button and native browser Back support. There is a single scroll surface; closing a task restores background scrolling, focus and the current folder. Forms use 16px inputs and larger touch targets on phones. Mobile file rows and administration tables become cards with visible labels; the administration menu links directly to each section. Notifications remain accessible while a task is open. The viewport includes safe-area support for phones with display cutouts.

The browser verification covers full-viewport settings, both Back actions, folder creation, preserving the current folder and administrator layouts at 320, 390 and 700 pixels. This update changes no database schema or storage policy.

Deployed to A8 on 2026-10-19 from commit `785062a`. The user service is active and public HTTPS health checks succeed. The production mobile login page was verified in the browser, including returning to the file list. Before/after deployment: 3 items, 18,986,855 stored bytes, 1 administrator; all counts matched. Rollback snapshot: `~/.local/opt/pex-fileshare/backups/mobile-2.2-20261019T003934Z/` (previous binary and online SQLite backup). Deployed binary SHA-256: `181abcb4182dfdcba0e5e5441ac31a6cb551e6ae485750534aa30f72df2d41cd`. GitHub Actions run `39181701224` passed all checks, browser/mobile tests and CPU preview verification, and published release `release-2.2` with all platform binaries.

## FileShare 2.3 control improvements

Staff-invitation and file-link copying now runs within the original click gesture, uses both compatible clipboard paths, and selects the URL with manual-copy instructions when copying is unavailable. Copy feedback appears next to the button. Retention and file-size controls share preset dropdowns with custom values and explicit units (minutes/hours/days, bytes/KB/MB/GB). Existing file deadlines remain unchanged unless a new duration is selected. Upload presets respect the administrator's maximum. Month and scope filters use matching grid rows and 46px controls, including native month-input normalization.

Browser verification checks exact clipboard contents, fallback when Clipboard API writes are denied, preset/custom unit conversion and persistence, and matching desktop filter geometry.
