import logging
import os

import stripe
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

import auth
import models
from database import get_db, SessionLocal
from billing import is_pro

router = APIRouter(prefix="/billing", tags=["billing"])
_log = logging.getLogger(__name__)

PRO_PRICE_ID = "price_1Tn84yJieM7nNrmHBu3CEOU9"


def _stripe():
    """Return stripe with the API key set from the environment."""
    stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "")
    return stripe


# ── Checkout ───────────────────────────────────────────────────────────────────

@router.post("/create-checkout-session")
def create_checkout_session(
    db:           Session     = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Create a Stripe Checkout session and return the hosted URL."""
    s = _stripe()

    session_params: dict = {
        "payment_method_types": ["card"],
        "line_items": [{"price": PRO_PRICE_ID, "quantity": 1}],
        "mode": "subscription",
        "success_url": "https://tabrador.app/billing/success",
        "cancel_url": "https://tabrador.app/app",
        # Embed user_id in subscription metadata so the webhook can look the user up
        "subscription_data": {
            "metadata": {"user_id": str(current_user.id)},
        },
    }

    if current_user.stripe_customer_id:
        session_params["customer"] = current_user.stripe_customer_id
    else:
        session_params["customer_email"] = current_user.email

    try:
        session = s.checkout.Session.create(**session_params)
    except Exception as exc:
        _log.error("Stripe checkout creation failed for user %s: %s", current_user.email, exc)
        raise HTTPException(
            status_code=502,
            detail="Could not create checkout session — please try again.",
        )

    return {"url": session.url}


# ── Webhook ────────────────────────────────────────────────────────────────────

@router.post("/webhook")
async def stripe_webhook(request: Request, db: Session = Depends(get_db)):
    """
    Public endpoint — no JWT auth.
    Verifies the Stripe-Signature header then dispatches to the appropriate
    event handler.  Register this URL in the Stripe dashboard:
        https://tabrador.app/billing/webhook
    """
    s              = _stripe()
    webhook_secret = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
    payload        = await request.body()
    sig_header     = request.headers.get("stripe-signature", "")

    try:
        event = s.Webhook.construct_event(payload, sig_header, webhook_secret)
    except stripe.error.SignatureVerificationError:
        _log.warning("Stripe webhook: invalid signature")
        raise HTTPException(status_code=400, detail="Invalid Stripe signature.")
    except Exception as exc:
        _log.error("Stripe webhook parse error: %s", exc)
        raise HTTPException(status_code=400, detail=str(exc))

    event_type = event["type"]
    _log.info("Stripe webhook received: %s", event_type)

    if event_type == "customer.subscription.created":
        _on_subscription_created(event["data"]["object"], db)
    elif event_type == "invoice.payment_succeeded":
        _on_payment_succeeded(event["data"]["object"], db)
    elif event_type == "invoice.payment_failed":
        _on_payment_failed(event["data"]["object"])
    elif event_type == "customer.subscription.deleted":
        _on_subscription_deleted(event["data"]["object"], db)

    return {"status": "ok"}


# ── Billing success page ───────────────────────────────────────────────────────

@router.get("/success", tags=["frontend"])
def billing_success():
    html = os.path.join(os.path.dirname(__file__), '..', '..', 'billing_success.html')
    return FileResponse(os.path.abspath(html))


# ── Internal event handlers ────────────────────────────────────────────────────

def _find_user(sub: dict, db: Session) -> models.User | None:
    """
    Look up a user from a subscription object.
    Primary key: sub.metadata.user_id (set at checkout creation).
    Fallback: stripe_customer_id column.
    """
    uid = (sub.get("metadata") or {}).get("user_id")
    if uid:
        try:
            user = db.query(models.User).filter(models.User.id == int(uid)).first()
            if user:
                return user
        except (ValueError, TypeError):
            pass
    return db.query(models.User).filter(
        models.User.stripe_customer_id == sub.get("customer")
    ).first()


def _on_subscription_created(sub: dict, db: Session) -> None:
    user = _find_user(sub, db)
    if not user:
        _log.warning("subscription.created — no user found for customer %s", sub.get("customer"))
        return
    user.plan                   = "pro"
    user.stripe_customer_id     = sub["customer"]
    user.stripe_subscription_id = sub["id"]
    # Store the price the user locked in — never overwrite for existing subscribers
    if not user.locked_price:
        items = (sub.get("items") or {}).get("data", [])
        if items:
            user.locked_price = items[0]["price"]["id"]
    db.commit()
    _log.info("User %s upgraded to Pro (sub %s)", user.email, sub["id"])


def _on_payment_succeeded(invoice: dict, db: Session) -> None:
    customer_id = invoice.get("customer")
    user = db.query(models.User).filter(
        models.User.stripe_customer_id == customer_id
    ).first()
    if user and user.plan != "pro":
        user.plan = "pro"
        db.commit()
    _log.info("invoice.payment_succeeded for customer %s", customer_id)


def _on_payment_failed(invoice: dict) -> None:
    customer_id    = invoice.get("customer")
    customer_email = invoice.get("customer_email", "unknown")
    _log.error("invoice.payment_failed — customer %s (%s)", customer_id, customer_email)

    # Notify the team; do NOT email the customer yet
    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key:
        return
    try:
        import resend
        resend.api_key = api_key
        resend.Emails.send({
            "from":    "Tabrador <hello@tabrador.app>",
            "to":      ["hello@tabrador.app"],
            "subject": f"Payment failed — {customer_email}",
            "text": (
                f"A payment failed for:\n\n"
                f"  Customer: {customer_email}\n"
                f"  Stripe ID: {customer_id}\n"
                f"  Invoice: {invoice.get('id')}\n\n"
                f"Check the Stripe dashboard for details."
            ),
        })
    except Exception as exc:
        _log.error("Failed to send payment-failure notification: %s", exc)


def _on_subscription_deleted(sub: dict, db: Session) -> None:
    user = _find_user(sub, db)
    if not user:
        _log.warning("subscription.deleted — no user found for customer %s", sub.get("customer"))
        return
    user.plan                   = "free"
    user.stripe_subscription_id = None
    db.commit()
    _log.info("User %s downgraded to free (sub %s deleted)", user.email, sub["id"])
