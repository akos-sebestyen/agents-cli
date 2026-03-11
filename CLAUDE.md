
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install`
- Use `bun run <script>` instead of `npm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## Project

CLI tool for launching sandboxed Claude research agents in Docker. Compiles to a single binary via `bun build --compile`.

## Key Architecture

- Docker assets (Dockerfile, shell scripts, proxy addon) are embedded as string imports via `with { type: "text" }`
- Docker compose YAML is generated at runtime (no static compose file)
- Containers are tracked via Docker labels (`com.agents-cli.managed`)
- Config lives at `~/.agents-cli/config.json`

## Build & Install

```bash
./install.sh          # builds binary to ~/.local/bin/agents-cli
bun src/cli.ts        # run from source during development
```

## Testing

```bash
bun test              # unit tests
agents-cli launch .   # smoke test (launches agent against cwd)
```
