import ipaddress
import logging
from fastapi import Request
from slowapi import Limiter

_log = logging.getLogger(__name__)


def _get_real_ip(request: Request) -> str:
    """
    Extract the real client IP for rate-limit keying.

    Priority order:
      1. X-Real-IP — Railway's documented single-value header set exclusively
         by Railway's infrastructure. Unlike X-Forwarded-For, clients cannot
         prepend arbitrary values to it, so it is the safest primary source.
      2. X-Forwarded-For (leftmost) — kept as fallback for environments where
         X-Real-IP is absent (non-Railway deployments, local dev with a proxy).
      3. request.client.host — final fallback for direct connections (local dev).
    """
    # ── Primary: X-Real-IP ───────────────────────────────────────────────────
    x_real_ip = request.headers.get("X-Real-IP", "").strip()
    if x_real_ip:
        try:
            ipaddress.ip_address(x_real_ip)
            return x_real_ip
        except ValueError:
            _log.warning("X-Real-IP value %r is not a valid IP — falling back", x_real_ip)

    # ── Secondary: X-Forwarded-For leftmost ──────────────────────────────────
    xff = request.headers.get("X-Forwarded-For", "").strip()
    if xff:
        return xff.split(",")[0].strip()

    # ── Final: direct connection host ────────────────────────────────────────
    if request.client:
        return request.client.host
    return "unknown"


# Shared limiter instance imported by main.py (app setup) and route modules.
# default_limits applies to every endpoint with no explicit @limiter.limit().
# To adjust the global cap, change the string — format: "N/period"
# where period is second, minute, hour, or day.
limiter = Limiter(
    key_func=_get_real_ip,
    default_limits=["100/minute"],  # global baseline — all endpoints
)
