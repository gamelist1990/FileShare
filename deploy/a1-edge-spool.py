#!/usr/bin/env python3
"""Bounded A1 upload spool for FileShare; A8 remains the authoritative store."""

from __future__ import annotations

import base64
import ctypes
import errno
import hashlib
import hmac
import http.client
import json
import os
import re
import socket
import socketserver
import sqlite3
import struct
import sys
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs, quote


ORIGIN = os.environ.get("FILESHARE_EDGE_ORIGIN", "https://share.pexserver.com")
PUBLIC_HOST = ORIGIN.removeprefix("https://").removeprefix("http://")
EDGE_PATH = os.environ.get("FILESHARE_EDGE_PATH", "/edge-upload").rstrip("/")
BIND_HOST = os.environ.get("FILESHARE_EDGE_BIND", "127.0.0.1")
BIND_PORT = int(os.environ.get("FILESHARE_EDGE_PORT", "8124"))
DATA_DIR = Path(
    os.environ.get(
        "FILESHARE_EDGE_DATA_DIR", "/home/ubuntu/.local/share/fileshare-edge-spool"
    )
)
SECRET_FILE = Path(os.environ["FILESHARE_EDGE_SECRET_FILE"])
A8_HOST = os.environ.get("FILESHARE_EDGE_A8_HOST", "100.69.76.52")
A8_PORT = int(os.environ.get("FILESHARE_EDGE_A8_PORT", "8100"))
A1_TAILNET_IP = os.environ.get("FILESHARE_EDGE_A1_IP", "100.98.217.24")
A8_TAILNET_IP = os.environ.get("FILESHARE_EDGE_A8_IP", "100.69.76.52")
MAX_RESERVED_BYTES = int(os.environ.get("FILESHARE_EDGE_MAX_RESERVED", "24000000000"))
MIN_FREE_BYTES = int(os.environ.get("FILESHARE_EDGE_MIN_FREE", "8000000000"))
MAX_BLOCK_BYTES = 8 * 1024 * 1024
MAX_AHEAD_BLOCKS = 64
RECLAIM_BATCH_BYTES = 16 * 1024 * 1024
MAX_CONCURRENT_REQUESTS = 8
UPLOAD_ID_RE = re.compile(r"^[a-f0-9-]{36}$")
PROXY_V2_SIGNATURE = b"\r\n\r\n\x00\r\nQUIT\n"
BLOCK_BYTES = {256 * 1024, 1024 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024}

DATA_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(DATA_DIR, 0o700)
DB_PATH = DATA_DIR / "spool.sqlite"
SECRET = SECRET_FILE.read_text(encoding="ascii").strip().encode("ascii")
if len(SECRET) != 64 or not re.fullmatch(rb"[a-f0-9]{64}", SECRET):
    raise RuntimeError("Invalid edge spool secret file")

_db_init_lock = threading.Lock()
_upload_locks: dict[str, threading.RLock] = {}
_upload_locks_guard = threading.Lock()
_content_locks = [threading.RLock() for _ in range(64)]
_block_write_locks = [threading.Lock() for _ in range(64)]
_work_event = threading.Event()
_stop_event = threading.Event()
_cache_guard = threading.RLock()
_cache_reservations = {}
_download_slots = threading.BoundedSemaphore(4)
_request_slots = threading.BoundedSemaphore(MAX_CONCURRENT_REQUESTS)


class SpoolError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def connect_db() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout=30000")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA synchronous=NORMAL")
    return connection


