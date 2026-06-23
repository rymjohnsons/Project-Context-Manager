"""add permission column to workspace_shares

Revision ID: 004
Revises: 003
Create Date: 2026-06-22

Existing rows default to 'edit' so no access regressions.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '004'
down_revision: Union[str, None] = '003'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if 'workspace_shares' not in set(inspector.get_table_names()):
        return  # table doesn't exist yet — migration 003 will create it with the column

    cols = {c['name'] for c in inspector.get_columns('workspace_shares')}
    if 'permission' not in cols:
        op.add_column(
            'workspace_shares',
            sa.Column('permission', sa.String(), nullable=False, server_default='edit'),
        )


def downgrade() -> None:
    op.drop_column('workspace_shares', 'permission')
