"""The only file in this plugin that touches the Hermes plugin API.

Keep it small: upstream signature churn should never reach ``core/``.

Responsibilities
----------------
* declare the platform to the gateway (``register_platform``) so the gateway
  owns the hub server's lifecycle (start on connect, stop on disconnect);
* resolve where durable state may live (``plugin_data_dir``) and hand it to
  ``core``;
* read configuration from the environment and pass it down.

Nothing here raises at import time: a broken hub must degrade to a logged
warning, never to an import error that would take the gateway down with it.
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

PLUGIN_ID = "pi-workbench"
PLATFORM_NAME = "pi-workbench"
PLATFORM_LABEL = "Pi Workbench"

DEFAULT_API_BASE = "http://127.0.0.1:8642"
DEFAULT_DASHBOARD_BASE = "http://127.0.0.1:9119"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8484
DEFAULT_RATE_LIMIT = 60


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return int(str(raw).strip())
    except (TypeError, ValueError):
        logger.warning("[hub] %s=%r is not an integer, using %d", name, raw, default)
        return default


def _deps_ok() -> bool:
    """Passive probe: are the stdlib modules we need importable?

    Must never install anything — the gateway calls it freely for status
    displays.
    """
    try:
        import http.server  # noqa: F401
        import sqlite3  # noqa: F401
        import urllib.request  # noqa: F401
    except Exception:  # pragma: no cover - stdlib, but never break the gateway
        logger.warning("[hub] stdlib probe failed", exc_info=True)
        return False
    return True


def _data_dir():
    """Durable state root, resolved through Hermes so it follows the profile."""
    from plugins.plugin_storage import plugin_data_dir

    return plugin_data_dir(PLUGIN_ID)


def _make_adapter(config):
    from .adapter import PiWorkbenchAdapter

    return PiWorkbenchAdapter(config, _data_dir=_data_dir())


def register(ctx) -> None:
    """Called once per process by the Hermes plugin loader."""
    admin_key = os.environ.get("PI_HUB_ADMIN_KEY", "")
    if not admin_key:
        logger.warning(
            "[hub] PI_HUB_ADMIN_KEY is not set: device registration/revocation is disabled. "
            "Set it in the gateway systemd unit (not in .env: the agent can read that)."
        )

    ctx.register_platform(
        name=PLATFORM_NAME,
        label=PLATFORM_LABEL,
        adapter_factory=_make_adapter,
        check_fn=_deps_ok,
        required_env=["PI_HUB_ADMIN_KEY"],
        install_hint="set PI_HUB_ADMIN_KEY in the gateway service environment",
    )
    logger.info(
        "[hub] platform registered (port=%s admin_key=%s)",
        _int_env("PI_HUB_PORT", DEFAULT_PORT),
        "set" if admin_key else "MISSING",
    )
