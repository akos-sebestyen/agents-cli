# agents-cli

CLI for launching sandboxed Claude research agents in Docker containers.

## Prerequisites

- [Bun](https://bun.sh) (v1.0+)
- [Docker](https://docs.docker.com/get-docker/)
- `ANTHROPIC_API_KEY` environment variable set

## Install

```bash
bun install
./install.sh
```

This compiles a standalone binary to `~/.local/bin/agents-cli`. Make sure `~/.local/bin` is in your `PATH`.

## Run from source

```bash
bun src/cli.ts <command>
```

## Usage

```bash
# Launch an agent against the current directory
agents-cli launch .

# Launch with a prompt
agents-cli launch . -p "Analyze the authentication flow"

# Launch with a custom output directory
agents-cli launch . --output ./results

# Launch with a CLAUDE.md override
agents-cli launch . --claude-md ./custom-claude.md

# List running agents
agents-cli list

# View agent logs
agents-cli logs <container>

# Resume an agent session
agents-cli resume <container>

# Open the dashboard
agents-cli dashboard

# Stop and remove managed containers
agents-cli clean

# View/set config
agents-cli config
```

## Config

Configuration is stored at `~/.agents-cli/config.json`.
