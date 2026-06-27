from slowapi import Limiter
from slowapi.util import get_remote_address

# Shared limiter instance imported by main.py (app setup) and route modules
# (per-endpoint @limiter.limit() decorators).
# default_limits applies to every endpoint that has no explicit @limiter.limit().
# To adjust the global cap, change the string here — format: "N/period"
# where period is second, minute, hour, or day.
limiter = Limiter(
    key_func=get_remote_address,
    default_limits=["100/minute"],  # global baseline — all endpoints
)
