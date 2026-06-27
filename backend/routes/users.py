import logging
import os
import secrets
import subprocess
import sys
from datetime import datetime, timezone

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
def register(user_in: schemas.UserCreate, db: Session = Depends(get_db)):
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
def login(user_in: schemas.UserCreate, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.email == user_in.email).first()
    if not user or not auth.verify_password(user_in.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password."
        )
    token = auth.create_access_token(user.id)
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

    recent = (
        db.query(models.List)
        .filter(
            models.List.owner_id   == current_user.id,
            models.List.last_opened.isnot(None),
        )
        .order_by(models.List.last_opened.desc())
        .limit(5)
        .all()
    )

    total_workspaces = (
        db.query(models.List)
        .filter(models.List.owner_id == current_user.id)
        .count()
    )

    recent_workspaces = [
        schemas.RecentWorkspace(
            id=lst.id,
            name=lst.name,
            url_count=len(lst.urls),
            last_opened=lst.last_opened,
        )
        for lst in recent
    ]

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
        recent_workspaces=recent_workspaces,
        total_workspaces=total_workspaces,
        shared_by_me=shared_by_me,
        shared_with_me=shared_with_me,
    )


@router.post("/forgot-password", response_model=schemas.ForgotPasswordResponse)
def forgot_password(req: schemas.ForgotPasswordRequest, db: Session = Depends(get_db)):
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
def reset_password(req: schemas.ResetPasswordRequest, db: Session = Depends(get_db)):
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
    record.used = True
    db.commit()
    return {"message": "Password updated successfully."}
