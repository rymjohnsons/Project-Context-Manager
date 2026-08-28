import logging
import os
import re
import secrets
import subprocess
import sys
from datetime import datetime, timedelta, timezone

# Matches "something@something.tld" — rejects "ryan@", "notanemail", etc.
_EMAIL_RE = re.compile(r'^[^\s@]+@[^\s@]+\.[^\s@]{2,}$')

from fastapi import Request
from limiter import limiter

# Install resend at startup if the build cache omitted it
try:
    import resend as _resend  # noqa: F401
except ImportError:
    _log_boot = logging.getLogger(__name__)
    _log_boot.warning("resend not found — installing now")
    subprocess.check_call(
        [sys.executable, "-m", "pip", "install", "resend", "-q"],
        stdout=subprocess.DEVNULL,
    )
    _log_boot.warning("resend installed successfully")

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

import models
import schemas
import auth
from database import get_db

router = APIRouter(prefix="/users", tags=["users"])
_log = logging.getLogger(__name__)

# ── Password-reset email ───────────────────────────────────────────────────────

_APP_URL = os.environ.get("APP_URL", "https://tabrador.app")

_RESET_EMAIL_HTML = """\
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;font-size:15px;color:#222;padding:32px;">
  <p><strong>Tabrador — Reset your password</strong></p>
  <p>We received a request to reset your Tabrador password. Click the link below to choose a new password. This link expires in 1 hour.</p>
  <p>Click here to reset your password:<br>
    <a href="RESET_LINK">RESET_LINK</a>
  </p>
  <p>If the link above doesn't work, copy and paste this URL into your browser:<br>
    RESET_LINK
  </p>
  <p style="color:#888;font-size:13px;">If you didn't request a password reset, you can ignore this email. Your password will not change.</p>
  <p style="color:#888;font-size:13px;">— Tabrador &middot; hello@tabrador.app</p>
</body>
</html>
"""


def _send_reset_email(to_email: str, token: str) -> None:
    """Send a password-reset email via the Resend SDK. Logs errors, never raises."""
    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key:
        _log.warning("RESEND_API_KEY not set — skipping password-reset email to %s", to_email)
        return

    reset_link = f"{_APP_URL}/reset-password?token={token}"
    html = _RESET_EMAIL_HTML.replace("RESET_LINK", reset_link)

    try:
        import resend
        resend.api_key = api_key
        plain = (
            f"Reset your Tabrador password\n\n"
            f"Click the link below to set a new password. It expires in 1 hour.\n\n"
            f"{reset_link}\n\n"
            f"If you didn't request this, you can ignore this email."
        )
        resend.Emails.send({
            "from":    "Tabrador <hello@tabrador.app>",
            "to":      [to_email],
            "subject": "Reset your Tabrador password",
            "html":    html,
            "text":    plain,
        })
        _log.info("Reset email sent to %s", to_email)
    except Exception as exc:
        _log.error("Failed to send reset email to %s: %s", to_email, exc)


# ── Routes ─────────────────────────────────────────────────────────────────────

