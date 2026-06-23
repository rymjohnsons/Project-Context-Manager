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
    # ONBOARDING: work role chosen during first-login flow
    work_type:  str | None = None

    model_config = {"from_attributes": True}


class OnboardingUpdate(BaseModel):
    # ONBOARDING: accepted values mirror the options shown on the onboarding screen
    work_type: str


# ── Auth schemas ───────────────────────────────────────────────────────────────

class Token(BaseModel):
    access_token: str
    token_type:   str


class TokenData(BaseModel):
    user_id: int | None = None


# ── Workspace share schemas ────────────────────────────────────────────────────

class WorkspaceShareCreate(BaseModel):
    email: str


class WorkspaceShareOut(BaseModel):
    id:              int
    recipient_email: str
    status:          str      # 'pending' | 'claimed'
    created_at:      datetime

    model_config = {"from_attributes": True}


class SharedWorkspaceOut(BaseModel):
    """A workspace shared with the current user (returned by /lists/shared-with-me)."""
    id:              int
    name:            str
    url_count:       int
    starred:         bool = False
    shared_by_email: str


# ── Dashboard schemas ──────────────────────────────────────────────────────────

class RecentWorkspace(BaseModel):
    id:          int
    name:        str
    url_count:   int
    last_opened: datetime | None = None


class DashboardOut(BaseModel):
    tabs_opened:        int
    time_saved_seconds: int
    recent_workspaces:  list[RecentWorkspace]
    total_workspaces:   int
    shared_by_me:       int
    shared_with_me:     int


# ── Password reset schemas ─────────────────────────────────────────────────────

class ForgotPasswordRequest(BaseModel):
    email: str


class ForgotPasswordResponse(BaseModel):
    message: str


class ResetPasswordRequest(BaseModel):
    token:        str
    new_password: str
