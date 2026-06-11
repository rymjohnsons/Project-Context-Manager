import re
import httpx

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy.orm import Session

import models
import schemas
import auth
from database import get_db, SessionLocal
from models import utcnow

router = APIRouter(prefix="/lists", tags=["lists"])


def get_list_or_404(list_id: int, user: models.User, db: Session) -> models.List:
    lst = db.query(models.List).filter(models.List.id == list_id).first()
    if lst is None:
        raise HTTPException(status_code=404, detail="List not found.")
    if lst.owner_id != user.id:
        raise HTTPException(status_code=403, detail="You don't own this list.")
    return lst


def _fetch_title(url: str) -> str | None:
    """Return the <title> of the page at url, or None if unreachable/missing."""
    try:
        with httpx.Client(timeout=5, follow_redirects=True) as client:
            resp = client.get(url, headers={"User-Agent": "Mozilla/5.0"})
            if resp.status_code == 200:
                m = re.search(r'<title[^>]*>([^<]+)</title>', resp.text, re.IGNORECASE)
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
    lst = get_list_or_404(list_id, current_user, db)
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
    lst = get_list_or_404(list_id, current_user, db)
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
    lst = get_list_or_404(list_id, current_user, db)
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
    get_list_or_404(list_id, current_user, db)
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
    get_list_or_404(list_id, current_user, db)
    url = db.query(models.Url).filter(
        models.Url.id      == url_id,
        models.Url.list_id == list_id,
    ).first()
    if url is None:
        raise HTTPException(status_code=404, detail="URL not found in this list.")
    db.delete(url)
    db.commit()


@router.patch("/{list_id}/urls/{url_id}/notes", response_model=schemas.UrlOut)
def update_url_notes(
    list_id:      int,
    url_id:       int,
    notes_in:     schemas.UrlNotesUpdate,
    db:           Session     = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    get_list_or_404(list_id, current_user, db)
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
    get_list_or_404(list_id, current_user, db)
    url = db.query(models.Url).filter(
        models.Url.id      == url_id,
        models.Url.list_id == list_id,
    ).first()
    if url is None:
        raise HTTPException(status_code=404, detail="URL not found in this list.")
    url.last_opened = utcnow()
    db.commit()
    db.refresh(url)
    return url
