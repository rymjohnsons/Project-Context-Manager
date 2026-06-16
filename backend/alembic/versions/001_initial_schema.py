"""initial schema — full current state

Revision ID: 001
Revises:
Create Date: 2026-06-15

This migration is safe to run against both:
  • A brand-new empty database  → creates all tables
  • The existing Railway PostgreSQL DB  → skips table creation, backfills any
    missing columns that were added via raw ALTER TABLE before Alembic was set up
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '001'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = set(inspector.get_table_names())

    # ── Create tables only if they don't already exist ────────────────────────

    if 'users' not in existing:
        op.create_table('users',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('email', sa.String(), nullable=False),
            sa.Column('hashed_password', sa.String(), nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('work_type', sa.String(), nullable=True),
            sa.PrimaryKeyConstraint('id'),
        )
        op.create_index('ix_users_id', 'users', ['id'], unique=False)
        op.create_index('ix_users_email', 'users', ['email'], unique=True)

    if 'lists' not in existing:
        op.create_table('lists',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('name', sa.String(), nullable=False),
            sa.Column('starred', sa.Boolean(), nullable=False, server_default='false'),
            sa.Column('owner_id', sa.Integer(), nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=True),
            sa.ForeignKeyConstraint(['owner_id'], ['users.id']),
            sa.PrimaryKeyConstraint('id'),
        )
        op.create_index('ix_lists_id', 'lists', ['id'], unique=False)

    if 'urls' not in existing:
        op.create_table('urls',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('url', sa.String(), nullable=False),
            sa.Column('title', sa.String(), nullable=True),
            sa.Column('notes', sa.Text(), nullable=True),
            sa.Column('last_opened', sa.DateTime(timezone=True), nullable=True),
            sa.Column('added_by_id', sa.Integer(), nullable=True),
            sa.Column('list_id', sa.Integer(), nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('starred', sa.Boolean(), nullable=False, server_default='false'),
            sa.ForeignKeyConstraint(['added_by_id'], ['users.id']),
            sa.ForeignKeyConstraint(['list_id'], ['lists.id']),
            sa.PrimaryKeyConstraint('id'),
        )
        op.create_index('ix_urls_id', 'urls', ['id'], unique=False)

    if 'password_reset_tokens' not in existing:
        op.create_table('password_reset_tokens',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('user_id', sa.Integer(), nullable=False),
            sa.Column('token', sa.String(), nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('used', sa.Boolean(), nullable=False, server_default='false'),
            sa.ForeignKeyConstraint(['user_id'], ['users.id']),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('token'),
        )
        op.create_index('ix_password_reset_tokens_id', 'password_reset_tokens', ['id'], unique=False)

    # ── Backfill columns missing on DBs created before Alembic ───────────────
    # Inspector state was captured before the CREATE TABLEs above, so this only
    # runs for tables that existed when the migration started — exactly right.
    _backfill_missing_columns(inspector, existing)


def _backfill_missing_columns(inspector, existing: set) -> None:
    """Add any columns that may be absent on a DB built by the old ALTER TABLE approach."""

    if 'lists' in existing:
        cols = {c['name'] for c in inspector.get_columns('lists')}
        if 'starred' not in cols:
            op.add_column('lists', sa.Column('starred', sa.Boolean(), nullable=False, server_default='false'))

    if 'urls' in existing:
        cols = {c['name'] for c in inspector.get_columns('urls')}
        pending = [
            ('title',       sa.Column('title', sa.String(), nullable=True)),
            ('notes',       sa.Column('notes', sa.Text(), nullable=True)),
            ('last_opened', sa.Column('last_opened', sa.DateTime(timezone=True), nullable=True)),
            ('added_by_id', sa.Column('added_by_id', sa.Integer(), nullable=True)),
            ('starred',     sa.Column('starred', sa.Boolean(), nullable=False, server_default='false')),
        ]
        for col_name, col_def in pending:
            if col_name not in cols:
                op.add_column('urls', col_def)

    if 'users' in existing:
        cols = {c['name'] for c in inspector.get_columns('users')}
        if 'work_type' not in cols:
            op.add_column('users', sa.Column('work_type', sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_table('password_reset_tokens')
    op.drop_table('urls')
    op.drop_table('lists')
    op.drop_table('users')
