from dotenv import load_dotenv
load_dotenv()

import logging
import os
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

import models
from database import engine, DATABASE_URL
from limiter import limiter
from routes import billing, lists, users

logging.basicConfig(level=logging.INFO)
_log = logging.getLogger(__name__)
_log.info("Database: %s", "PostgreSQL" if not DATABASE_URL.startswith("sqlite") else "SQLite (local dev)")

# ── Startup config guards ──────────────────────────────────────────────────────
# SECRET_KEY is validated in auth.py (raises RuntimeError at import time if missing).
# STRIPE_WEBHOOK_SECRET is checked here because billing.py reads it lazily.
if not os.environ.get("STRIPE_WEBHOOK_SECRET"):
    raise RuntimeError(
        "STRIPE_WEBHOOK_SECRET environment variable is not set — refusing to start."
    )

# Migrations are handled by 'alembic upgrade head' in the Procfile before uvicorn starts.
# create_all is a safety net for local dev (no-op when Alembic has already created tables).
models.Base.metadata.create_all(bind=engine)

app = FastAPI(title="Tabrador API", version="1.0.0")

# ── Rate limiting ──────────────────────────────────────────────────────────────
# Global default: 100 req/min per IP (see limiter.py).
# Auth endpoints override this with stricter per-endpoint limits in routes/users.py.
# To change any limit, update the @limiter.limit() decorator on the endpoint
# or change default_limits in limiter.py.

app.state.limiter = limiter
app.add_middleware(SlowAPIMiddleware)

async def _rate_limit_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    return JSONResponse(
        status_code=429,
        content={"error": "Too many requests. Please try again in a moment."},
    )

app.add_exception_handler(RateLimitExceeded, _rate_limit_handler)

# ── Content Security Policy ────────────────────────────────────────────────────
# Restricts what the browser will load or execute on any page served by this app.
# style-src includes 'unsafe-inline' because the SPA uses an inline <style> block.
# font-src allows fonts.gstatic.com because Plus Jakarta Sans is loaded via Google Fonts.
_CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src 'self' https://fonts.gstatic.com; "
    "connect-src 'self'; "
    "img-src 'self' data:; "
    "object-src 'none'; "
    "base-uri 'self';"
)

@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = _CSP
    return response

# ── CORS ───────────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://tabrador.app",
        "https://www.tabrador.app",
        "https://web-production-b9ae2.up.railway.app",  # keep old URL working
        "http://localhost:8000",
        "http://localhost:3000",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(users.router)
app.include_router(lists.router)
app.include_router(billing.router)


@app.get("/app", tags=["frontend"])
def serve_frontend():
    html = os.path.join(os.path.dirname(__file__), '..', 'index.html')
    return FileResponse(os.path.abspath(html))


@app.get("/", tags=["frontend"])
def root():
    html = os.path.join(os.path.dirname(__file__), '..', 'index.html')
    return FileResponse(os.path.abspath(html))


@app.get("/reset-password", tags=["frontend"])
def reset_password_page():
    # Serves index.html so password-reset email links (tabrador.app/reset-password?token=...)
    # load the frontend, which reads the token from the query string in boot().
    html = os.path.join(os.path.dirname(__file__), '..', 'index.html')
    return FileResponse(os.path.abspath(html))


@app.get("/terms", tags=["legal"])
def terms_page():
    html = os.path.join(os.path.dirname(__file__), '..', 'terms.html')
    return FileResponse(os.path.abspath(html))


@app.get("/privacy", tags=["legal"])
def privacy_page():
    html = os.path.join(os.path.dirname(__file__), '..', 'privacy.html')
    return FileResponse(os.path.abspath(html))
