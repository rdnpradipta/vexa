from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "deploy/compose/docker-compose.yml"
PROD = ROOT / "ext/compose/docker-compose.production.yml"


def _production_result(
    *, include_project_name: bool = True, include_internal_ui: bool = False,
) -> subprocess.CompletedProcess[str]:
    env = {
        **os.environ,
        "COMPOSE_PROJECT_NAME": "vexa-prod-test",
        "DB_NAME": "vexa",
        "DB_USER": "vexa_app",
        "DB_PASSWORD": "test-db-secret-not-a-default",
        "MINIO_ACCESS_KEY": "test-minio-user",
        "MINIO_SECRET_KEY": "test-minio-secret-not-a-default",
        "ADMIN_TOKEN": "test-admin-secret-not-a-default",
        "INTERNAL_API_SECRET": "test-internal-secret-not-a-default",
        "GATEWAY_IDENTITY_SECRET": "test-gateway-proof-not-a-default",
        "VEXA_DISPATCH_SIGNING_KEY": "test-dispatch-secret-not-a-default",
        "NEXTAUTH_SECRET": "test-nextauth-secret-not-a-default",
        "VEXA_DIRECT_LOGIN_EMAILS": "ardian@example.test",
        "VEXA_DIRECT_LOGIN_PASSWORD_SCRYPT": "scrypt:16384:8:1:dGVzdC1zYWx0LTE2Ynl0ZQ:4H5nIPHeCnUq9GxxTxJ_pdSFeLg_hBbv8lQrJDAZBLTJ_yiO81566SUmkeBEfCm52yim0oLW6aKJz2jIQH1RgQ",
        "VEXA_EXT_TENANT_ID": "ardian-vexa",
        "DOCKER_GID": "977",
        "IMAGE_TAG": "hardened-test",
    }
    if not include_project_name:
        env.pop("COMPOSE_PROJECT_NAME", None)
    command = ["docker", "compose", "-f", str(BASE), "-f", str(PROD)]
    if include_internal_ui:
        command.extend(["--profile", "internal-ui"])
    command.extend(["config", "--format", "json"])
    return subprocess.run(
        command,
        cwd=ROOT / "deploy/compose",
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def _production_config() -> dict:
    result = _production_result()
    assert result.returncode == 0, result.stderr or result.stdout
    return json.loads(result.stdout)


def test_production_compose_requires_explicit_project_name():
    result = _production_result(include_project_name=False)
    assert result.returncode != 0
    assert "COMPOSE_PROJECT_NAME" in (result.stderr + result.stdout)


def test_production_compose_exposes_only_origin_proxy_on_loopback():
    config = _production_config()
    published = {
        name: service.get("ports", [])
        for name, service in config["services"].items()
        if service.get("ports")
    }
    assert set(published) == {"origin-proxy", "tailnet-origin-proxy-v2"}
    assert published["origin-proxy"] == [{
        "mode": "ingress",
        "host_ip": "127.0.0.1",
        "target": 8080,
        "published": "18056",
        "protocol": "tcp",
    }]
    assert published["tailnet-origin-proxy-v2"] == [{
        "mode": "ingress",
        "host_ip": "100.71.128.112",
        "target": 8080,
        "published": "18058",
        "protocol": "tcp",
    }]


def test_production_compose_fails_closed_and_bakes_extension():
    config = _production_config()
    services = config["services"]
    forbidden = {
        "postgres", "changeme", "vexa-internal-secret", "vexa-secret-key",
        "dev-dispatch-signing-key", "dev-nextauth-secret", "unassigned", "u_live",
    }
    credential_values = {
        str(value)
        for service in services.values()
        for key, value in (service.get("environment") or {}).items()
        if any(marker in key.upper() for marker in ("PASSWORD", "SECRET", "TOKEN", "API_KEY", "SIGNING_KEY"))
        or key.upper() in {"DB_USER", "POSTGRES_USER"}
    }
    assert forbidden.isdisjoint(credential_values)
    assert services["agent-api"]["environment"]["VEXA_AGENT_DEFAULT_SUBJECT"] == ""
    assert services["agent-api"]["environment"]["VEXA_REQUIRE_GATEWAY_IDENTITY"] == "true"
    assert services["agent-api"]["environment"]["VEXA_GATEWAY_IDENTITY_SECRET"] == "test-gateway-proof-not-a-default"
    assert services["gateway"]["environment"]["GATEWAY_IDENTITY_SECRET"] == "test-gateway-proof-not-a-default"
    assert services["meeting-api"]["command"] == ["python", "-m", "vexa_ext"]
    assert services["meeting-api"]["environment"]["VEXA_EXT_STRATEGY"] == "root"
    assert services["meeting-api"]["environment"]["VEXA_EXT_TENANT_ID"] == "ardian-vexa"
    assert all(
        volume.get("target") != "/app/src/vexa_ext"
        for volume in services["meeting-api"].get("volumes", [])
        if isinstance(volume, dict)
    )


def test_internal_ui_profile_isolates_terminal_origin():
    result = _production_result(include_internal_ui=True)
    assert result.returncode == 0, result.stderr or result.stdout
    config = json.loads(result.stdout)
    services = config["services"]
    assert {"terminal", "terminal-origin-proxy"}.issubset(services)
    assert set(services["terminal"]["networks"]) == {"control", "ui_ingress"}
    assert set(services["terminal-origin-proxy"]["networks"]) == {"origin", "ui_ingress"}
    assert services["terminal-origin-proxy"]["image"].startswith("caddy@sha256:")
    ui_relay_config = [
        volume for volume in services["terminal-origin-proxy"]["volumes"]
        if volume.get("target") == "/etc/caddy/Caddyfile"
    ]
    assert len(ui_relay_config) == 1
    assert ui_relay_config[0]["read_only"] is True
    assert services["terminal-origin-proxy"]["ports"] == [{
        "mode": "ingress",
        "host_ip": "100.71.128.112",
        "target": 8080,
        "published": "18059",
        "protocol": "tcp",
    }]
    assert config["networks"]["ui_ingress"]["internal"] is True
    for name in ("terminal", "terminal-origin-proxy"):
        service = services[name]
        assert service["read_only"] is True
        assert service["restart"] == "unless-stopped"
        assert "ALL" in service["cap_drop"]
        assert "no-new-privileges:true" in service["security_opt"]


def test_production_compose_segments_networks_and_confines_services():
    config = _production_config()
    services = config["services"]
    runtime_socket = [
        volume for volume in services["runtime"]["volumes"]
        if volume.get("target") == "/var/run/docker.sock"
    ]
    assert len(runtime_socket) == 1
    assert runtime_socket[0]["source"] == "/run/user/980/docker.sock"
    assert all(
        not any(v.get("target") == "/var/run/docker.sock" for v in service.get("volumes", []) if isinstance(v, dict))
        for name, service in services.items() if name != "runtime"
    )
    assert {"control", "data", "workload", "origin", "ingress"}.issubset(config["networks"])
    assert set(services["gateway"]["networks"]) == {"control", "data", "ingress"}
    assert set(services["origin-proxy"]["networks"]) == {"ingress", "origin"}
    assert set(services["tailnet-origin-proxy-v2"]["networks"]) == {"ingress", "origin"}
    assert services["tailnet-origin-proxy-v2"]["image"].startswith("caddy@sha256:")
    relay_config = [
        volume for volume in services["tailnet-origin-proxy-v2"]["volumes"]
        if volume.get("target") == "/etc/caddy/Caddyfile"
    ]
    assert len(relay_config) == 1
    assert relay_config[0]["read_only"] is True
    assert services["gateway"]["environment"]["GUARD_TRUSTED_PROXIES"] == "10.250.40.2,10.250.40.3"
    assert set(services["postgres"]["networks"]) == {"data"}
    assert set(services["redis"]["networks"]) == {"data", "workload"}
    assert services["postgres"].get("user") == "70:70"
    assert services["redis"].get("user") == "999:1000"
    assert any(
        volume.get("target") == "/data"
        and (volume.get("bind") or {}).get("selinux") == "z"
        for volume in services["minio"].get("volumes", [])
        if isinstance(volume, dict)
    )
    assert any(
        str(mount).startswith("/root/.mc:")
        for mount in services["minio-init"].get("tmpfs", [])
    )
    assert "terminal" not in services

    for name in ("admin-api", "agent-api", "gateway", "meeting-api", "mcp", "origin-proxy", "runtime", "tailnet-origin-proxy-v2"):
        service = services[name]
        assert service.get("read_only") is True, name
        assert service.get("init") is False, name
        assert service.get("restart") == "unless-stopped", name
        assert "ALL" in service.get("cap_drop", []), name
        assert "no-new-privileges:true" in service.get("security_opt", []), name
        assert int(service.get("pids_limit", 0)) > 0, name
        assert int(service.get("mem_limit", 0)) > 0, name
