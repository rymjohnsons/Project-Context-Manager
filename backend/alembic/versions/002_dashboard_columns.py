"""dashboard columns — tabs_opened on users, last_opened on lists

Revision ID: 002
Revises: 001
Create Date: 2026-06-20

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '002'
down_revision: Union[str, None] = '001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = set(inspector.get_table_names())

    if 'users' in existing:
        cols = {c['name'] for c in inspector.get_columns('users')}
        if 'tabs_opened' not in cols:
            op.add_column('users', sa.Column(
                'tabs_opened', sa.Integer(), nullable=False, server_default='0',
            ))

    if 'lists' in existing:
        cols = {c['name'] for c in inspector.get_columns('lists')}
        if 'last_opened' not in cols:
            op.add_column('lists', sa.Column(
                'last_opened', sa.DateTime(timezone=True), nullable=True,
            ))


def downgrade() -> None:
    op.drop_column('users', 'tabs_opened')
    op.drop_column('lists', 'last_opened')
