from dotenv import load_dotenv
load_dotenv()

import logging
import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

import models
from database import engine, DATABASE_URL
from routes import lists, users

logging.basicConfig(level=logging.INFO)
_log = logging.getLogger(__name__)
_log.info("Database: %s", "PostgreSQL" if not DATABASE_URL.startswith("sqlite") else "SQLite (local dev)")

# Safety net for local dev where alembic upgrade head hasn't run yet.
# On Railway the Procfile runs alembic first, so this is a no-op there.
models.Base.metadata.create_all(bind=engine)

app = FastAPI(title="Tabrador API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(users.router)
app.include_router(lists.router)


@app.get("/app", tags=["frontend"])
def serve_frontend():
    html = os.path.join(os.path.dirname(__file__), '..', 'index.html')
    return FileResponse(os.path.abspath(html))


@app.get("/", tags=["health"])
def root():
    return {"status": "ok", "message": "Open http://localhost:8000/app to use the app."}
