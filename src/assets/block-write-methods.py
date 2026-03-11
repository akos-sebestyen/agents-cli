"""mitmproxy addon: block write HTTP methods except to whitelisted hosts."""

from mitmproxy import http, ctx

ALLOWED_METHODS = {"GET", "HEAD", "OPTIONS", "CONNECT"}

WRITE_ALLOWED_HOSTS = {
    "api.anthropic.com",
    "api.claude.ai",
    "auth.anthropic.com",
    "statsig.anthropic.com",
    "sentry.io",
}


class BlockWriteMethods:
    def request(self, flow: http.HTTPFlow) -> None:
        if flow.request.method in ALLOWED_METHODS:
            return
        if any(flow.request.host.endswith(h) for h in WRITE_ALLOWED_HOSTS):
            return
        ctx.log.warn(f"BLOCKED {flow.request.method} {flow.request.url}")
        flow.response = http.Response.make(
            403, b"Blocked by sandbox: write methods not allowed"
        )


addons = [BlockWriteMethods()]
