from datetime import datetime
from pydantic import BaseModel


# ── URL schemas ────────────────────────────────────────────────────────────────

class UrlCreate(BaseModel):
    url: str


class UrlOut(BaseModel):
    id:             int
    url:            str
    title:          str | None = None
    notes:          str | None = None
    last_opened:    datetime | None = None
    added_by_email: str | None = None
    starred:        bool = False

    model_config = {"from_attributes": True}


class UrlNotesUpdate(BaseModel):
    notes: str | None = None


class UrlStar(BaseModel):
    starred: bool


# ── List schemas ───────────────────────────────────────────────────────────────

class ListCreate(BaseModel):
    name: str


class ListUpdate(BaseModel):
    name: str


class ListStar(BaseModel):
    starred: bool


class ListOut(BaseModel):
    id:       int
    name:     str
    starred:  bool = False
    owner_id: int
    urls:     list[UrlOut] = []

    model_config = {"from_attributes": True}


# ── User schemas ───────────────────────────────────────────────────────────────

class UserCreate(BaseModel):
    email:    str
    password: str


class UserOut(BaseModel):
    id:         int
    email:      str
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Auth schemas ───────────────────────────────────────────────────────────────

class Token(BaseModel):
    access_token: str
    token_type:   str


class TokenData(BaseModel):
    user_id: int | None = None


# ── Password reset schemas ─────────────────────────────────────────────────────

class ForgotPasswordRequest(BaseModel):
    email: str


class ForgotPasswordResponse(BaseModel):
    token: str


class ResetPasswordRequest(BaseModel):
    token:        str
    new_password: str
