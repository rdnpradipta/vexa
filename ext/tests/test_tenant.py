from __future__ import annotations

import pytest

from vexa_ext.__main__ import _strategy
from vexa_ext.tenant import resolve_tenant


def test_root_strategy_refuses_to_boot_without_tenant_id(monkeypatch):
    monkeypatch.setenv("VEXA_EXT_STRATEGY", "root")
    monkeypatch.delenv("VEXA_EXT_TENANT_ID", raising=False)

    with pytest.raises(RuntimeError, match="VEXA_EXT_TENANT_ID"):
        _strategy()


async def test_single_tenant_instance_refuses_missing_tenant_id(monkeypatch):
    monkeypatch.delenv("VEXA_EXT_TENANT_ID", raising=False)

    with pytest.raises(RuntimeError, match="VEXA_EXT_TENANT_ID"):
        await resolve_tenant(7)


@pytest.mark.parametrize(
    "tenant_id",
    ["", "contains spaces", "../other-tenant", "UPPERCASE", "x" * 65],
)
async def test_single_tenant_instance_refuses_malformed_tenant_id(monkeypatch, tenant_id):
    monkeypatch.setenv("VEXA_EXT_TENANT_ID", tenant_id)

    with pytest.raises(RuntimeError, match="VEXA_EXT_TENANT_ID"):
        await resolve_tenant(7)


async def test_single_tenant_instance_stamps_same_validated_tenant_for_every_user(monkeypatch):
    monkeypatch.setenv("VEXA_EXT_TENANT_ID", "ardian-vexa")

    assert await resolve_tenant(7) == "ardian-vexa"
    assert await resolve_tenant(99) == "ardian-vexa"
