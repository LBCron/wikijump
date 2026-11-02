#!/usr/bin/env python3
"""Check Wikidot XML-RPC client compatibility through a configured endpoint."""

from __future__ import annotations

import ipaddress
import json
import os
import sys
import xmlrpc.client
from collections.abc import Callable
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit


DOCUMENTED_METHOD_SIGNATURES = {
    "categories.select": [["array", "struct"]],
    "files.get_meta": [["struct", "struct"]],
    "files.get_one": [["struct", "struct"]],
    "files.save_one": [["struct", "struct"]],
    "files.select": [["array", "struct"]],
    "pages.get_meta": [["struct", "struct"]],
    "pages.get_one": [["struct", "struct"]],
    "pages.save_one": [["struct", "struct"]],
    "pages.select": [["array", "struct"]],
    "posts.get": [["struct", "struct"]],
    "posts.select": [["array", "struct"]],
    "tags.select": [["array", "struct"]],
    "users.get_me": [["struct"]],
}

DELETED_METHODS = (
    "page.files",
    "page.get",
    "page.save",
    "site.categories",
    "site.pages",
    "user.sites",
)

SYSTEM_METHODS = (
    "system.listMethods",
    "system.methodHelp",
    "system.methodSignature",
    "system.multicall",
)


class ConformanceError(Exception):
    """A public XML-RPC response violated the URL-swap contract."""