@router.post("/register", response_model=schemas.UserOut, status_code=201)
@limiter.limit("5/minute")  # 5 registrations/min per IP — prevents bulk account creation
def register(request: Request, user_in: schemas.UserCreate, db: Session = Depends(get_db)):
    # ── Server-side validation ────────────────────────────────────────────────
    if len(user_in.password) < 8:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Password must be at least 8 characters.",
        )
    if not _EMAIL_RE.match(user_in.email.strip()):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Please enter a valid email address.",
        )
    # ─────────────────────────────────────────────────────────────────────────

    existing = db.query(models.User).filter(models.User.email == user_in.email).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="An account with that email already exists.",
        )
    user = models.User(
        email=user_in.email,
        hashed_password=auth.hash_password(user_in.password),
        trial_ends_at=datetime.now(timezone.utc) + timedelta(days=30),  # BILLING: 30-day trial
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    # Claim any workspace shares that were sent to this email before they had an account
    db.query(models.WorkspaceShare).filter(
        models.WorkspaceShare.recipient_email == user.email.lower(),
        models.WorkspaceShare.status          == "pending",
    ).update({
        "recipient_id": user.id,
        "status":       "claimed",
        "claimed_at":   datetime.now(timezone.utc),
    })
    db.commit()

    return user


@router.post("/login", response_model=schemas.Token)
@limiter.limit("10/minute")  # 10 attempts/min per IP — brute-force protection on login
def login(request: Request, user_in: schemas.UserCreate, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.email == user_in.email).first()
    if not user or not auth.verify_password(user_in.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password."
        )
    token = auth.create_access_token(user.id, user.token_version or 0)
    return {"access_token": token, "token_type": "bearer"}


@router.get("/me", response_model=schemas.UserOut)
def get_me(current_user: models.User = Depends(auth.get_current_user)):
    return current_user


# ONBOARDING: stores the work-role answer collected on first signup
@router.patch("/onboarding", response_model=schemas.UserOut)
def save_onboarding(
    data: schemas.OnboardingUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    current_user.work_type = data.work_type
    db.commit()
    db.refresh(current_user)
    return current_user


@router.get("/dashboard", response_model=schemas.DashboardOut)
def get_dashboard(
    db:           Session     = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    tabs_opened        = current_user.tabs_opened or 0
    time_saved_seconds = tabs_opened * 40

    # "This month" stat: count URLs in this user's lists opened since the 1st of the current month.
    # Each URL is counted once even if opened multiple times (best approximation without an events table).
    now         = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    tabs_this_month = (
        db.query(func.count(models.Url.id))
        .join(models.List, models.Url.list_id == models.List.id)
        .filter(
            models.List.owner_id     == current_user.id,
            models.Url.last_opened   >= month_start,
        )
        .scalar() or 0
    )
    time_saved_month_seconds = tabs_this_month * 40

    # All-users aggregate: sum of every user's cumulative tabs_opened counter.
    all_tabs = db.query(func.sum(models.User.tabs_opened)).scalar() or 0
    all_users_time_saved_seconds = int(all_tabs) * 40

    # Owned recently-opened workspaces (fetch more than 5 to allow merging with shared)
    owned_recent = (
        db.query(models.List)
        .filter(
            models.List.owner_id   == current_user.id,
            models.List.archived   == False,
            models.List.last_opened.isnot(None),
        )
        .order_by(models.List.last_opened.desc())
        .limit(10)
        .all()
    )
    owned_entries = [
        schemas.RecentWorkspace(
            id=lst.id,
            name=lst.name,
            url_count=len(lst.urls),
            last_opened=lst.last_opened,
            is_shared=False,
        )
        for lst in owned_recent
    ]

    # Shared workspaces the user has recently opened
    shared_entries: list[schemas.RecentWorkspace] = []
    try:
        shares = (
            db.query(models.WorkspaceShare)
            .filter(
                models.WorkspaceShare.recipient_id == current_user.id,
                models.WorkspaceShare.status       == "claimed",
            )
            .all()
        )
        for share in shares:
            ws = share.workspace
            if ws and not ws.archived and ws.last_opened:
                shared_entries.append(
                    schemas.RecentWorkspace(
                        id=ws.id,
                        name=ws.name,
                        url_count=len(ws.urls),
                        last_opened=ws.last_opened,
                        is_shared=True,
                        shared_by_email=share.shared_by.email,
                    )
                )
    except Exception as exc:
        _log.warning("shared-recent query failed (migration pending?): %s", exc)

    # Merge owned + shared, sort by last_opened desc, take top 5
    _epoch = datetime.min.replace(tzinfo=timezone.utc)
    recent_workspaces = sorted(
        owned_entries + shared_entries,
        key=lambda r: r.last_opened or _epoch,
        reverse=True,
    )[:5]

    total_workspaces = (
        db.query(models.List)
        .filter(models.List.owner_id == current_user.id,
                models.List.archived == False)
        .count()
    )

    # Wrap in try/except — workspace_shares may not exist yet if migration is pending
    try:
        shared_by_me = (
            db.query(models.WorkspaceShare)
            .filter(
                models.WorkspaceShare.shared_by_id == current_user.id,
                models.WorkspaceShare.status       == "claimed",
            )
            .count()
        )
        shared_with_me = (
            db.query(models.WorkspaceShare)
            .filter(
                models.WorkspaceShare.recipient_id == current_user.id,
                models.WorkspaceShare.status       == "claimed",
            )
            .count()
        )
    except Exception as exc:
        _log.warning("workspace_shares query failed (migration pending?): %s", exc)
        shared_by_me = shared_with_me = 0

    return schemas.DashboardOut(
        tabs_opened=tabs_opened,
        time_saved_seconds=time_saved_seconds,
        time_saved_month_seconds=time_saved_month_seconds,
        all_users_time_saved_seconds=all_users_time_saved_seconds,
        recent_workspaces=recent_workspaces,
        total_workspaces=total_workspaces,
        shared_by_me=shared_by_me,
        shared_with_me=shared_with_me,
    )


@router.patch("/me/password")
@limiter.limit("5/minute")  # prevent brute-forcing current password
def change_password(
    request:      Request,
    data:         schemas.PasswordChange,
    db:           Session     = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    if not auth.verify_password(data.current_password, current_user.hashed_password):
        raise HTTPException(status_code=400, detail="Current password is incorrect.")
    current_user.hashed_password = auth.hash_password(data.new_password)
    current_user.token_version   = (current_user.token_version or 0) + 1
    db.commit()
    return {"message": "Password updated successfully."}


@router.delete("/me", status_code=204)
@limiter.limit("3/minute")  # very strict — account deletion is irreversible
def delete_account(
    request:      Request,
    db:           Session     = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    uid = current_user.id

    # Null out added_by_id on URLs the user added to other people's workspaces
    db.query(models.Url).filter(models.Url.added_by_id == uid).update({"added_by_id": None})

    # Remove workspace shares (as sharer and as recipient — two separate queries)
    db.query(models.WorkspaceShare).filter(models.WorkspaceShare.shared_by_id == uid).delete()
    db.query(models.WorkspaceShare).filter(models.WorkspaceShare.recipient_id  == uid).delete()

    # Remove password reset tokens
    db.query(models.PasswordResetToken).filter(models.PasswordResetToken.user_id == uid).delete()

    # Delete the user — cascades to their lists and URLs
    db.delete(current_user)
    db.commit()


@router.post("/forgot-password", response_model=schemas.ForgotPasswordResponse)
@limiter.limit("5/minute")  # 5/min per IP — prevents email flooding / enumeration
def forgot_password(request: Request, req: schemas.ForgotPasswordRequest, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.email == req.email).first()
    if user:
        token_str = secrets.token_urlsafe(32)
        # Expire any existing unused tokens for this user.
        db.query(models.PasswordResetToken).filter(
            models.PasswordResetToken.user_id == user.id,
            models.PasswordResetToken.used == False,
        ).update({"used": True})
        db.commit()
        db.add(models.PasswordResetToken(user_id=user.id, token=token_str))
        db.commit()
        _send_reset_email(user.email, token_str)

    # Always return the same message — never reveal whether the email is registered.
    return {"message": "If that email is registered, a reset link has been sent. Check your inbox."}


@router.post("/reset-password")
@limiter.limit("5/minute")  # 5/min per IP — prevents token brute-forcing
def reset_password(request: Request, req: schemas.ResetPasswordRequest, db: Session = Depends(get_db)):
    record = db.query(models.PasswordResetToken).filter(
        models.PasswordResetToken.token == req.token,
        models.PasswordResetToken.used == False,
    ).first()

    if not record:
        raise HTTPException(status_code=400, detail="Invalid or expired reset token.")

    created = record.created_at
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    age_seconds = (datetime.now(timezone.utc) - created).total_seconds()
    if age_seconds > 3600:
        record.used = True
        db.commit()
        raise HTTPException(status_code=400, detail="This reset token has expired. Please request a new one.")

    record.user.hashed_password = auth.hash_password(req.new_password)
    record.user.token_version   = (record.user.token_version or 0) + 1
    record.used = True
    db.commit()
    return {"message": "Password updated successfully."}
