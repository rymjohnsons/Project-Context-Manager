from fastapi import Request
from slowapi import Limiter


def _get_real_ip(request: Request) -> str:
    """
    Extract the real client IP from the X-Forwarded-For header.

    Railway (and most PaaS / CDN proxies) set X-Forwarded-For to the true
    client IP. Without this, slowapi reads request.client.host which is the
    proxy's internal IP — making all traffic appear to come from one address
    and effectively disabling per-user rate limiting.

    X-Forwarded-For can be a comma-separated chain: "client, proxy1, proxy2".
    The leftmost value is the original client; we take that one.

    Falls back to the direct connection host when the header is absent
    (e.g. local development with no proxy in front).
    """
    xff = request.headers.get("X-Forwarded-For", "").strip()
    if xff:
        return xff.split(",")[0].strip()
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
