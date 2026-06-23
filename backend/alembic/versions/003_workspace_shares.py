"""workspace_shares table for email-based sharing

Revision ID: 003
Revises: 002
Create Date: 2026-06-22

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '003'
down_revision: Union[str, None] = '002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if 'workspace_shares' in set(inspector.get_table_names()):
        return  # already exists — safe to skip

    op.create_table(
        'workspace_shares',
        sa.Column('id',              sa.Integer(),              nullable=False),
        sa.Column('workspace_id',    sa.Integer(),              nullable=False),
        sa.Column('shared_by_id',    sa.Integer(),              nullable=False),
        sa.Column('recipient_email', sa.String(),               nullable=False),
        sa.Column('recipient_id',    sa.Integer(),              nullable=True),
        sa.Column('status',          sa.String(),               nullable=False, server_default='pending'),
        sa.Column('created_at',      sa.DateTime(timezone=True), nullable=True),
        sa.Column('claimed_at',      sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['workspace_id'],  ['lists.id'],  ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['shared_by_id'],  ['users.id'],  ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['recipient_id'],  ['users.id'],  ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_workspace_shares_id',              'workspace_shares', ['id'])
    op.create_index('ix_workspace_shares_recipient_email', 'workspace_shares', ['recipient_email'])
    op.create_index('ix_workspace_shares_workspace_id',    'workspace_shares', ['workspace_id'])


def downgrade() -> None:
    op.drop_table('workspace_shares')
