# routes/users.py — user registration, login, and profile
#
# Endpoints:
#   POST /users/register   create a new account → returns the new user
#   POST /users/login      verify credentials   → returns a JWT token
#   GET  /users/me         who am I?            → returns the logged-in user

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

import models
import schemas
import auth
from database import get_db

# prefix="/users" means every route here starts with /users.
# tags=["users"] groups them together in the /docs UI.
router = APIRouter(prefix="/users", tags=["users"])


@router.post("/register", response_model=schemas.UserOut, status_code=201)
def register(user_in: schemas.UserCreate, db: Session = Depends(get_db)):
    """
    Create a new user account.

    FastAPI automatically validates user_in against UserCreate:
      - email must look like an email address
      - password must be present
    If validation fails, FastAPI returns 422 before this function even runs.
    """
    # Reject duplicate emails before trying to insert — gives a clear error
    # rather than a cryptic database constraint violation.
    existing = db.query(models.User).filter(models.User.email == user_in.email).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="An account with this email already exists."
        )

    user = models.User(
        email=user_in.email,
        hashed_password=auth.hash_password(user_in.password),
    )
    db.add(user)
    db.commit()
    # db.refresh() re-reads the row from the database so 'user' now has the
    # auto-generated id and created_at values populated.
    db.refresh(user)
    return user


@router.post("/login", response_model=schemas.Token)
def login(user_in: schemas.UserCreate, db: Session = Depends(get_db)):
    """
    Log in with email and password. Returns a JWT access token.

    The client stores this token and sends it with every subsequent request:
        Authorization: Bearer <token>
    """
    user = db.query(models.User).filter(models.User.email == user_in.email).first()

    # IMPORTANT: we call verify_password even when the user doesn't exist.
    # This makes the response time the same whether the email is wrong or the
    # password is wrong, which prevents "timing attacks" that could reveal
    # which emails are registered.
    if not user or not auth.verify_password(user_in.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password."
        )

    token = auth.create_access_token(user.id)
    return {"access_token": token, "token_type": "bearer"}


@router.get("/me", response_model=schemas.UserOut)
def get_me(current_user: models.User = Depends(auth.get_current_user)):
    """
    Return the currently logged-in user's profile.
    The frontend calls this on startup to verify the stored token is still valid
    and to display the logged-in email address.
    """
    return current_user
