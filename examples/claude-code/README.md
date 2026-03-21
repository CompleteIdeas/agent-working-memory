# Claude Code Configuration Examples

These are example `.mcp.json` configurations for Claude Code.

## Files

- **`global-setup.json`** — Standard global setup. Place at `~/.mcp.json` or use `awm setup --global`.
- **`per-project.json`** — Project-specific setup with custom agent ID and local database.
- **`multi-pool.json`** — Shows how to isolate memory pools by placing different `.mcp.json` files in parent folders.

## Usage

Copy the relevant JSON into your `.mcp.json` file:

```bash
# Global (all projects share memory)
cp global-setup.json ~/.mcp.json

# Per-project (isolated memory)
cp per-project.json /path/to/your/project/.mcp.json
```

Or use the CLI which handles this automatically:

```bash
awm setup --global          # Global setup
awm setup                   # Per-project setup
```
