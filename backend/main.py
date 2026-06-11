from dotenv import load_dotenv
load_dotenv()

import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

import models
from database import engine
from routes import lists, users
from sqlalchemy import text

models.Base.metadata.create_all(bind=engine)

# Lightweight ALTER TABLE migrations for columns added after initial deploy.
# Each statement is wrapped individually so one failure doesn't block the rest.
_migrations = [
    # lists table
    "ALTER TABLE lists ADD COLUMN starred BOOLEAN DEFAULT FALSE NOT NULL",
    # urls table — new columns
    "ALTER TABLE urls ADD COLUMN title VARCHAR",
    "ALTER TABLE urls ADD COLUMN notes TEXT",
    "ALTER TABLE urls ADD COLUMN last_opened TIMESTAMP WITH TIME ZONE",
    "ALTER TABLE urls ADD COLUMN added_by_id INTEGER REFERENCES users(id)",
]

for _sql in _migrations:
    with engine.connect() as _conn:
        try:
            _conn.execute(text(_sql))
            _conn.commit()
        except Exception:
            _conn.rollback()

app = FastAPI(
    title="Project Context Manager API",
    version="1.0.0",
)

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
