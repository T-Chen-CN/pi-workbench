"""Thin ``BasePlatformAdapter`` implementation.

The hub is a *web* entry, not a chat surface: we never receive inbound chat
messages, so ``send()`` is unsupported and no session is created by us. What we
need from the gateway is the lifecycle — ``connect()`` starts the loopback HTTP
server, ``disconnect()`` stops it and closes the SQLite handles.

This module is imported lazily (only when the gateway actually builds the
adapter), so importing ``gateway.*`` at module level is safe here and keeps the
code obvious.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

from gateway.config import Platform
from gateway.platforms.base import BasePlatformAdapter, SendResult

logger = logging.getLogger(__name__)

PLATFORM_NAME = "pi-workbench"
_LOG_PREFIX = "[hub]"


class PiWorkbenchAdapter(BasePlatformAdapter):
    def __init__(self, config, *, _data_dir=None):
        super().__init__(config, Platform(PLATFORM_NAME))
        self._data_dir = _data_dir
        self._hub = None

    # -- lifecycle ---------------------------------------------------------

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if self._hub is not None and self._hub.is_running:
            logger.info("%s already listening on %s", _LOG_PREFIX, self._hub.address)
            return True

        from .core.server import HubServer
        from .shim import (
            DEFAULT_API_BASE,
            DEFAULT_HOST,
            DEFAULT_PORT,
            DEFAULT_RATE_LIMIT,
            _int_env,
        )

        api_key = os.environ.get("API_SERVER_KEY", "")
        if not api_key:
            logger.error(
                "%s API_SERVER_KEY is not visible to the gateway process: "
                "proxied calls to api_server will fail with 401",
                _LOG_PREFIX,
            )
        try:
            hub = HubServer(
                data_dir=self._data_dir,
                upstream_base=os.environ.get("HERMES_API_BASE", DEFAULT_API_BASE),
                upstream_key=api_key,
                admin_key=os.environ.get("PI_HUB_ADMIN_KEY", ""),
                host=os.environ.get("PI_HUB_HOST", DEFAULT_HOST),
                port=_int_env("PI_HUB_PORT", DEFAULT_PORT),
                rate_limit=_int_env("PI_HUB_RATE_LIMIT", DEFAULT_RATE_LIMIT),
            )
            hub.start()
        except OSError as exc:
            # A taken port must never take the gateway down: report "not
            # connected" and let the gateway retry like any other platform.
            logger.error("%s failed to listen: %s", _LOG_PREFIX, exc)
            return False
        self._hub = hub
        logger.info("%s listening on %s -> %s", _LOG_PREFIX, hub.address, hub.upstream_base)
        return True

    async def disconnect(self) -> None:
        hub, self._hub = self._hub, None
        if hub is None:
            return
        hub.stop()
        logger.info("%s stopped", _LOG_PREFIX)

    # -- chat surface (intentionally unsupported) --------------------------

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[dict] = None,
    ) -> SendResult:
        return SendResult(
            success=False,
            error="pi-workbench hub does not deliver chat messages; talk to it over HTTP",
        )

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        return {"name": PLATFORM_NAME, "type": "channel"}
