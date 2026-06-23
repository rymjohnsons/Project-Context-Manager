import re
import urllib.request
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

import models
import schemas
import auth
from database import get_db, SessionLocal
from models import utcnow

router = APIRouter(prefix="/lists", tags=["lists"])


def get_list_or_404(
    list_id:      int,
    user:         models.User,
    db:           Session,
    require_edit: bool = False,   # True → view-only recipients are rejected
) -> models.List:
    """Return the workspace if the user is the owner OR has a claimed share.
    Pass require_edit=True for write operations to enforce the view/edit tier."""
    lst = db.query(models.List).filter(models.List.id == list_id).first()
    if lst is None:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    if lst.owner_id != user.id:
        share = db.query(models.WorkspaceShare).filter(
            models.WorkspaceShare.workspace_id == list_id,
            models.WorkspaceShare.recipient_id  == user.id,
            models.WorkspaceShare.status        == "claimed",
        ).first()
        if not share:
            raise HTTPException(status_code=403, detail="You don't have access to this workspace.")
        if require_edit and share.permission == "view":
            raise HTTPException(
                status_code=403,
                detail="You have view-only access to this workspace.",
            )
    return lst


def _fetch_title(url: str) -> str | None:
    """Return the <title> of the page at url, or None if unreachable/missing."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.status == 200:
                html = resp.read(65536).decode("utf-8", errors="ignore")
                m = re.search(r'<title[^>]*>([^<]+)</title>', html, re.IGNORECASE)
                if m:
                    return m.group(1).strip()[:200]
    except Exception:
        pass
    return None


def _bg_store_title(url_id: int, url_str: str):
    """Background task: fetch page title and save it to the DB."""
    title = _fetch_title(url_str)
    if not title:
        return
    db = SessionLocal()
    try:
        obj = db.query(models.Url).filter(models.Url.id == url_id).first()
        if obj:
            obj.title = title
            db.commit()
    finally:
        db.close()


# ── Workspace sharing ──────────────────────────────────────────────────────────

@router.get("/shared-out", response_model=list[schemas.SharedOutWorkspace])
def get_shared_out(
    db:           Session     = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """All workspaces the current user has shared, grouped by workspace."""
    shares = (
        db.query(models.WorkspaceShare)
        .filter(models.WorkspaceShare.shared_by_id == current_user.id)
        .order_by(models.WorkspaceShare.workspace_id, models.WorkspaceShare.created_at)
        .all()
    )
    ws_map: dict[int, dict] = {}
    for share in shares:
        if share.workspace is None:
            continue
        ws_id = share.workspace_id
        if ws_id not in ws_map:
            ws_map[ws_id] = {"id": ws_id, "name": share.workspace.name, "shares": []}
        ws_map[ws_id]["shares"].append(share)
    return [
        schemas.SharedOutWorkspace(id=d["id"], name=d["name"], shares=d["shares"])
        for d in ws_map.values()
        if d["shares"]
    ]


@router.get("/shared-with-me", response_model=list[schemas.SharedWorkspaceOut])
def get_shared_workspaces(
    db:           Session     = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Workspaces other users have shared directly with the current user."""
    shares = (
        db.query(models.WorkspaceShare)
        .filter(
            models.WorkspaceShare.recipient_id == current_user.id,
            models.WorkspaceShare.status       == "claimed",
        )
        .all()
    )
    return [
        schemas.SharedWorkspaceOut(
            id=s.workspace.id,
            name=s.workspace.name,
            url_count=len(s.workspace.urls),
            starred=s.workspace.starred,
            shared_by_email=s.shared_by.email,
        )
        for s in shares
        if s.workspace is not None
    ]


