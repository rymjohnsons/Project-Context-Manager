# main.py — FastAPI application entry point
#
# This file does three things:
#   1. Creates the FastAPI app instance
#   2. Configures CORS so browsers allow requests from the HTML frontend
#   3. Registers the route modules (users and lists)
#
# To start the server:
#   cd backend
#   pip install -r requirements.txt
#   uvicorn main:app --reload
#
# Then open http://localhost:8000/docs for the interactive API explorer.

from dotenv import load_dotenv
load_dotenv()  # must run before any import that reads os.environ at module level

import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

import models
from database import engine
from routes import lists, users

# Create all database tables defined in models.py if they don't already exist.
# SQLAlchemy compares the class definitions to the actual database schema and
# creates any missing tables. It does NOT modify existing tables — for that
# you would use a migration tool like Alembic.
models.Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="Project Context Manager API",
    description="Backend API for managing URL lists and user accounts.",
    version="1.0.0",
)

# ── CORS middleware ────────────────────────────────────────────────────────────
# Browsers enforce the Same-Origin Policy: a page at file:///index.html is
# blocked from fetching http://localhost:8000 unless the SERVER explicitly
# says it's allowed. This middleware adds the required headers to every response.
#
# allow_origins=["*"] permits any origin. Fine for local development;
# in production you'd list only your actual frontend domain(s).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],   # GET, POST, PUT, DELETE, OPTIONS, etc.
    allow_headers=["*"],   # Authorization, Content-Type, etc.
)

# Register both route modules. Each router's prefix (/users, /lists) is set
# inside its own file so it's self-documenting.
app.include_router(users.router)
app.include_router(lists.router)


@app.get("/app", tags=["frontend"])
def serve_frontend():
    """Serve the web app. Open http://localhost:8000/app in your browser."""
    html = os.path.join(os.path.dirname(__file__), '..', 'index.html')
    return FileResponse(os.path.abspath(html))


@app.get("/", tags=["health"])
def root():
    """Health check. Visit http://localhost:8000/docs for the API explorer."""
    return {"status": "ok", "message": "Open http://localhost:8000/app to use the app."}
