#!/usr/bin/env bash
# Wrapper to run AWM MCP server from the correct working directory.
# Codex (or any MCP client) can call this from any cwd.
cd "$(dirname "$0")/../.." || exit 1
exec npx tsx ./packages/awm/src/mcp.ts "$@"
