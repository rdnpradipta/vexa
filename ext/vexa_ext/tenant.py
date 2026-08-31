"""Fail-closed tenant identity for a dedicated single-tenant deployment."""
from __future__ import annotations

import os
import re

_TENANT_ID = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?")


def configured_tenant() -> str:
    """Return the immutable tenant assigned to this deployment.

    This extension deliberately enforces an instance-per-tenant boundary. It does not claim that
    ``ext_tenant`` is database row-level security. Every service, database, object store, Redis
    namespace, and persistent volume in the production deployment belongs to this one identifier.
    """
    tenant = os.getenv("VEXA_EXT_TENANT_ID", "").strip()
    if not _TENANT_ID.fullmatch(tenant):
        raise RuntimeError(
            "VEXA_EXT_TENANT_ID must be 1-64 lowercase ASCII letters, digits, or internal hyphens"
        )
    return tenant


async def resolve_tenant(user_id: int) -> str:
    """Stamp the deployment tenant for every authenticated user in this instance."""
    del user_id
    return configured_tenant()
