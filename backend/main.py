from dotenv import load_dotenv
load_dotenv()

import logging
import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse

import models
from database import engine, DATABASE_URL
from routes import lists, users

logging.basicConfig(level=logging.INFO)
_log = logging.getLogger(__name__)
_log.info("Database: %s", "PostgreSQL" if not DATABASE_URL.startswith("sqlite") else "SQLite (local dev)")

# Migrations are handled by 'alembic upgrade head' in the Procfile before uvicorn starts.
# create_all is a safety net for local dev (no-op when Alembic has already created tables).
models.Base.metadata.create_all(bind=engine)

app = FastAPI(title="Tabrador API", version="1.0.0")

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
