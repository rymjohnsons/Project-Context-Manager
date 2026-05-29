# auth.py — password hashing and JWT token management
#
# Two separate concerns live here:
#
# 1. PASSWORDS
#    Passwords are never stored as plain text. We use bcrypt to turn "hunter2"
#    into "$2b$12$..." — a one-way hash. On login, we hash the attempt and
#    compare hashes; we never reverse the stored hash.
#
# 2. JWT TOKENS
#    After a successful login we issue a JSON Web Token (JWT). The client
#    stores it and sends it with every request as:
#        Authorization: Bearer <token>
#    JWTs are signed with a secret key, so the server can verify them without
#    a database lookup. The token payload contains the user's ID and an
#    expiry time.

import os
from datetime import datetime, timedelta, timezone

import bcrypt as _bcrypt
from jose import JWTError, jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

import models
from database import get_db

# ── Secret key ─────────────────────────────────────────────────────────────────
# This key signs every JWT. Anyone with this key can forge tokens, so in
# production it must be a long random string stored in an environment variable.
# For local development a hardcoded value is fine.
# Read from the environment so the real secret is never committed to git.
# Locally: set in backend/.env
# Railway: set as an environment variable in the Railway dashboard
SECRET_KEY = os.environ.get("SECRET_KEY", "local-dev-only-change-before-deploying")
ALGORITHM  = "HS256"

# Tokens expire after 7 days. The user will need to log in again after that.
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7

# ── OAuth2 bearer scheme ───────────────────────────────────────────────────────
# This tells FastAPI where to look for the token (Authorization header) and
# which endpoint to advertise as the login URL in the /docs UI.
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/users/login")


def hash_password(plain: str) -> str:
    """Hash a plain-text password. Always use this before storing."""
    return _bcrypt.hashpw(plain.encode(), _bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    """Return True if plain matches the stored hash."""
    return _bcrypt.checkpw(plain.encode(), hashed.encode())


def create_access_token(user_id: int) -> str:
    """
    Create a signed JWT encoding the user's ID.

    The payload contains:
      sub  — the subject (who this token is for), stored as a string
      exp  — expiry timestamp (jose checks this automatically on decode)
    """
    expire  = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {"sub": str(user_id), "exp": expire}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(
    token: str = Depends(oauth2_scheme),
    db:    Session = Depends(get_db),
) -> models.User:
    """
    FastAPI dependency used by every protected route.

    FastAPI reads the Bearer token from the Authorization header, passes it
    here, and we verify it. If valid, we return the User row from the database.
    If anything is wrong — missing token, expired, tampered, user deleted —
    we raise HTTP 401 and FastAPI returns that error to the client.

    Routes use it like:  current_user: models.User = Depends(get_current_user)
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired token. Please log in again.",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = int(payload["sub"])
    except (JWTError, KeyError, ValueError):
        raise credentials_exception

    user = db.query(models.User).filter(models.User.id == user_id).first()
    if user is None:
        raise credentials_exception

    return user
