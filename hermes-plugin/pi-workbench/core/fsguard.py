"""Path guard for dashboard-hosted file reads (defence in depth).

The dashboard already validates these reads itself; the hub refuses anything
outside the profile's staged-uploads root so a compromised device token cannot
turn ``/api/fs/read-data-url`` into an arbitrary host file reader.
"""

from __future__ import annotations

import os
from pathlib import Path


def default_roots(profile_home: str | os.PathLike[str] | None) -> list[Path]:
    roots: list[Path] = []
    if profile_home:
        home = Path(profile_home)
        roots.extend([home / "uploads", home / "image_cache", home / "audio_cache"])
    return roots


def resolve_roots(raw: str | None, profile_home: str | os.PathLike[str] | None) -> list[Path]:
    """``PI_HUB_FS_ROOTS`` (``:``-separated) overrides the defaults."""
    if raw:
        roots = [Path(part).expanduser() for part in raw.split(os.pathsep) if part.strip()]
    else:
        roots = default_roots(profile_home)
    resolved = []
    for root in roots:
        try:
            resolved.append(root.resolve())
        except OSError:
            continue
    return resolved


def ensure_allowed(path: str, roots: list[Path]) -> Path:
    """Return the resolved path, or raise ``path_not_allowed``."""
    from .errors import HubError

    if not path:
        raise HubError("bad_request", "path is required")
    candidate = Path(path)
    if not candidate.is_absolute():
        raise HubError("path_not_allowed", "path must be absolute")
    try:
        real = candidate.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise HubError("path_not_allowed", f"cannot resolve path: {exc}") from exc
    for root in roots:
        try:
            real.relative_to(root)
        except ValueError:
            continue
        return real
    raise HubError("path_not_allowed", "path is outside the allowed roots")
