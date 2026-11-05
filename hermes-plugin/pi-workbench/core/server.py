"""The hub HTTP server: one stdlib ``ThreadingHTTPServer`` per gateway process.

Why stdlib and not aiohttp (which Hermes already ships)
------------------------------------------------------
1. It runs in a *separate thread*, so a bug here cannot poison the gateway's
   asyncio loop — the single most likely way for this plugin to take the whole
   agent down.
2. Tests run with a bare ``python -m unittest``; nothing to install.
3. Upstream does the same thing for its own ``a2a`` platform plugin.

Route table (H0: devices + read-only passthrough; H1 adds runs/SSE and friends)
-----------------------------------------------------------------------------
anon     GET  /health                     upstream passthrough
anon     GET  /v1/hub/health              hub self-check
admin    POST /v1/devices/register
admin    GET  /v1/devices
admin    POST /v1/devices/{id}/revoke
chat     GET  /v1/devices/me
chat     GET  /v1/capabilities | /v1/toolsets | /v1/skills | /v1/models
chat     *    /v1/runs...                 (H1)
"""

from __future__ import annotations

import json
import logging
import re
import socket
import threading
import time
import urllib.parse
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Iterable
from pathlib import Path

from . import auth as auth_mod
from .audit import Auditor
from .db import Database
from .errors import HubError
from .proxy import Response, StreamResponse, Upstream

VERSION = "0.1.0"
MAX_BODY_BYTES = 2 * 1024 * 1024
LOGGER = logging.getLogger(__name__)


