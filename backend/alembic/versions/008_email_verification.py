"""email_verified on users + email_verification_tokens table

Revision ID: 008
Revises: 007
Create Date: 2026-08-27

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '008'
down_revision: Union[str, None] = '007'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # Add email_verified to users — server_default='true' so all existing rows
    # are treated as verified and existing users are not disrupted.
    cols = {c['name'] for c in inspector.get_columns('users')}
    if 'email_verified' not in cols:
        op.add_column(
            'users',
            sa.Column('email_verified', sa.Boolean(), nullable=False, server_default='true'),
        )

    # Create email_verification_tokens table (idempotent)
    tables = set(inspector.get_table_names())
    if 'email_verification_tokens' not in tables:
        op.create_table(
            'email_verification_tokens',
            sa.Column('id', sa.Integer(), primary_key=True),
            sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id'), nullable=False),
            sa.Column('token', sa.String(), unique=True, nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()')),
            sa.Column('used', sa.Boolean(), nullable=False, server_default='false'),
        )


def downgrade() -> None:
    op.drop_table('email_verification_tokens')
    op.drop_column('users', 'email_verified')
