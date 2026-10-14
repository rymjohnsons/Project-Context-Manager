from datetime import datetime
from pydantic import BaseModel, Field

# ── Shared validation constants ────────────────────────────────────────────────
# Centralised here so register, change_password, and reset_password cannot drift.
_EMAIL_MAX_LEN       = 254   # RFC 5321 maximum
_PASSWORD_MIN_LEN    = 8
# Raw bcrypt silently truncates at 72 bytes — enforce this ceiling on NEW passwords
# so users are never surprised by "password changed" but the first 72 chars still match.
# Login intentionally has no max so existing accounts are never locked out.
_PASSWORD_NEW_MAX_LEN = 72

# ── URL schemas ────────────────────────────────────────────────────────────────

class UrlCreate(BaseModel):
    url: str = Field(..., max_length=2083)


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
    notes: str | None = Field(None, max_length=10000)


class UrlStar(BaseModel):
    starred: bool


class UrlTransferTarget(BaseModel):
    dest_list_id: int


# ── List schemas ───────────────────────────────────────────────────────────────

class ListCreate(BaseModel):
    name: str = Field(..., max_length=200)


class ListUpdate(BaseModel):
    name: str = Field(..., max_length=200)


class ListStar(BaseModel):
    starred: bool


class ListOut(BaseModel):
    id:       int
    name:     str
    starred:  bool = False
    archived: bool = False
    urls:     list[UrlOut] = []

    model_config = {"from_attributes": True}


# ── User schemas ───────────────────────────────────────────────────────────────

class UserCreate(BaseModel):
    # Used for both register AND login — password has no min/max here so existing
    # accounts can always log in. Length enforcement for new passwords is in the
    # register route manually and via Field constraints on the dedicated schemas below.
    email:    str = Field(..., max_length=_EMAIL_MAX_LEN)
    password: str


class UserOut(BaseModel):
    id:         int
    email:      str
    created_at: datetime
    # ONBOARDING: work role chosen during first-login flow
    work_type:  str | None = None
    # BILLING: subscription state exposed to the frontend for trial banners
    plan:                   str      = "free"
    trial_ends_at:          datetime | None = None
    comped:                 bool     = False
    # AUTH: whether the user has clicked their verification link
    email_verified:         bool     = True

    model_config = {"from_attributes": True}


class OnboardingUpdate(BaseModel):
    # ONBOARDING: accepted values mirror the options shown on the onboarding screen
    work_type: str = Field(..., max_length=100)


class PasswordChange(BaseModel):
    current_password: str
    new_password:     str = Field(..., min_length=_PASSWORD_MIN_LEN, max_length=_PASSWORD_NEW_MAX_LEN)


# ── Auth schemas ───────────────────────────────────────────────────────────────

class Token(BaseModel):
    access_token: str
    token_type:   str


class TokenData(BaseModel):
    user_id: int | None = None


# ── Workspace share schemas ────────────────────────────────────────────────────

class WorkspaceShareCreate(BaseModel):
    email:      str = Field(..., max_length=_EMAIL_MAX_LEN)
    permission: str = "edit"   # 'edit' | 'view'


class WorkspaceSharePermissionUpdate(BaseModel):
    permission: str            # 'edit' | 'view'


class WorkspaceShareOut(BaseModel):
    id:              int
    recipient_email: str
    status:          str       # 'pending' | 'claimed'
    permission:      str       # 'edit' | 'view'
    created_at:      datetime

    model_config = {"from_attributes": True}


class SharedWorkspaceOut(BaseModel):
    """A workspace shared with the current user (returned by /lists/shared-with-me)."""
    id:              int
    name:            str
    url_count:       int
    starred:         bool = False
    shared_by_email: str


class SharedOutWorkspace(BaseModel):
    """A workspace the current user has shared — with nested recipient list."""
    id:     int
    name:   str
    shares: list[WorkspaceShareOut]


# ── Dashboard schemas ──────────────────────────────────────────────────────────

class RecentWorkspace(BaseModel):
    id:              int
    name:            str
    url_count:       int
    last_opened:     datetime | None = None
    is_shared:       bool            = False
    shared_by_email: str | None      = None


class DashboardOut(BaseModel):
    tabs_opened:                  int
    time_saved_seconds:           int
    time_saved_month_seconds:     int
    all_users_time_saved_seconds: int
    recent_workspaces:            list[RecentWorkspace]
    total_workspaces:             int
    shared_by_me:                 int
    shared_with_me:               int


# ── Password reset schemas ─────────────────────────────────────────────────────

class EmailVerifyRequest(BaseModel):
    token: str


class ForgotPasswordRequest(BaseModel):
    email: str = Field(..., max_length=_EMAIL_MAX_LEN)


class ForgotPasswordResponse(BaseModel):
    message: str


class ResetPasswordRequest(BaseModel):
    token:        str
    new_password: str = Field(..., min_length=_PASSWORD_MIN_LEN, max_length=_PASSWORD_NEW_MAX_LEN)