@dataclass
class Request:
    method: str
    path: str
    query: str
    headers: dict[str, str]
    body: bytes
    client_ip: str
    device: dict | None = None

    def header(self, name: str, default: str | None = None) -> str | None:
        for key, value in self.headers.items():
            if key.lower() == name.lower():
                return value
        return default

    def json(self) -> dict:
        if not self.body:
            return {}
        try:
            data = json.loads(self.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HubError("bad_request", "body is not valid JSON") from exc
        if not isinstance(data, dict):
            raise HubError("bad_request", "body must be a JSON object")
        return data


@dataclass
class Route:
    method: str
    pattern: re.Pattern
    handler: str
    mode: str  # "anon" | "admin" | "chat" | "dispatch"


class HubContext:
    """Everything a handler needs, assembled once at startup."""

    def __init__(
        self,
        *,
        data_dir: str | Path,
        upstream_base: str,
        upstream_key: str,
        admin_key: str,
        rate_limit: int = 60,
    ):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.db = Database(self.data_dir / "hub.db")
        self.auth = auth_mod.Authenticator(self.db, rate_limit=rate_limit)
        self.audit = Auditor(self.db, self.data_dir / "audit.jsonl")
        self.upstream = Upstream(upstream_base, upstream_key)
        self.admin_key = admin_key
        self.started_at = time.time()

    def close(self) -> None:
        self.db.close()


class Hub:
    """Routes and handlers. No HTTP plumbing in here beyond Response objects."""

    def __init__(self, ctx: HubContext):
        self.ctx = ctx
        self.routes: list[Route] = []

        def add(method: str, pattern: str, handler: Callable, mode: str) -> None:
            self.routes.append(Route(method, re.compile(f"^{pattern}$"), handler.__name__, mode))
            setattr(self, handler.__name__, handler)

        # -- self / health -------------------------------------------------
        add("GET", r"/health", self.upstream_health, "anon")
        add("GET", r"/v1/hub/health", self.hub_health, "anon")

        # -- device administration (admin key) -----------------------------
        add("POST", r"/v1/devices/register", self.register_device, "admin")
        add("GET", r"/v1/devices", self.list_devices, "admin")
        add("POST", r"/v1/devices/(?P<device_id>[A-Za-z0-9_.:-]+)/revoke", self.revoke_device, "admin")

        # -- device self (own token) ---------------------------------------
        add("GET", r"/v1/devices/me", self.device_me, "chat")

        # -- read-only passthrough -----------------------------------------
        for path in ("/v1/capabilities", "/v1/toolsets", "/v1/skills", "/v1/models"):
            add("GET", re.escape(path), self.passthrough_get, "chat")

    # -- dispatch ----------------------------------------------------------

    def match(self, method: str, path: str) -> tuple[Route, dict] | None:
        allowed_elsewhere = False
        for route in self.routes:
            found = route.pattern.match(path)
            if not found:
                continue
            if route.method != method:
                allowed_elsewhere = True
                continue
            return route, found.groupdict()
        if allowed_elsewhere:
            raise HubError("method_not_allowed", f"{method} is not allowed on {path}")
        return None

    # -- handlers: self ----------------------------------------------------

    def upstream_health(self, req: Request, **_: str) -> Response:
        try:
            response = self.ctx.upstream.request("GET", "/health", headers=req.headers)
        except HubError:
            raise
        return Response(response.status, response.headers, response.body)

    def hub_health(self, req: Request, **_: str) -> Response:
        devices = self.ctx.auth.list_devices()
        online_at = int(time.time()) - 90
        payload = {
            "status": "ok",
            "hub": VERSION,
            "upstream": f"{self.ctx.upstream.base_url}",
            "upstreamOk": None,
            "devices": {
                "total": len(devices),
                "active": sum(1 for d in devices if (d.get("last_seen_at") or 0) >= online_at),
                "revoked": sum(1 for d in devices if d.get("revoked_at")),
            },
            "adminKeyConfigured": bool(self.ctx.admin_key),
            "uptimeSeconds": int(time.time() - self.ctx.started_at),
        }
        try:
            response = self.ctx.upstream.request("GET", "/health", cacheable=False, timeout=5.0)
            payload["upstreamOk"] = response.status == 200
            payload["upstreamVersion"] = _upstream_version(response)
        except HubError as exc:
            payload["upstreamOk"] = False
            payload["upstreamError"] = exc.code
        status = 200 if payload["upstreamOk"] else 503
        return _json_response(payload, status=status)

    # -- handlers: device admin -------------------------------------------

    def register_device(self, req: Request, **_: str) -> Response:
        body = req.json()
        row, token = self.ctx.auth.register_device(
            body.get("name") or "unnamed",
            scopes=tuple(body.get("scopes") or auth_mod.DEFAULT_SCOPES),
            note=body.get("note"),
        )
        self.ctx.audit.record(
            "device.register",
            device_id=row["id"],
            status=201,
            detail={"name": row["name"], "scopes": row["scopes"]},
            ip=req.client_ip,
        )
        return _json_response(
            {
                "deviceId": row["id"],
                "name": row["name"],
                "scopes": auth_mod.scopes_list(row["scopes"]),
                "token": token,
                "tokenPrefix": row["token_prefix"],
                "note": "token is shown once; the hub only stores its hash",
            },
            status=201,
        )

    def list_devices(self, req: Request, **_: str) -> Response:
        now = int(time.time())
        devices = []
        for row in self.ctx.auth.list_devices():
            last_seen = row.get("last_seen_at")
            devices.append(
                {
                    "deviceId": row["id"],
                    "name": row["name"],
                    "scopes": auth_mod.scopes_list(row["scopes"]),
                    "tokenPrefix": row["token_prefix"],
                    "createdAt": row["created_at"],
                    "lastSeenAt": last_seen,
                    "online": bool(last_seen and now - last_seen < 90 and not row.get("revoked_at")),
                    "revokedAt": row["revoked_at"],
                    "note": row.get("note"),
                }
            )
        return _json_response({"devices": devices})

    def revoke_device(self, req: Request, device_id: str = "", **_: str) -> Response:
        changed = self.ctx.auth.revoke_device(device_id)
        self.ctx.audit.record(
            "device.revoke", device_id=device_id, status=200 if changed else 404, ip=req.client_ip
        )
        if not changed:
            raise HubError("not_found", "no such device, or already revoked")
        return _json_response({"deviceId": device_id, "revoked": True})

    # -- handlers: device self --------------------------------------------

    def device_me(self, req: Request, **_: str) -> Response:
        device = req.device or {}
        return _json_response(
            {
                "deviceId": device.get("id"),
                "name": device.get("name"),
                "scopes": auth_mod.scopes_list(device.get("scopes", "")),
                "createdAt": device.get("created_at"),
                "hub": VERSION,
            }
        )

    # -- handlers: passthrough --------------------------------------------

    def passthrough_get(self, req: Request, **_: str) -> Response:
        path = req.path + (f"?{req.query}" if req.query else "")
        device = req.device or {}
        response = self.ctx.upstream.request(
            "GET", path, headers=req.headers, device_id=device.get("id")
        )
        return response


def _upstream_version(response: Response) -> str | None:
    try:
        return json.loads(response.body.decode("utf-8")).get("version")
    except Exception:
        return None


def _json_response(payload: dict, status: int = 200) -> Response:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    return Response(status, {"Content-Type": "application/json; charset=utf-8"}, body)


class HubRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"pi-workbench/{VERSION}"
    sys_version = ""

    # -- plumbing ----------------------------------------------------------

    @property
    def hub(self) -> Hub:
        return self.server.hub  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003 - stdlib signature
        LOGGER.debug("[hub] %s - %s", self.address_string(), fmt % args)

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PUT(self) -> None:
        self._dispatch("PUT")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")

    def do_PATCH(self) -> None:
        self._dispatch("PATCH")

    def _read_body(self) -> bytes:
        raw_length = self.headers.get("Content-Length")
        if not raw_length:
            return b""
        try:
            length = int(raw_length)
        except ValueError as exc:
            raise HubError("bad_request", "invalid Content-Length") from exc
        if length > MAX_BODY_BYTES:
            raise HubError("payload_too_large", f"body exceeds {MAX_BODY_BYTES} bytes")
        return self.rfile.read(length) if length > 0 else b""

    def _dispatch(self, method: str) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path.rstrip("/") or "/"
        started = time.time()
        req = Request(
            method=method,
            path=path,
            query=parsed.query,
            headers={k: v for k, v in self.headers.items()},
            body=b"",
            client_ip=self.address_string(),
        )
        route: Route | None = None
        try:
            req.body = self._read_body()
            matched = self.hub.match(method, path)
            if matched is None:
                raise HubError("not_found", f"no hub route for {path}")
            route, params = matched
            self._authorize(route, req)
            handler = getattr(self.hub, route.handler)
            result = handler(req, **params)
            self._emit(result)
            if method in ("POST", "PUT", "PATCH", "DELETE"):
                self.hub.ctx.audit.record(
                    f"http.{method.lower()}",
                    device_id=(req.device or {}).get("id"),
                    path=path,
                    status=result.status,
                    detail={"durationMs": int((time.time() - started) * 1000)},
                    ip=req.client_ip,
                )
        except HubError as exc:
            self._emit(_json_response(exc.payload(), status=exc.status), extra_headers=exc.headers())
        except Exception:  # pragma: no cover - last resort, keep the socket healthy
            LOGGER.exception("[hub] unhandled error on %s %s", method, path)
            err = HubError("internal_error")
            self._emit(_json_response(err.payload(), status=err.status))

    def _authorize(self, route: Route, req: Request) -> None:
        ctx = self.hub.ctx
        if route.mode == "anon":
            return
        if route.mode == "admin":
            ctx.auth.check_admin(req.header("X-Pi-Admin-Key"), ctx.admin_key)
            return
        token = _bearer(req.header("Authorization"))
        device = ctx.auth.authenticate(token)
        ctx.auth.limiter.check(device["id"])
        ctx.auth.touch(device["id"])
        req.device = device
        if route.mode in ("chat", "dispatch"):
            ctx.auth.require_scope(device, route.mode)

    def _emit(self, result: Response | StreamResponse, extra_headers: dict[str, str] | None = None) -> None:
        if isinstance(result, StreamResponse):
            self._emit_stream(result)
            return
        self.send_response(result.status)
        headers = dict(result.headers)
        headers.update(extra_headers or {})
        payload = result.body or b""
        if not any(k.lower() == "content-type" for k in headers):
            headers["Content-Type"] = "application/json; charset=utf-8"
        headers["Content-Length"] = str(len(payload))
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        if payload:
            self.wfile.write(payload)

    def _emit_stream(self, result: StreamResponse) -> None:
        self.send_response(result.status)
        headers = dict(result.headers)
        headers.setdefault("Cache-Control", "no-cache, no-store")
        headers.setdefault("X-Accel-Buffering", "no")
        headers["Connection"] = "close"
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        self.close_connection = True
        chunks = result.chunks
        try:
            for chunk in chunks:
                if not chunk:
                    continue
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            LOGGER.debug("[hub] client disconnected mid-stream")
        finally:
            close = getattr(chunks, "close", None)
            if callable(close):
                close()


def _bearer(header: str | None) -> str | None:
    if not header:
        return None
    parts = header.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip()


class HubServer:
    """Owns the socket and the background thread."""

    def __init__(
        self,
        *,
        data_dir: str | Path,
        upstream_base: str,
        upstream_key: str,
        admin_key: str,
        host: str = "127.0.0.1",
        port: int = 8484,
        rate_limit: int = 60,
    ):
        self.ctx = HubContext(
            data_dir=data_dir,
            upstream_base=upstream_base,
            upstream_key=upstream_key,
            admin_key=admin_key,
            rate_limit=rate_limit,
        )
        self.hub = Hub(self.ctx)
        self.host = host
        self.port = port
        self._httpd: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        httpd = ThreadingHTTPServer((self.host, self.port), HubRequestHandler)
        httpd.daemon_threads = True
        httpd.hub = self.hub  # type: ignore[attr-defined]
        self._httpd = httpd
        self.port = httpd.server_address[1]
        self._thread = threading.Thread(target=lambda: httpd.serve_forever(poll_interval=0.1), name="pi-workbench-hub", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        httpd, self._httpd = self._httpd, None
        if httpd is not None:
            httpd.shutdown()
            httpd.server_close()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=5)
        self.ctx.close()

    @property
    def is_running(self) -> bool:
        return self._httpd is not None and self._thread is not None and self._thread.is_alive()

    @property
    def address(self) -> str:
        return f"http://{self.host}:{self.port}"

    @property
    def upstream_base(self) -> str:
        return self.ctx.upstream.base_url
