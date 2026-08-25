"""token_version column on users — for JWT invalidation on password change

Revision ID: 007
Revises: 006
Create Date: 2026-08-24

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '007'
down_revision: Union[str, None] = '006'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    cols = {c['name'] for c in inspector.get_columns('users')}
    if 'token_version' not in cols:
        op.add_column(
            'users',
            sa.Column('token_version', sa.Integer(), nullable=False, server_default='0'),
        )


def downgrade() -> None:
    op.drop_column('users', 'token_version')