def init_db() -> None:
    with _db_init_lock:
        connection = connect_db()
        try:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=NORMAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS edge_uploads (
                  id TEXT PRIMARY KEY,
                  user_id TEXT NOT NULL,
                  client_ip TEXT NOT NULL,
                  size INTEGER NOT NULL,
                  block_bytes INTEGER NOT NULL,
                  expires_at INTEGER NOT NULL,
                  offset INTEGER NOT NULL DEFAULT 0,
                  received_bytes INTEGER NOT NULL DEFAULT 0,
                  replicated_offset INTEGER NOT NULL DEFAULT 0,
                  state TEXT NOT NULL DEFAULT 'receiving',
                  error TEXT,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS edge_blocks (
                  upload_id TEXT NOT NULL REFERENCES edge_uploads(id) ON DELETE CASCADE,
                  start INTEGER NOT NULL,
                  length INTEGER NOT NULL,
                  hash TEXT NOT NULL,
                  PRIMARY KEY(upload_id,start)
                );
                CREATE INDEX IF NOT EXISTS edge_upload_state
                  ON edge_uploads(state,created_at);
                """
            )
            if "published" not in [r[1] for r in connection.execute("PRAGMA table_info(edge_uploads)")]:
                connection.execute("ALTER TABLE edge_uploads ADD COLUMN published INTEGER NOT NULL DEFAULT 0")
            columns = {r[1] for r in connection.execute("PRAGMA table_info(edge_uploads)")}
            for name in ("released_offset", "reclaimed_bytes"):
                if name not in columns:
                    connection.execute(f"ALTER TABLE edge_uploads ADD COLUMN {name} INTEGER NOT NULL DEFAULT 0")
            connection.execute("CREATE TABLE IF NOT EXISTS download_cache(id TEXT PRIMARY KEY,size INTEGER NOT NULL,accessed INTEGER NOT NULL)")
            os.chmod(DB_PATH, 0o600)
        finally:
            connection.close()


def upload_lock(upload_id: str) -> threading.RLock:
    with _upload_locks_guard:
        return _upload_locks.setdefault(upload_id, threading.RLock())


def content_lock(upload_id: str) -> threading.RLock:
    # Hole punching and pending reads share this lock; ingress receipts never do.
    return _content_locks[hash(upload_id) % len(_content_locks)]


def block_write_lock(upload_id: str, offset: int, block_bytes: int) -> threading.Lock:
    index = (hash(upload_id) ^ (offset // block_bytes)) % len(_block_write_locks)
    return _block_write_locks[index]


def b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def verify_ticket(value: str, expected_id: str, client_ip: str, allow_expired=False):
    if len(value) > 4096:
        raise SpoolError(403, "転送認証を確認できません")
    parts = value.split(".")
    if len(parts) != 2:
        raise SpoolError(403, "転送認証を確認できません")
    payload, supplied = parts
    expected = hmac.new(
        SECRET, b"edge-upload-v1." + payload.encode("ascii"), hashlib.sha256
    ).digest()
    try:
        actual = b64url_decode(supplied)
        ticket = json.loads(b64url_decode(payload))
    except Exception as exc:
        raise SpoolError(403, "転送認証を確認できません") from exc
    if not hmac.compare_digest(actual, expected):
        raise SpoolError(403, "転送認証を確認できません")
    if (
        ticket.get("v") != 1
        or ticket.get("scope") != "edge-upload"
        or ticket.get("id") != expected_id
        or not UPLOAD_ID_RE.fullmatch(expected_id)
        or not isinstance(ticket.get("userId"), str)
        or not isinstance(ticket.get("size"), int)
        or ticket["size"] < 0
        or ticket.get("blockBytes") not in BLOCK_BYTES
        or ticket.get("clientIp") != client_ip
        or not isinstance(ticket.get("expiresAt"), int)
        or (not allow_expired and ticket["expiresAt"] <= int(time.time() * 1000))
    ):
        raise SpoolError(403, "転送認証が期限切れ、または一致しません")
    return ticket


def status_for(upload_id: str) -> dict:
    connection = connect_db()
    try:
        row = connection.execute(
            "SELECT * FROM edge_uploads WHERE id=?", (upload_id,)
        ).fetchone()
        if not row:
            raise SpoolError(404, "A1の転送予約が見つかりません")
        receipt = None
        if row["offset"] > 0:
            last = connection.execute(
                "SELECT start,length,hash FROM edge_blocks WHERE upload_id=? AND start+length=? ORDER BY start DESC LIMIT 1",
                (upload_id, row["offset"]),
            ).fetchone()
            if last:
                receipt = dict(last)
        return {
            "size": row["size"],
            "blockBytes": row["block_bytes"],
            "pipeline": "fileshare-upload-v2",
            "offset": row["offset"],
            "receivedBytes": row["received_bytes"],
            "replicatedOffset": row["replicated_offset"],
            "releasedOffset": row["released_offset"],
            "reclaimedBytes": row["reclaimed_bytes"],
            "state": row["state"],
            "receipt": receipt,
            **({"error": row["error"]} if row["error"] else {}),
        }
    finally:
        connection.close()


def reserve_spool(ticket: dict) -> dict:
    evict_cache(ticket["size"])
    now = int(time.time() * 1000)
    connection = connect_db()
    try:
        connection.execute("BEGIN IMMEDIATE")
        existing = connection.execute(
            "SELECT * FROM edge_uploads WHERE id=?", (ticket["id"],)
        ).fetchone()
        if existing:
            if (
                existing["user_id"] != ticket["userId"]
                or existing["size"] != ticket["size"]
            ):
                raise SpoolError(409, "A1の予約内容が一致しません")
            if existing["state"] in ("cancelled", "error"):
                raise SpoolError(409, "A1の転送予約を再開できません")
            connection.execute(
                "UPDATE edge_uploads SET client_ip=?,expires_at=?,updated_at=? WHERE id=?",
                (ticket["clientIp"], ticket["expiresAt"], now, ticket["id"]),
            )
        else:
            reserved = connection.execute(
                "SELECT COALESCE(SUM(size-reclaimed_bytes),0) FROM edge_uploads WHERE state NOT IN ('complete','cancelled','error')"
            ).fetchone()[0]
            available = os.statvfs(DATA_DIR).f_bavail * os.statvfs(DATA_DIR).f_frsize
            if (
                ticket["size"] > MAX_RESERVED_BYTES
                or reserved + ticket["size"] > MAX_RESERVED_BYTES
                or available - reserved - ticket["size"] < MIN_FREE_BYTES
            ):
                raise SpoolError(507, "A1一時ストレージの空き容量が不足しています")
            connection.execute(
                "INSERT INTO edge_uploads(id,user_id,client_ip,size,block_bytes,expires_at,offset,received_bytes,replicated_offset,state,created_at,updated_at) VALUES (?,?,?,?,?,?,0,0,0,'receiving',?,?)",
                (
                    ticket["id"],
                    ticket["userId"],
                    ticket["clientIp"],
                    ticket["size"],
                    ticket["blockBytes"],
                    ticket["expiresAt"],
                    now,
                    now,
                ),
            )
        connection.execute("COMMIT")
    except Exception:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        raise
    finally:
        connection.close()
    if ticket["size"] == 0:
        fd=os.open(DATA_DIR/(ticket["id"]+".part"),os.O_CREAT|os.O_RDWR,0o600)
        try:os.fsync(fd)
        finally:os.close(fd)
    _work_event.set()
    return status_for(ticket["id"])


def read_content_length(handler: BaseHTTPRequestHandler, maximum: int) -> bytes:
    if handler.headers.get("Transfer-Encoding"):
        raise SpoolError(400, "分割転送形式は受け付けていません")
    try:
        length = int(handler.headers.get("Content-Length", "-1"))
    except ValueError as exc:
        raise SpoolError(400, "転送サイズが不正です") from exc
    if length < 0 or length > maximum:
        raise SpoolError(413, "転送ブロックが大きすぎます")
    handler.connection.settimeout(60)
    try:
        body = handler.rfile.read(length)
        if len(body) != length:
            raise SpoolError(408, "転送データが途中で切れました。未受領部分を再送してください")
        return body
    except TimeoutError as exc:
        raise SpoolError(408, "転送が停止しました。未受領部分を再送してください") from exc
    finally:
        handler.connection.settimeout(None)


def decode_block(encoded: bytes, encoding: str, expected_length: int) -> bytes:
    if encoding in ("", "identity"):
        body = encoded
    elif encoding == "gzip":
        try:
            decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
            body = decoder.decompress(encoded, expected_length + 1)
            if len(body) > expected_length or decoder.unconsumed_tail or not decoder.eof:
                raise SpoolError(413, "圧縮データがブロック上限を超えています")
            body += decoder.flush()
            if len(body) > expected_length or decoder.unused_data:
                raise SpoolError(413, "圧縮データがブロック上限を超えています")
        except SpoolError:
            raise
        except Exception as exc:
            raise SpoolError(400, "圧縮データが不正です") from exc
    else:
        raise SpoolError(400, "未対応の圧縮形式です")
    if len(body) != expected_length:
        raise SpoolError(400, "展開後のサイズが一致しません")
    return body


def contiguous_offset(connection: sqlite3.Connection, upload_id: str, current: int) -> int:
    for row in connection.execute(
        "SELECT start,length FROM edge_blocks WHERE upload_id=? AND start>=? ORDER BY start",
        (upload_id, current),
    ):
        if row["start"] != current:
            break
        current += row["length"]
    return current


def accept_block(ticket: dict, offset: int, encoded: bytes, checksum: str, encoding: str) -> dict:
    size, block_bytes, upload_id = ticket["size"], ticket["blockBytes"], ticket["id"]
    # Resume old 8 MiB reservations with new clients without rewriting receipts.
    db = connect_db()
    try:
        reservation = db.execute("SELECT user_id,size,block_bytes FROM edge_uploads WHERE id=?", (upload_id,)).fetchone()
        if not reservation or reservation["user_id"] != ticket["userId"] or reservation["size"] != size:
            raise SpoolError(404, "A1の転送予約が見つかりません")
        block_bytes = reservation["block_bytes"]
    finally:
        db.close()
    if (
        not isinstance(offset, int)
        or offset < 0
        or offset >= size
        or offset % block_bytes
    ):
        raise SpoolError(400, "転送位置が不正です")
    expected = min(block_bytes, size - offset)
    if not re.fullmatch(r"[a-f0-9]{64}", checksum):
        raise SpoolError(400, "チェックサムが不正です")
    body = decode_block(encoded, encoding, expected)
    actual_hash = hashlib.sha256(body).hexdigest()
    if not hmac.compare_digest(actual_hash, checksum):
        raise SpoolError(400, "チェックサムが一致しません")

    with block_write_lock(upload_id, offset, block_bytes):
        fd = None
        try:
            with upload_lock(upload_id):
                connection = connect_db()
                try:
                    row = connection.execute(
                        "SELECT * FROM edge_uploads WHERE id=?", (upload_id,)
                    ).fetchone()
                    if not row or row["state"] in ("cancelled", "error", "complete"):
                        raise SpoolError(404, "A1の転送予約が見つかりません")
                    prior = connection.execute(
                        "SELECT length,hash FROM edge_blocks WHERE upload_id=? AND start=?",
                        (upload_id, offset),
                    ).fetchone()
                    if prior:
                        if prior["length"] != expected or not hmac.compare_digest(prior["hash"], checksum):
                            raise SpoolError(409, "再送ブロックが一致しません")
                        return status_for(upload_id)
                    if offset > row["offset"] + block_bytes * MAX_AHEAD_BLOCKS:
                        raise SpoolError(429, "先行ブロックの上限です")
                    path = DATA_DIR / (upload_id + ".part")
                    existed = path.exists()
                    fd = os.open(
                        path,
                        os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0),
                        0o600,
                    )
                    if not existed:
                        directory = os.open(
                            DATA_DIR,
                            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
                        )
                        try:
                            os.fsync(directory)
                        finally:
                            os.close(directory)
                finally:
                    connection.close()

            written = 0
            while written < len(body):
                count = os.pwrite(fd, body[written:], offset + written)
                if count <= 0:
                    raise OSError("Short spool write")
                written += count
            if hasattr(os, "fdatasync"):
                os.fdatasync(fd)
            else:
                os.fsync(fd)
        finally:
            if fd is not None:
                os.close(fd)

        with upload_lock(upload_id):
            connection = connect_db()
            try:
                connection.execute("BEGIN IMMEDIATE")
                row = connection.execute(
                    "SELECT * FROM edge_uploads WHERE id=?", (upload_id,)
                ).fetchone()
                if not row or row["state"] in ("cancelled", "error", "complete"):
                    raise SpoolError(404, "A1の転送予約が見つかりません")
                prior = connection.execute(
                    "SELECT length,hash FROM edge_blocks WHERE upload_id=? AND start=?",
                    (upload_id, offset),
                ).fetchone()
                if prior:
                    if prior["length"] != expected or not hmac.compare_digest(prior["hash"], checksum):
                        raise SpoolError(409, "再送ブロックが一致しません")
                    connection.execute("ROLLBACK")
                    return status_for(upload_id)
                current = row["offset"]
                if offset > current + block_bytes * MAX_AHEAD_BLOCKS:
                    raise SpoolError(429, "先行ブロックの上限です")
                connection.execute(
                    "INSERT INTO edge_blocks(upload_id,start,length,hash) VALUES (?,?,?,?)",
                    (upload_id, offset, expected, checksum),
                )
                new_offset = contiguous_offset(connection, upload_id, current)
                received = connection.execute(
                    "SELECT COALESCE(SUM(length),0) FROM edge_blocks WHERE upload_id=?",
                    (upload_id,),
                ).fetchone()[0]
                state = "ready" if row["replicated_offset"] >= size else (
                    "syncing" if row["replicated_offset"] else "receiving"
                )
                connection.execute(
                    "UPDATE edge_uploads SET offset=?,received_bytes=?,state=?,updated_at=? WHERE id=?",
                    (new_offset, received, state, int(time.time() * 1000), upload_id),
                )
                connection.execute("COMMIT")
            except Exception:
                if connection.in_transaction:
                    connection.execute("ROLLBACK")
                raise
            finally:
                connection.close()
    _work_event.set()
    return status_for(upload_id)


def internal_signature(method: str, path: str, timestamp: str, body: bytes) -> str:
    canonical = (
        method.upper()
        + "\n"
        + path
        + "\n"
        + timestamp
        + "\n"
        + hashlib.sha256(body).hexdigest()
    ).encode("utf-8")
    return hmac.new(SECRET, canonical, hashlib.sha256).hexdigest()


class ProxyHTTPConnection(http.client.HTTPConnection):
    def connect(self) -> None:
        self.sock = socket.create_connection((self.host, self.port), self.timeout)
        if self._tunnel_host:
            self._tunnel()
            return
        actual_source = self.sock.getsockname()
        actual_target = self.sock.getpeername()
        if actual_source[0] != A1_TAILNET_IP or actual_target[0] != A8_TAILNET_IP:
            raise OSError("A8 sync must use the configured Tailscale route")
        source = socket.inet_pton(socket.AF_INET, actual_source[0])
        target = socket.inet_pton(socket.AF_INET, actual_target[0])
        address = source + target + struct.pack(
            "!HH", actual_source[1], actual_target[1]
        )
        preface = PROXY_V2_SIGNATURE + bytes((0x21, 0x11)) + struct.pack("!H", len(address)) + address
        self.sock.sendall(preface)


def a8_request(method: str, path: str, body: bytes = b"", headers=None):
    timestamp = str(int(time.time() * 1000))
    signature = internal_signature(method, path, timestamp, body)
    request_headers = {
        "Host": PUBLIC_HOST,
        "Origin": ORIGIN,
        "X-FileShare-Edge-Time": timestamp,
        "X-FileShare-Edge-Signature": signature,
        "Content-Type": "application/octet-stream",
        "Connection": "close",
    }
    if headers:
        request_headers.update(headers)
    connection = ProxyHTTPConnection(A8_HOST, A8_PORT, timeout=25)
    try:
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        payload = response.read(64 * 1024)
        try:
            parsed = json.loads(payload or b"{}")
        except Exception:
            parsed = {}
        if response.status >= 400:
            raise SpoolError(response.status, parsed.get("error", "A8への反映に失敗しました"))
        return parsed
    finally:
        connection.close()


def update_replication(upload_id: str, offset: int, state: str, error=None) -> None:
    connection = connect_db()
    try:
        connection.execute(
            "UPDATE edge_uploads SET replicated_offset=?,state=?,error=?,updated_at=? WHERE id=?",
            (offset, state, error, int(time.time() * 1000), upload_id),
        )
    finally:
        connection.close()


def release_confirmed_prefix(upload_id: str, confirmed: int) -> None:
    """Persist the remote-read boundary before punching only A8-durable bytes.

    A crash before/after fallocate always routes this prefix to A8. Unsupported
    filesystems retain the bytes safely; actual reclaimed blocks govern admission.
    """
    with content_lock(upload_id):
        db = connect_db()
        try:
            with upload_lock(upload_id):
                row = db.execute("SELECT * FROM edge_uploads WHERE id=?", (upload_id,)).fetchone()
                if not row or confirmed > row["replicated_offset"] or confirmed > row["offset"]:
                    raise OSError("Unconfirmed reclamation boundary")
                if confirmed <= row["released_offset"]:
                    return
                start = row["released_offset"]
                # Batch metadata/flush work while ingress is active; queued bytes
                # stay reserved until a batch has actually been reclaimed.
                if confirmed-start < RECLAIM_BATCH_BYTES and row["offset"] < row["size"]:
                    return
                db.execute("UPDATE edge_uploads SET released_offset=? WHERE id=?", (confirmed, upload_id))
                fd = os.open(DATA_DIR / (upload_id + ".part"), os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
            # Storage reclamation I/O must never hold the client receipt lock.
            try:
                before = os.fstat(fd).st_blocks * 512
                libc = ctypes.CDLL(None, use_errno=True)
                punch = getattr(libc, "fallocate", None)
                if punch is None:
                    return
                punch.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_longlong, ctypes.c_longlong]
                punch.restype = ctypes.c_int
                if punch(fd, 0x03, start, confirmed-start) != 0:
                    error = ctypes.get_errno()
                    if error in (errno.EOPNOTSUPP, errno.ENOSYS, errno.EINVAL):
                        return
                    raise OSError(error, "Cannot reclaim durable spool prefix")
                os.fsync(fd)
                freed = max(0, before-os.fstat(fd).st_blocks*512)
                db.execute("UPDATE edge_uploads SET reclaimed_bytes=MIN(size,reclaimed_bytes+?) WHERE id=?", (freed,upload_id))
            finally:
                os.close(fd)
        finally:
            db.close()


def read_origin_chunk(upload_id: str, offset: int, length: int) -> bytes:
    path = f"/api/internal/edge-sync/{upload_id}/prefix?offset={offset}&length={length}"
    timestamp = str(int(time.time()*1000))
    connection = ProxyHTTPConnection(A8_HOST,A8_PORT,timeout=90)
    try:
        connection.request("GET", path, headers={"Host":PUBLIC_HOST,"Connection":"close","X-FileShare-Edge-Time":timestamp,"X-FileShare-Edge-Signature":internal_signature("GET",path,timestamp,b"")})
        response=connection.getresponse()
        if response.status != 200 or int(response.getheader("Content-Length","-1")) != length:
            raise OSError("A8 durable prefix is unavailable")
        data=response.read(length)
        if len(data)!=length: raise OSError("Incomplete A8 durable prefix")
        return data
    finally:
        connection.close()


def read_pending_chunk(upload_id: str, offset: int, length: int) -> bytes:
    with content_lock(upload_id):
        db=connect_db()
        try: row=db.execute("SELECT * FROM edge_uploads WHERE id=?",(upload_id,)).fetchone()
        finally: db.close()
        if not row: raise OSError("Missing upload receipt")
        if row["state"] == "complete":
            remote_length=length
        elif offset < row["released_offset"]:
            remote_length=min(length,row["released_offset"]-offset)
        else:
            # Hold the same lock as hole punching until pread has copied bytes.
            return read_spool_block(upload_id,offset,length)
    return read_origin_chunk(upload_id,offset,remote_length)


def local_receipt(upload_id: str, start: int):
    connection = connect_db()
    try:
        return connection.execute(
            "SELECT length,hash FROM edge_blocks WHERE upload_id=? AND start=?",
            (upload_id, start),
        ).fetchone()
    finally:
        connection.close()


def read_spool_block(upload_id: str, offset: int, length: int) -> bytes:
    fd = os.open(DATA_DIR / (upload_id + ".part"), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        chunks = bytearray()
        while len(chunks) < length:
            part = os.pread(fd, length - len(chunks), offset + len(chunks))
            if not part:
                raise OSError("Spool block is incomplete")
            chunks.extend(part)
        return bytes(chunks)
    finally:
        os.close(fd)


def delete_upload(upload_id: str, state="cancelled") -> None:
    with content_lock(upload_id), upload_lock(upload_id):
        path = DATA_DIR / (upload_id + ".part")
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        connection = connect_db()
        try:
            if state == "complete":
                connection.execute(
                    "UPDATE edge_uploads SET state='complete',error=NULL,updated_at=? WHERE id=?",
                    (int(time.time() * 1000), upload_id),
                )
            else:
                connection.execute("DELETE FROM edge_uploads WHERE id=?", (upload_id,))
        finally:
            connection.close()
        directory = os.open(DATA_DIR, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)


def active_uploads():
    connection = connect_db()
    try:
        return connection.execute(
            "SELECT id FROM edge_uploads WHERE state IN ('receiving','syncing','ready') ORDER BY created_at"
        ).fetchall()
    finally:
        connection.close()


def replicate_one(upload_id: str) -> bool:
    connection = connect_db()
    try:
        row = connection.execute(
            "SELECT * FROM edge_uploads WHERE id=?", (upload_id,)
        ).fetchone()
    finally:
        connection.close()
    if not row or row["state"] in ("complete", "cancelled", "error"):
        return False
    if row["state"] == "ready":
        if not row["published"]: return False
        try:
            a8_request("POST", f"/api/internal/edge-sync/{upload_id}/complete", b"{}")
            delete_upload(upload_id, "complete")
            return True
        except Exception:
            return False
    now = int(time.time() * 1000)
    if row["expires_at"] <= now:
        try:
            remote = a8_request("GET", f"/api/internal/edge-sync/{upload_id}")
            if remote.get("done"):
                delete_upload(upload_id, "complete")
            else:
                connection = connect_db()
                try:
                    connection.execute(
                        "UPDATE edge_uploads SET expires_at=?,updated_at=? WHERE id=?",
                        (now + 24 * 60 * 60 * 1000, now, upload_id),
                    )
                finally:
                    connection.close()
                return False
        except SpoolError as exc:
            if exc.status in (403, 404):
                delete_upload(upload_id)
            elif exc.status == 401:
                update_replication(upload_id, row["replicated_offset"], "error", str(exc))
        except Exception:
            pass
        return False
    try:
        remote = a8_request("GET", f"/api/internal/edge-sync/{upload_id}")
    except SpoolError as exc:
        if exc.status in (403, 404):
            delete_upload(upload_id)
        elif exc.status == 401:
            update_replication(upload_id, row["replicated_offset"], "error", str(exc))
        return False
    except Exception:
        return False
    if remote.get("done"):
        delete_upload(upload_id, "complete")
        return True
    if remote.get("size") != row["size"]:
        update_replication(upload_id, row["replicated_offset"], "error", "A8の予約サイズが一致しません")
        return False
    remote_offset = remote.get("offset")
    if not isinstance(remote_offset, int) or remote_offset < 0 or remote_offset > row["size"]:
        update_replication(upload_id, row["replicated_offset"], "error", "A8の確定位置が不正です")
        return False
    if remote_offset < row["released_offset"]:
        update_replication(upload_id, row["replicated_offset"], "error", "A8の耐久受領位置が解放済み位置より後退しました")
        return False
    if remote_offset != row["replicated_offset"]:
        if remote_offset > 0:
            receipt = remote.get("receipt") or {}
            start = receipt.get("start")
            local = local_receipt(upload_id, start) if isinstance(start, int) else None
            if not local or (
                local["length"] != receipt.get("length")
                or not hmac.compare_digest(local["hash"], str(receipt.get("hash", "")))
            ):
                update_replication(upload_id, row["replicated_offset"], "error", "A8とA1の受領記録が一致しません")
                return False
        update_replication(upload_id, remote_offset, "syncing", None)
        row = dict(row)
        row["replicated_offset"] = remote_offset
    try:
        release_confirmed_prefix(upload_id, remote_offset)
    except OSError:
        # Reclamation is opportunistic; durable replication can still continue.
        pass
    offset = remote_offset
    if offset >= row["size"]:
        update_replication(upload_id, offset, "ready", None)
        return True
    receipt = local_receipt(upload_id, offset)
    if not receipt:
        return False
    length = receipt["length"]
    try:
        body = read_spool_block(upload_id, offset, length)
    except Exception:
        update_replication(upload_id, offset, "error", "A1一時データを読み込めません")
        return False
    checksum = hashlib.sha256(body).hexdigest()
    if not hmac.compare_digest(checksum, receipt["hash"]):
        update_replication(upload_id, offset, "error", "A1一時データのチェックサムが一致しません")
        return False
    try:
        result = a8_request(
            "POST",
            f"/api/internal/edge-sync/{upload_id}/chunk",
            body,
            {
                "Upload-Offset": str(offset),
                "Upload-Checksum": checksum,
            },
        )
    except Exception:
        return False
    next_offset = result.get("offset")
    if next_offset != offset + length:
        update_replication(upload_id, offset, "error", "A8の反映位置が一致しません")
        return False
    next_state = "ready" if next_offset == row["size"] else "syncing"
    update_replication(upload_id, next_offset, next_state, None)
    try:
        release_confirmed_prefix(upload_id, next_offset)
    except OSError:
        pass
    return True


def replication_loop() -> None:
    if sys.platform.startswith("linux"):
        try:
            tid = threading.get_native_id()
            os.setpriority(os.PRIO_PROCESS, tid, min(19, os.getpriority(os.PRIO_PROCESS, tid)+5))
        except (AttributeError, OSError):
            pass
    while not _stop_event.is_set():
        progressed = False
        for row in active_uploads():
            if _stop_event.is_set():
                return
            progressed = replicate_one(row["id"]) or progressed
        if progressed:
            continue
        _work_event.wait(1.0)
        _work_event.clear()


def proxy_v2_read_exact(sock: socket.socket, amount: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < amount:
        part = sock.recv(amount - len(chunks))
        if not part:
            raise OSError("Incomplete PROXY v2 header")
        chunks.extend(part)
    return bytes(chunks)


class EdgeHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def get_request(self):
        while True:
            sock, peer = super().get_request()
            try:
                if peer[0] not in ("127.0.0.1", "::1"):
                    raise OSError("Unexpected local proxy peer")
                sock.settimeout(10)
                fixed = proxy_v2_read_exact(sock, 16)
                if fixed[:12] != PROXY_V2_SIGNATURE or fixed[12] != 0x21:
                    raise OSError("Invalid PROXY v2 preface")
                family, length = fixed[13], struct.unpack("!H", fixed[14:16])[0]
                address = proxy_v2_read_exact(sock, length)
                if family == 0x11 and length >= 12:
                    source_ip = socket.inet_ntop(socket.AF_INET, address[:4])
                    source_port = struct.unpack("!H", address[8:10])[0]
                elif family == 0x21 and length >= 36:
                    source_ip = socket.inet_ntop(socket.AF_INET6, address[:16])
                    source_port = struct.unpack("!H", address[32:34])[0]
                else:
                    raise OSError("Unsupported PROXY v2 address family")
                sock.settimeout(None)
                return sock, (source_ip, source_port)
            except Exception:
                sock.close()


class EdgeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "FileShareEdge/1"
    sys_version = ""

    def end_headers(self):
        # HTTP/1 clients can next visit an A8 path on the same public hostname.
        # The current edge router binds an origin per TCP connection, so finish
        # this connection after its response. HTTP/3 keeps independent streams.
        if not getattr(self, "websocket", False):
            self.send_header("Connection", "close")
        self.close_connection = True
        super().end_headers()

    def log_message(self, fmt, *args):
        # Avoid logging Authorization tickets, request bodies, or query values.
        print("edge-spool", self.command, urlsplit(self.path).path, str(args[1]) if len(args)>1 else "", flush=True)

    def send_json(self, status: int, value: dict):
        body = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if status >= 400:
            self.close_connection = True
        try:
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # A timed-out client retries from durable receipts; do not send a second response.
            self.close_connection = True

    def check_origin(self, method: str):
        if self.headers.get("Host", "").split(":", 1)[0].lower() != PUBLIC_HOST.lower():
            raise SpoolError(421, "公開URLからアクセスしてください")
        origin = self.headers.get("Origin")
        if method not in ("GET", "HEAD") and origin != ORIGIN:
            raise SpoolError(403, "送信元を確認できません")
        if origin and origin != ORIGIN:
            raise SpoolError(403, "送信元を確認できません")

    def authenticate(self, upload_id: str, allow_expired=False):
        value = self.headers.get("Authorization", "")
        if not value.startswith("Bearer "):
            raise SpoolError(401, "A1転送チケットが必要です")
        return verify_ticket(
            value[7:], upload_id, self.client_address[0], allow_expired=allow_expired
        )

    def route(self):
        parsed = urlsplit(self.path)
        prefix = EDGE_PATH + "/"
        if not parsed.path.startswith(prefix):
            raise SpoolError(404, "見つかりません")
        parts = parsed.path[len(prefix) :].split("/")
        if not parts or not UPLOAD_ID_RE.fullmatch(parts[0]):
            raise SpoolError(404, "見つかりません")
        return parts[0], parts[1:]

    def websocket_read(self):
        def exact(n):
            value = self.rfile.read(n)
            if len(value) != n:
                raise EOFError("WebSocket interrupted")
            return value
        fragments = bytearray()
        message_opcode = None
        while True:
            first, second = exact(2)
            opcode = first & 15
            length = second & 127
            if first & 0x70 or not second & 0x80:
                raise SpoolError(400, "WebSocket frame is invalid")
            if length == 126:
                length = struct.unpack("!H", exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", exact(8))[0]
            if length > MAX_BLOCK_BYTES + 56 or (opcode < 8 and len(fragments)+length > MAX_BLOCK_BYTES+56):
                raise SpoolError(413, "WebSocket frame is too large")
            if opcode >= 8 and (not first & 0x80 or length > 125):
                raise SpoolError(400, "WebSocket control frame is invalid")
            mask = exact(4)
            encoded = exact(length)
            # Big-integer XOR runs in C; bytewise Python XOR caps a single CPU.
            payload = (int.from_bytes(encoded,"little") ^ int.from_bytes((mask*((length+3)//4))[:length],"little")).to_bytes(length,"little")
            if opcode == 8:
                self.websocket_write(payload, 8)
                return None, None
            if opcode == 9:
                self.websocket_write(payload, 10)
                continue
            if opcode == 10:
                continue
            if opcode in (1,2) and message_opcode is None:
                message_opcode = opcode
            elif opcode != 0 or message_opcode is None:
                raise SpoolError(400, "WebSocket continuation is invalid")
            fragments.extend(payload)
            if first & 0x80:
                return message_opcode, bytes(fragments)

    def websocket_write(self, payload, opcode=1):
        if isinstance(payload,dict):
            payload=json.dumps(payload,separators=(",",":")).encode()
        length=len(payload)
        header=bytes([0x80|opcode])
        header += bytes([length]) if length<126 else (b"\x7e"+struct.pack("!H",length) if length<65536 else b"\x7f"+struct.pack("!Q",length))
        self.wfile.write(header+payload)

    def serve_stream(self, upload_id):
        self.check_origin("POST")
        protocols=[v.strip() for v in self.headers.get("Sec-WebSocket-Protocol","").split(",")]
        if len(protocols)!=2 or protocols[0]!="fileshare-upload-v2":
            raise SpoolError(403,"転送認証を確認できません")
        ticket=verify_ticket(protocols[1],upload_id,self.client_address[0])
        key=self.headers.get("Sec-WebSocket-Key","")
        try:
            if len(base64.b64decode(key,validate=True))!=16: raise ValueError()
        except Exception as exc:
            raise SpoolError(400,"WebSocket key is invalid") from exc
        if self.headers.get("Upgrade","").lower()!="websocket" or self.headers.get("Sec-WebSocket-Version")!="13" or "upgrade" not in self.headers.get("Connection","").lower():
            raise SpoolError(400,"WebSocket upgrade is required")
        if not _request_slots.acquire(timeout=10):
            raise SpoolError(429,"A1転送サーバーが混雑しています")
        try:
            state=status_for(upload_id)
            self.websocket=True
            self.send_response(101)
            self.send_header("Upgrade","websocket")
            self.send_header("Connection","Upgrade")
            self.send_header("Sec-WebSocket-Accept",base64.b64encode(hashlib.sha1((key+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode())
            self.send_header("Sec-WebSocket-Protocol","fileshare-upload-v2")
            self.end_headers()
            self.connection.settimeout(60)
            self.websocket_write({"type":"ready","protocol":"fileshare-upload-v2","connectionId":"","maxInFlight":16,**state})
            stream_started=time.monotonic()
            while True:
                opcode,payload=self.websocket_read()
                if opcode is None: return
                if ticket["expiresAt"]<=int(time.time()*1000): raise SpoolError(403,"転送認証が期限切れです")
                if opcode==1:
                    if len(payload)>1024: raise SpoolError(413,"Control message too large")
                    message=json.loads(payload)
                    if not isinstance(message,dict): raise SpoolError(400,"転送要求が不正です")
                    if message.get("type")=="ping":
                        self.websocket_write({"type":"pong","nonce":message.get("nonce")})
                        continue
                    if message.get("type")=="finish" and status_for(upload_id)["offset"]==ticket["size"]:
                        self.websocket_write({"type":"done","offset":ticket["size"]})
                        return
                    raise SpoolError(400,"転送要求が不正です")
                if opcode!=2 or len(payload)<57:
                    raise SpoolError(400,"転送フレームが不正です")
                magic,flag,offset,logical,length=struct.unpack("!IB3xQII",payload[:24])
                if magic!=0x46535531 or flag>1 or payload[5:8]!=b"\0\0\0" or length!=len(payload)-56 or logical!=min(state["blockBytes"],ticket["size"]-offset) or (not flag and length!=logical):
                    raise SpoolError(400,"転送フレームが一致しません")
                started=time.monotonic()
                state=accept_block(ticket,offset,payload[56:],payload[24:56].hex(),"gzip" if flag else "identity")
                self.websocket_write({"type":"ack","offset":offset+logical,"bytes":logical,"processingMs":(time.monotonic()-started)*1000})
                if offset+logical==ticket["size"]:
                    self.websocket_write({"type":"done","offset":ticket["size"]})
                    print("edge-spool ingress-complete",upload_id,"received",state["receivedBytes"],"replicated",state["replicatedOffset"],"seconds",round(time.monotonic()-stream_started,3),flush=True)
                    return
        except SpoolError as exc:
            if not getattr(self,"websocket",False): raise
            self.websocket_write({"type":"error","status":exc.status,"error":str(exc)})
            self.websocket_write(struct.pack("!H",1008),8)
        except (EOFError,OSError,ValueError):
            if not getattr(self,"websocket",False): raise
        finally:
            _request_slots.release()

    def do_GET(self):
        try:
            self.check_origin("GET")
            if urlsplit(self.path).path == EDGE_PATH + "/healthz":
                self.send_json(200, {"ok": True})
                return
            upload_id, tail = self.route()
            if tail == ["stream"]:
                self.serve_stream(upload_id)
                return
            if tail in (["content"],["text"]):
                self.serve_content(upload_id, False,tail==["text"])
                return
            if tail != ["status"]:
                raise SpoolError(404, "見つかりません")
            self.authenticate(upload_id)
            if not _request_slots.acquire(timeout=10):
                raise SpoolError(429, "A1転送サーバーが混雑しています")
            try:
                self.send_json(200, status_for(upload_id))
            finally:
                _request_slots.release()
        except SpoolError as exc:
            if not getattr(self,"websocket",False): self.send_json(exc.status, {"error": str(exc)})
        except Exception:
            if not getattr(self,"websocket",False): self.send_json(500, {"error": "A1転送状態を取得できません"})

    def do_HEAD(self):
        try:
            self.check_origin("HEAD")
            upload_id,tail=self.route()
            if tail != ["content"]: raise SpoolError(404,"見つかりません")
            self.serve_content(upload_id, True)
        except SpoolError as exc:
            self.send_json(exc.status,{"error":str(exc)})
        except Exception:
            self.close_connection=True

    def serve_content(self, upload_id, head, text_preview=False):
        token=parse_qs(urlsplit(self.path).query).get("token",[""])[0]
        if len(token)>4096: raise SpoolError(401,"配信認証を確認できません")
        # A8 rechecks the current session, role, grants, parent ACL and expiry on every request.
        auth_body=json.dumps({"ticket":token,"ip":self.client_address[0]}).encode()
        meta=a8_request("POST",f"/api/internal/edge-sync/{upload_id}/authorize",auth_body)
        meta["_text"]=text_preview
        if not _download_slots.acquire(timeout=10): raise SpoolError(429,"ダウンロードが混雑しています")
        try:
            serve_edge_content(self,upload_id,meta,head,auth_body)
        finally:
            _download_slots.release()

    def do_POST(self):
        try:
            self.check_origin("POST")
            upload_id, tail = self.route()
            if tail not in (["start"], ["finish"]):
                raise SpoolError(404, "見つかりません")
            ticket = self.authenticate(upload_id)
            read_content_length(self, 1024)
            if not _request_slots.acquire(timeout=10):
                raise SpoolError(429, "A1転送サーバーが混雑しています")
            try:
                if tail == ["finish"]:
                    status = status_for(upload_id)
                    if status["offset"] != status["size"]:
                        raise SpoolError(409, "全ブロックの受領が完了していません")
                    result = a8_request("POST", f"/api/internal/edge-sync/{upload_id}/publish", json.dumps({"size":status["size"],"offset":status["offset"],"session":ticket.get("session")}).encode())
                    db=connect_db()
                    try:
                        db.execute("UPDATE edge_uploads SET published=1,expires_at=? WHERE id=?", (int(time.time()*1000)+86400000, upload_id))
                    finally:
                        db.close()
                    _work_event.set()
                    self.send_json(200, result)
                else:
                    self.send_json(200, reserve_spool(ticket))
            finally:
                _request_slots.release()
        except SpoolError as exc:
            self.send_json(exc.status, {"error": str(exc)})
        except Exception:
            self.send_json(500, {"error": "A1一時予約を作成できません"})

    def do_PATCH(self):
        try:
            self.check_origin("PATCH")
            upload_id, tail = self.route()
            if tail != ["chunk"]:
                raise SpoolError(404, "見つかりません")
            ticket = self.authenticate(upload_id)
            if not _request_slots.acquire(timeout=10):
                raise SpoolError(429, "A1転送サーバーが混雑しています")
            try:
                encoded = read_content_length(self, MAX_BLOCK_BYTES + 65536)
                try:
                    offset = int(self.headers.get("Upload-Offset", "-1"))
                except ValueError as exc:
                    raise SpoolError(400, "転送位置が不正です") from exc
                checksum = self.headers.get("Upload-Checksum", "")
                encoding = self.headers.get("Upload-Encoding", "identity")
                result = accept_block(ticket, offset, encoded, checksum, encoding)
                self.send_json(200, result)
            finally:
                _request_slots.release()
        except SpoolError as exc:
            self.send_json(exc.status, {"error": str(exc)})
        except Exception:
            self.send_json(500, {"error": "A1一時保存に失敗しました"})

    def do_DELETE(self):
        try:
            self.check_origin("DELETE")
            upload_id, tail = self.route()
            if tail:
                raise SpoolError(404, "見つかりません")
            self.authenticate(upload_id, allow_expired=True)
            db=connect_db()
            try:
                row=db.execute("SELECT published FROM edge_uploads WHERE id=?",(upload_id,)).fetchone()
                if row and row["published"]:
                    raise SpoolError(409,"公開済みのファイルは一覧から削除してください")
            finally:
                db.close()
            delete_upload(upload_id)
            self.send_json(200, {"ok": True})
        except SpoolError as exc:
            self.send_json(exc.status, {"error": str(exc)})
        except Exception:
            self.send_json(500, {"error": "A1一時データを削除できません"})


def cache_bytes():
    total=0
    for path in DATA_DIR.glob("*.cache"):
        try: total+=path.stat().st_size
        except FileNotFoundError: pass
    return total


def evict_cache(incoming=0):
    with _cache_guard:
        _evict_cache(incoming)


def _evict_cache(incoming=0):
    db=connect_db()
    try:
        for row in db.execute("SELECT * FROM download_cache ORDER BY accessed").fetchall():
            usage=cache_bytes()
            pending=db.execute("SELECT COALESCE(SUM(size-reclaimed_bytes),0) FROM edge_uploads WHERE state NOT IN ('complete','cancelled','error')").fetchone()[0]
            disk=os.statvfs(DATA_DIR)
            if usage+pending+incoming<=MAX_RESERVED_BYTES and disk.f_bavail*disk.f_frsize-incoming>=MIN_FREE_BYTES: break
            try: (DATA_DIR/(row["id"]+".cache")).unlink()
            except FileNotFoundError: pass
            db.execute("DELETE FROM download_cache WHERE id=?",(row["id"],))
    finally: db.close()


def serve_edge_content(handler, upload_id, meta, head, auth_body):
    total=meta["size"]
    start,end=0,total-1
    text_preview=meta.get("_text",False)
    requested=(f"bytes=0-{min(total,512*1024)-1}" if total else None) if text_preview else handler.headers.get("Range")
    if requested:
        match=re.fullmatch(r"bytes=(\d*)-(\d*)",requested)
        if not match or not any(match.groups()) or total==0:
            handler.send_response(416);handler.send_header("Content-Range",f"bytes */{total}");handler.send_header("Content-Length","0");handler.end_headers();return
        if not match[1]: start=max(0,total-int(match[2]))
        else:
            start=int(match[1]);end=min(end,int(match[2])) if match[2] else end
        if start>=total or end<start:
            handler.send_response(416);handler.send_header("Content-Range",f"bytes */{total}");handler.send_header("Content-Length","0");handler.end_headers();return
    length=max(0,end-start+1)
    ext=meta["name"].rsplit(".",1)[-1].lower()
    mime={"png":"image/png","jpg":"image/jpeg","jpeg":"image/jpeg","gif":"image/gif","webp":"image/webp","avif":"image/avif","pdf":"application/pdf","mp4":"video/mp4","webm":"video/webm","mp3":"audio/mpeg","wav":"audio/wav","ogg":"audio/ogg","m4a":"audio/mp4","flac":"audio/flac","txt":"text/plain; charset=utf-8"}.get(ext,"application/octet-stream")
    cache=DATA_DIR/(upload_id+".cache")
    source=DATA_DIR/(upload_id+".part") if meta["pending"] else cache
    local=None
    try:
        if meta["pending"]: raise FileNotFoundError()
        local=open(source,"rb")
        if os.fstat(local.fileno()).st_size!=total: local.close();local=None
    except FileNotFoundError:
        if not meta["pending"]:
            try:
                local=open(cache,"rb")
                if os.fstat(local.fileno()).st_size!=total:local.close();local=None
            except FileNotFoundError:pass
    connection=None; response=None; writing=None; caching=False
    try:
        if local is None and not meta["pending"] and not head:
            path=f"/api/internal/edge-sync/{upload_id}/origin"
            timestamp=str(int(time.time()*1000))
            connection=ProxyHTTPConnection(A8_HOST,A8_PORT,timeout=90)
            headers={"Host":PUBLIC_HOST,"Connection":"close","X-FileShare-Edge-Time":timestamp,"X-FileShare-Edge-Signature":internal_signature("GET",path,timestamp,b"")}
            if requested:headers["Range"]=requested
            connection.request("GET",path,headers=headers);response=connection.getresponse()
            if response.status not in (200,206):raise SpoolError(503,"A8からファイルを取得できません")
            if int(response.getheader("Content-Length","-1"))!=length:raise SpoolError(503,"A8のファイルサイズが一致しません")
            if not requested and total<=MAX_RESERVED_BYTES//2:
                evict_cache(total)
                db=connect_db()
                try:reserved=db.execute("SELECT COALESCE(SUM(size-reclaimed_bytes),0) FROM edge_uploads WHERE state NOT IN ('complete','cancelled','error')").fetchone()[0]
                finally:db.close()
                disk=os.statvfs(DATA_DIR)
                used=cache_bytes()
                if used+reserved+total<=MAX_RESERVED_BYTES and disk.f_bavail*disk.f_frsize-total>=MIN_FREE_BYTES:
                    with _cache_guard:
                        current=cache_bytes()+sum(_cache_reservations.values())
                        if current+reserved+total<=MAX_RESERVED_BYTES:
                            try:
                                writing=open(str(cache)+".receiving","xb");caching=True;_cache_reservations[upload_id]=total
                            except FileExistsError:pass
        if not text_preview:
            handler.send_response(206 if requested else 200)
            handler.send_header("Content-Length",str(length));handler.send_header("Content-Type",mime);handler.send_header("Accept-Ranges","bytes");handler.send_header("Cache-Control","private, no-store");handler.send_header("X-Content-Type-Options","nosniff");handler.send_header("Referrer-Policy","no-referrer");handler.send_header("Content-Security-Policy","sandbox; default-src 'none'; frame-ancestors *")
            if requested:handler.send_header("Content-Range",f"bytes {start}-{end}/{total}")
            disposition="attachment" if meta["download"] or mime=="application/octet-stream" else "inline"
            handler.send_header("Content-Disposition",disposition+"; filename*=UTF-8''"+quote(meta["name"],safe=''))
            handler.end_headers()
        if head:return
        if local:local.seek(start)
        remaining=length
        collected=bytearray()
        while remaining:
            amount=min(256*1024,remaining)
            if meta["pending"]:
                chunk=read_pending_chunk(upload_id,end-remaining+1,amount)
            else:
                chunk=local.read(amount) if local else response.read(amount)
            if not chunk:raise OSError("Incomplete content stream")
            if text_preview:collected.extend(chunk)
            else:handler.wfile.write(chunk)
            if writing:writing.write(chunk)
            remaining-=len(chunk)
        if text_preview:
            handler.send_json(200,{"text":collected.decode("utf-8",errors="replace"),"truncated":total>len(collected)})
        if writing:
            writing.flush();os.fsync(writing.fileno());writing.close();writing=None
            os.replace(str(cache)+".receiving",cache)
            db=connect_db()
            try:db.execute("INSERT OR REPLACE INTO download_cache VALUES (?,?,?)",(upload_id,total,int(time.time()*1000)))
            finally:db.close()
        if not meta["pending"] and cache.exists():
            db=connect_db()
            try:db.execute("UPDATE download_cache SET accessed=? WHERE id=?",(int(time.time()*1000),upload_id))
            finally:db.close()
        if meta["download"]:
            try:
                body=json.loads(auth_body);body["commit"]=True
                a8_request("POST",f"/api/internal/edge-sync/{upload_id}/authorize",json.dumps(body).encode())
            except Exception:pass
    except (BrokenPipeError,ConnectionResetError,OSError):
        handler.close_connection=True
    finally:
        if local:local.close()
        if connection:connection.close()
        if writing:writing.close()
        if caching:
            with _cache_guard:
                _cache_reservations.pop(upload_id,None)
            try:Path(str(cache)+".receiving").unlink()
            except FileNotFoundError:pass


def cleanup_expired():
    evict_cache()
    for temporary in DATA_DIR.glob("*.cache.receiving"):
        if temporary.stat().st_mtime < time.time()-86400:
            temporary.unlink(missing_ok=True)
    now = int(time.time() * 1000)
    connection = connect_db()
    try:
        connection.execute(
            "DELETE FROM edge_uploads WHERE state='complete' AND updated_at<?",
            (now - 2 * 24 * 60 * 60 * 1000,),
        )
        rows = connection.execute(
            "SELECT id,expires_at,state FROM edge_uploads WHERE state NOT IN ('complete','cancelled')"
        ).fetchall()
    finally:
        connection.close()
    for row in rows:
        if row["expires_at"] <= now:
            try:
                remote = a8_request("GET", f"/api/internal/edge-sync/{row['id']}")
                if remote.get("done"):
                    delete_upload(row["id"], "complete")
                else:
                    connection = connect_db()
                    try:
                        connection.execute(
                            "UPDATE edge_uploads SET expires_at=?,updated_at=? WHERE id=?",
                            (now + 24 * 60 * 60 * 1000, now, row["id"]),
                        )
                    finally:
                        connection.close()
            except SpoolError as exc:
                if exc.status in (403, 404):
                    delete_upload(row["id"])
                elif exc.status == 401:
                    connection = connect_db()
                    try:
                        connection.execute(
                            "UPDATE edge_uploads SET state='error',error=?,updated_at=? WHERE id=?",
                            (str(exc), now, row["id"]),
                        )
                    finally:
                        connection.close()
            except Exception:
                pass
        elif row["state"] in ("ready", "error"):
            try:
                remote = a8_request("GET", f"/api/internal/edge-sync/{row['id']}")
                if remote.get("done"):
                    delete_upload(row["id"], "complete")
            except Exception:
                pass


def main():
    init_db()
    worker = threading.Thread(target=replication_loop, name="a8-replicator", daemon=True)
    worker.start()
    server = EdgeHTTPServer((BIND_HOST, BIND_PORT), EdgeHandler)
    print(f"FileShare A1 spool listening on {BIND_HOST}:{BIND_PORT}", flush=True)
    threading.Thread(target=lambda: _janitor_loop(), name="spool-janitor", daemon=True).start()
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        _stop_event.set()
        _work_event.set()
        server.server_close()


def _janitor_loop():
    while not _stop_event.is_set():
        cleanup_expired()
        _stop_event.wait(60)


if __name__ == "__main__":
    main()
