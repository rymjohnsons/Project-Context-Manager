"""Billing utility functions shared across routes."""
from datetime import datetime, timezone


def is_pro(user) -> bool:
    """
    A user is considered Pro if any of the following is true:
      - plan == 'pro'  (active Stripe subscription)
      - comped == True (manual comp granted by admin)
      - trial_ends_at is in the future (still in 30-day trial)
    """
    if user.comped:
        return True
    if user.plan == "pro":
        return True
    if user.trial_ends_at:
        trial_end = user.trial_ends_at
        if trial_end.tzinfo is None:
            trial_end = trial_end.replace(tzinfo=timezone.utc)
        if trial_end > datetime.now(timezone.utc):
            return True
    return False


def trial_days_remaining(user) -> int | None:
    """
    Returns the number of days left in the user's trial, or None if no
    active trial exists (trial ended, no trial set, or user is already Pro).
    """
    if not user.trial_ends_at:
        return None
    trial_end = user.trial_ends_at
    if trial_end.tzinfo is None:
        trial_end = trial_end.replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    if trial_end <= now:
        return None
    return max(0, (trial_end - now).days)