def is_loopback_host(host: str) -> bool:
    if host.lower().rstrip(".") == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def required_environment(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise ConformanceError(f"Missing required environment value: {name}")
    return value


def authenticated_endpoint(endpoint: str, username: str, password: str) -> str:
    parsed = urlsplit(endpoint)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ConformanceError("XMLRPC_CONFORMANCE_ENDPOINT must be an HTTP(S) URL")
    if parsed.username is not None or parsed.password is not None:
        raise ConformanceError("XMLRPC_CONFORMANCE_ENDPOINT must not contain credentials")
    if parsed.path != "/xml-rpc-api.php":
        raise ConformanceError(
            "XMLRPC_CONFORMANCE_ENDPOINT must target /xml-rpc-api.php"
        )
    if not is_loopback_host(parsed.hostname):
        raise ConformanceError(
            "XMLRPC_CONFORMANCE_ENDPOINT must target a loopback host"
        )

    host = parsed.hostname
    if ":" in host:
        host = f"[{host}]"
    if parsed.port is not None:
        host = f"{host}:{parsed.port}"
    authority = f"{quote(username, safe='')}:{quote(password, safe='')}@{host}"
    return urlunsplit((parsed.scheme, authority, parsed.path, parsed.query, ""))


def remote_method(proxy: xmlrpc.client.ServerProxy, name: str) -> Callable[..., Any]:
    method: Any = proxy
    for part in name.split("."):
        method = getattr(method, part)
    return method


def expect_fault(
    proxy: xmlrpc.client.ServerProxy,
    method_name: str,
    expected_code: int,
    *params: object,
) -> xmlrpc.client.Fault:
    try:
        remote_method(proxy, method_name)(*params)
    except xmlrpc.client.Fault as fault:
        if fault.faultCode != expected_code:
            raise ConformanceError(
                f"{method_name} returned fault {fault.faultCode}, expected {expected_code}"
            ) from None
        return fault
    raise ConformanceError(
        f"{method_name} returned successfully, expected fault {expected_code}"
    )


def check_system_methods(
    proxy: xmlrpc.client.ServerProxy, registered_methods: list[str]
) -> None:
    missing_system = sorted(set(SYSTEM_METHODS) - set(registered_methods))
    if missing_system:
        raise ConformanceError(
            f"system.listMethods omitted system methods: {', '.join(missing_system)}"
        )

    help_text = proxy.system.methodHelp("pages.select")
    if not isinstance(help_text, str) or not help_text:
        raise ConformanceError("system.methodHelp returned no help for pages.select")

    for method_name, expected_signature in DOCUMENTED_METHOD_SIGNATURES.items():
        actual_signature = proxy.system.methodSignature(method_name)
        if actual_signature != expected_signature:
            raise ConformanceError(
                f"{method_name} signature is {actual_signature!r}, expected {expected_signature!r}"
            )

    multicall_signature = proxy.system.methodSignature("system.multicall")
    expected_multicall_signature = [{"returnType": "void", "parameters": ["array"]}]
    if multicall_signature != expected_multicall_signature:
        raise ConformanceError(
            f"system.multicall signature is {multicall_signature!r}, "
            f"expected {expected_multicall_signature!r}"
        )

    multicall = xmlrpc.client.MultiCall(proxy)
    multicall.system.methodHelp("pages.select")
    multicall.system.methodSignature("pages.select")
    help_result, signature_result = list(multicall())
    if help_result != help_text:
        raise ConformanceError("system.multicall changed system.methodHelp output")
    if signature_result != DOCUMENTED_METHOD_SIGNATURES["pages.select"]:
        raise ConformanceError("system.multicall changed system.methodSignature output")


def check_documented_methods(
    proxy: xmlrpc.client.ServerProxy, registered_methods: list[str]
) -> None:
    documented_methods = sorted(DOCUMENTED_METHOD_SIGNATURES)
    missing_methods = sorted(set(documented_methods) - set(registered_methods))
    if missing_methods:
        raise ConformanceError(
            f"system.listMethods omitted documented methods: {', '.join(missing_methods)}"
        )

    for method_name in documented_methods:
        params = {"unexpected": True} if method_name == "users.get_me" else {}
        expect_fault(proxy, method_name, -32602, params)

    posts_get_fault = expect_fault(
        proxy,
        "posts.get",
        -32602,
        {"site": "url-swap-fixture", "posts": [True]},
    )
    if (
        posts_get_fault.faultString
        != "Argument posts should be a list of strings or integers"
    ):
        raise ConformanceError(
            "posts.get returned the wrong fault text for a Boolean post ID"
        )

    expect_fault(
        proxy,
        "tags.select",
        -32602,
        {
            "site": "url-swap-fixture",
            "pages": [f"page-{index}" for index in range(11)],
        },
    )


def check_absent_methods(
    proxy: xmlrpc.client.ServerProxy, registered_methods: list[str]
) -> None:
    unexpectedly_registered = sorted(set(DELETED_METHODS) & set(registered_methods))
    if unexpectedly_registered:
        raise ConformanceError(
            "system.listMethods exposed deleted methods: "
            + ", ".join(unexpectedly_registered)
        )

    for method_name in DELETED_METHODS:
        fault = expect_fault(proxy, method_name, -32601, {})
        expected_message = f"Unsupported XML-RPC method: {method_name}"
        if fault.faultString != expected_message:
            raise ConformanceError(
                f"{method_name} returned fault text {fault.faultString!r}, expected {expected_message!r}"
            )
    unknown_fault = expect_fault(proxy, "not.realMethod", -32601, {})
    if unknown_fault.faultString != "Unsupported XML-RPC method: not.realMethod":
        raise ConformanceError("the unknown method returned the wrong fault text")


def run() -> dict[str, object]:
    endpoint = required_environment("XMLRPC_CONFORMANCE_ENDPOINT")
    username = required_environment("XMLRPC_CONFORMANCE_USERNAME")
    password = required_environment("XMLRPC_CONFORMANCE_PASSWORD")
    authenticated_url = authenticated_endpoint(endpoint, username, password)
    endpoint_path = urlsplit(endpoint).path

    with xmlrpc.client.ServerProxy(
        authenticated_url,
        allow_none=True,
        use_builtin_types=True,
    ) as proxy:
        registered_methods = proxy.system.listMethods()
        if not isinstance(registered_methods, list) or not all(
            isinstance(method, str) for method in registered_methods
        ):
            raise ConformanceError("system.listMethods did not return a string array")
        check_system_methods(proxy, registered_methods)
        check_documented_methods(proxy, registered_methods)
        check_absent_methods(proxy, registered_methods)

    return {
        "deleted_methods": list(DELETED_METHODS),
        "documented_methods": sorted(DOCUMENTED_METHOD_SIGNATURES),
        "endpoint_path": endpoint_path,
        "unknown_method_fault": -32601,
    }


def main() -> int:
    try:
        report = run()
    except ConformanceError as error:
        print(f"XML-RPC URL-swap conformance failed: {error}", file=sys.stderr)
        return 1
    except Exception as error:
        print(
            f"XML-RPC URL-swap conformance failed unexpectedly: {type(error).__name__}",
            file=sys.stderr,
        )
        return 1

    print(json.dumps(report, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
