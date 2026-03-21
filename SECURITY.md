# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.4.x   | Yes       |
| < 0.4   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it privately.

**Do not open a public issue.**

Email: Robert@completeideas.com

We will respond within 48 hours and work with you to resolve the issue before any public disclosure.

## Security Design

- AWM runs entirely locally — no data leaves your machine
- The hook sidecar binds to 127.0.0.1 only (localhost)
- Bearer token auth protects the hook endpoint
- No external API calls for memory operations
- All ML models run locally via ONNX