@router.post("/{list_id}/share", response_model=schemas.WorkspaceShareOut, status_code=201)
def share_workspace(
    list_id:  int,
    share_in: schemas.WorkspaceShareCreate,
    db:       Session     = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Share a workspace to an email address (owner only)."""
    lst = db.query(models.List).filter(models.List.id == list_id).first()
    if lst is None:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    if lst.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the workspace owner can share it.")

    recipient_email = share_in.email.strip().lower()
    if recipient_email == current_user.email.lower():
        raise HTTPException(status_code=400, detail="You can't share a workspace with yourself.")

    # Prevent duplicate shares
    existing = db.query(models.WorkspaceShare).filter(
        models.WorkspaceShare.workspace_id    == list_id,
        models.WorkspaceShare.recipient_email == recipient_email,
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="Already shared with that email address.")

    # Immediate share if the recipient already has an account
    recipient = db.query(models.User).filter(
        func.lower(models.User.email) == recipient_email
    ).first()

    if share_in.permission not in ("view", "edit"):
        raise HTTPException(status_code=400, detail="Permission must be 'view' or 'edit'.")

    now = datetime.now(timezone.utc)
    share = models.WorkspaceShare(
        workspace_id    = list_id,
        shared_by_id    = current_user.id,
        recipient_email = recipient_email,
        recipient_id    = recipient.id if recipient else None,
        status          = "claimed"  if recipient else "pending",
        permission      = share_in.permission,
        claimed_at      = now        if recipient else None,
    )
    db.add(share)
    db.commit()
    db.refresh(share)
    return share


@router.delete("/{list_id}/shares/{share_id}", status_code=204)
def revoke_share(
    list_id:  int,
    share_id: int,
    db:       Session     = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Remove a share entirely — owner only. Works on pending and active shares."""
    lst = db.query(models.List).filter(models.List.id == list_id).first()
    if lst is None:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    if lst.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the workspace owner can revoke shares.")
    share = db.query(models.WorkspaceShare).filter(
        models.WorkspaceShare.id           == share_id,
        models.WorkspaceShare.workspace_id == list_id,
    ).first()
    if not share:
        raise HTTPException(status_code=404, detail="Share not found.")
    db.delete(share)
    db.commit()


@router.patch("/{list_id}/shares/{share_id}", response_model=schemas.WorkspaceShareOut)
def update_share_permission(
    list_id:  int,
    share_id: int,
    update:   schemas.WorkspaceSharePermissionUpdate,
    db:       Session     = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Change the view/edit permission on an existing share (owner only)."""
    lst = db.query(models.List).filter(models.List.id == list_id).first()
    if lst is None:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    if lst.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the workspace owner can change share permissions.")
    if update.permission not in ("view", "edit"):
        raise HTTPException(status_code=400, detail="Permission must be 'view' or 'edit'.")

    share = db.query(models.WorkspaceShare).filter(
        models.WorkspaceShare.id           == share_id,
        models.WorkspaceShare.workspace_id == list_id,
    ).first()
    if not share:
        raise HTTPException(status_code=404, detail="Share not found.")

    share.permission = update.permission
    db.commit()
    db.refresh(share)
    return share


@router.get("/{list_id}/shares", response_model=list[schemas.WorkspaceShareOut])
def get_workspace_shares(
    list_id:  int,
    db:       Session     = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Share status list for a workspace (owner only)."""
    lst = db.query(models.List).filter(models.List.id == list_id).first()
    if lst is None:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    if lst.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the workspace owner can view shares.")
    return (
        db.query(models.WorkspaceShare)
        .filter(models.WorkspaceShare.workspace_id == list_id)
        .order_by(models.WorkspaceShare.created_at)
        .all()
    )


# ── List CRUD ──────────────────────────────────────────────────────────────────

@router.get("", response_model=list[schemas.ListOut])
def get_lists(
    db:           Session      = Depends(get_db),
    current_user: models.User  = Depends(auth.get_current_user),
):
    return (
        db.query(models.List)
        .filter(models.List.owner_id == current_user.id)
        .all()
    )


@router.post("", response_model=schemas.ListOut, status_code=201)
def create_list(
    list_in:      schemas.ListCreate,
    db:           Session     = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    lst = models.List(name=list_in.name.strip(), owner_id=current_user.id)
    db.add(lst)
    db.commit()
    db.refresh(lst)
    return lst


@router.get("/{list_id}", response_model=schemas.ListOut)
def get_list(
    list_id:      int,
    db:           Session     = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    return get_list_or_404(list_id, current_user, db)


@router.put("/{list_id}", response_model=schemas.ListOut)
def update_list(
    list_id:      int,
    list_in:      schemas.ListUpdate,
    db:           Session     = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    lst = get_list_or_404(list_id, current_user, db, require_edit=True)
    lst.name = list_in.name.strip()
    db.commit()
    db.refresh(lst)
    return lst


@router.patch("/{list_id}/star", response_model=schemas.ListOut)
def star_list(
    list_id:      int,
    star_in:      schemas.ListStar,
    db:           Session     = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    # Starring is owner-only — the starred flag is workspace-global, not per-user
    lst = db.query(models.List).filter(models.List.id == list_id).first()
    if lst is None:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    if lst.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the workspace owner can star it.")
    lst.starred = star_in.starred
    db.commit()
    db.refresh(lst)
    return lst


@router.delete("/{list_id}", status_code=204)
def delete_list(
    list_id:      int,
    db:           Session     = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    # Delete is owner-only — recipients cannot destroy a workspace they don't own
    lst = db.query(models.List).filter(models.List.id == list_id).first()
    if lst is None:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    if lst.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the workspace owner can delete it.")
    db.delete(lst)
    db.commit()


# ── URL CRUD ───────────────────────────────────────────────────────────────────

@router.post("/{list_id}/urls", response_model=schemas.UrlOut, status_code=201)
def add_url(
    list_id:         int,
    url_in:          schemas.UrlCreate,
    background_tasks: BackgroundTasks,
    db:              Session     = Depends(get_db),
    current_user:    models.User = Depends(auth.get_current_user),
):
    get_list_or_404(list_id, current_user, db, require_edit=True)
    url = models.Url(url=url_in.url, list_id=list_id, added_by_id=current_user.id)
    db.add(url)
    db.commit()
    db.refresh(url)
    background_tasks.add_task(_bg_store_title, url.id, url_in.url)
    return url


@router.delete("/{list_id}/urls/{url_id}", status_code=204)
def remove_url(
    list_id:      int,
    url_id:       int,
    db:           Session     = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    get_list_or_404(list_id, current_user, db, require_edit=True)
    url = db.query(models.Url).filter(
        models.Url.id      == url_id,
        models.Url.list_id == list_id,
    ).first()
    if url is None:
        # TERMINOLOGY: "resource" used in all user-facing messages (was "URL")
        raise HTTPException(status_code=404, detail="Resource not found in this workspace.")
    db.delete(url)
    db.commit()


@router.patch("/{list_id}/urls/{url_id}/star", response_model=schemas.UrlOut)
def star_url(
    list_id:      int,
    url_id:       int,
    star_in:      schemas.UrlStar,
    db:           Session     = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    get_list_or_404(list_id, current_user, db, require_edit=True)
    url = db.query(models.Url).filter(
        models.Url.id      == url_id,
        models.Url.list_id == list_id,
    ).first()
    if url is None:
        raise HTTPException(status_code=404, detail="URL not found in this list.")
    url.starred = star_in.starred
    db.commit()
    db.refresh(url)
    return url


@router.patch("/{list_id}/urls/{url_id}/notes", response_model=schemas.UrlOut)
def update_url_notes(
    list_id:      int,
    url_id:       int,
    notes_in:     schemas.UrlNotesUpdate,
    db:           Session     = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    get_list_or_404(list_id, current_user, db, require_edit=True)
    url = db.query(models.Url).filter(
        models.Url.id      == url_id,
        models.Url.list_id == list_id,
    ).first()
    if url is None:
        raise HTTPException(status_code=404, detail="URL not found in this list.")
    url.notes = notes_in.notes
    db.commit()
    db.refresh(url)
    return url


@router.post("/{list_id}/urls/{url_id}/open", response_model=schemas.UrlOut)
def mark_url_opened(
    list_id:      int,
    url_id:       int,
    db:           Session     = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    lst = get_list_or_404(list_id, current_user, db)
    url = db.query(models.Url).filter(
        models.Url.id      == url_id,
        models.Url.list_id == list_id,
    ).first()
    if url is None:
        raise HTTPException(status_code=404, detail="URL not found in this list.")
    now = utcnow()
    url.last_opened          = now
    lst.last_opened          = now           # DASHBOARD: track workspace activity
    current_user.tabs_opened = (current_user.tabs_opened or 0) + 1  # DASHBOARD: time-saved metric
    db.commit()
    db.refresh(url)
    return url
