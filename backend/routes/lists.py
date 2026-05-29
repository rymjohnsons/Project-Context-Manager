# routes/lists.py — CRUD for lists and URLs
#
# All routes here are protected: the client must send a valid JWT token.
# Users can only read and modify their own lists.
#
# List endpoints:
#   GET    /lists                        get all lists for the logged-in user
#   POST   /lists                        create a new empty list
#   GET    /lists/{list_id}              get one list with all its URLs
#   PUT    /lists/{list_id}              rename a list
#   DELETE /lists/{list_id}              delete a list (and all its URLs)
#
# URL endpoints (nested under a list):
#   POST   /lists/{list_id}/urls         add a URL to a list
#   DELETE /lists/{list_id}/urls/{url_id}  remove one URL from a list

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

import models
import schemas
import auth
from database import get_db

router = APIRouter(prefix="/lists", tags=["lists"])


def get_list_or_404(list_id: int, user: models.User, db: Session) -> models.List:
    """
    Shared helper used by every list endpoint.

    Looks up the list and checks ownership in one place so we don't repeat
    this logic across every route. Raises the appropriate HTTP error if the
    list doesn't exist or belongs to a different user.
    """
    lst = db.query(models.List).filter(models.List.id == list_id).first()
    if lst is None:
        raise HTTPException(status_code=404, detail="List not found.")
    if lst.owner_id != user.id:
        # 403 Forbidden (not 404) so the client knows the resource exists but
        # they're not allowed to touch it.
        raise HTTPException(status_code=403, detail="You don't own this list.")
    return lst


# ── List CRUD ──────────────────────────────────────────────────────────────────

@router.get("", response_model=list[schemas.ListOut])
def get_lists(
    db:           Session      = Depends(get_db),
    current_user: models.User  = Depends(auth.get_current_user),
):
    """Return all lists belonging to the logged-in user, each with its URLs."""
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
    """Create a new empty list. Returns the created list."""
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
    """Return a single list with all its URLs."""
    return get_list_or_404(list_id, current_user, db)


@router.put("/{list_id}", response_model=schemas.ListOut)
def update_list(
    list_id:      int,
    list_in:      schemas.ListUpdate,
    db:           Session     = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Rename a list."""
    lst = get_list_or_404(list_id, current_user, db)
    lst.name = list_in.name.strip()
    db.commit()
    db.refresh(lst)
    return lst


@router.delete("/{list_id}", status_code=204)
def delete_list(
    list_id:      int,
    db:           Session     = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """
    Delete a list. All URLs in the list are deleted automatically because of
    the cascade="all, delete-orphan" setting on the relationship in models.py.
    Returns 204 No Content — no body, just confirmation that it worked.
    """
    lst = get_list_or_404(list_id, current_user, db)
    db.delete(lst)
    db.commit()


# ── URL CRUD (nested under /lists/{list_id}) ───────────────────────────────────

@router.post("/{list_id}/urls", response_model=schemas.UrlOut, status_code=201)
def add_url(
    list_id:      int,
    url_in:       schemas.UrlCreate,
    db:           Session     = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Add a URL to a list. Returns the created URL row."""
    get_list_or_404(list_id, current_user, db)  # verify the list exists and is ours
    url = models.Url(url=url_in.url, list_id=list_id)
    db.add(url)
    db.commit()
    db.refresh(url)
    return url


@router.delete("/{list_id}/urls/{url_id}", status_code=204)
def remove_url(
    list_id:      int,
    url_id:       int,
    db:           Session     = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Remove a single URL from a list."""
    get_list_or_404(list_id, current_user, db)  # verify ownership

    url = db.query(models.Url).filter(
        models.Url.id      == url_id,
        models.Url.list_id == list_id,   # prevent removing a URL from someone else's list
    ).first()

    if url is None:
        raise HTTPException(status_code=404, detail="URL not found in this list.")

    db.delete(url)
    db.commit()
