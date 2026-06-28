"""billing columns — plan, trial, Stripe IDs, comp flag

Revision ID: 005
Revises: 004
Create Date: 2026-07-01

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '005'
down_revision: Union[str, None] = '004'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = set(inspector.get_table_names())

    if 'users' in existing:
        cols = {c['name'] for c in inspector.get_columns('users')}

        if 'plan' not in cols:
            op.add_column('users', sa.Column('plan', sa.String(), nullable=False, server_default='free'))
        if 'trial_ends_at' not in cols:
            op.add_column('users', sa.Column('trial_ends_at', sa.DateTime(timezone=True), nullable=True))
        if 'stripe_customer_id' not in cols:
            op.add_column('users', sa.Column('stripe_customer_id', sa.String(), nullable=True))
        if 'stripe_subscription_id' not in cols:
            op.add_column('users', sa.Column('stripe_subscription_id', sa.String(), nullable=True))
        if 'comped' not in cols:
            op.add_column('users', sa.Column('comped', sa.Boolean(), nullable=False, server_default='false'))
        if 'locked_price' not in cols:
            op.add_column('users', sa.Column('locked_price', sa.String(), nullable=True))

    # Give existing users without a trial_ends_at a 30-day grace period from today.
    op.execute(sa.text(
        "UPDATE users SET trial_ends_at = NOW() + INTERVAL '30 days' "
        "WHERE trial_ends_at IS NULL"
    ))


def downgrade() -> None:
    op.drop_column('users', 'locked_price')
    op.drop_column('users', 'comped')
    op.drop_column('users', 'stripe_subscription_id')
    op.drop_column('users', 'stripe_customer_id')
    op.drop_column('users', 'trial_ends_at')
    op.drop_column('users', 'plan')
