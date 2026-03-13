# Custom Dockerfile Extension Support — Design Spec

**Date:** 2026-03-11
**Status:** Draft
**Upstream:** cr-crawl `docs/superpowers/specs/2026-03-11-tiered-crawl-methodology-design.md`

## Purpose

Allow projects to extend the base agents-cli sandbox image with project-specific system dependencies. The first consumer is cr-crawl's static analysis pipeline, which needs Lighthouse, whois, and dnsutils — tools not in the base image.

## Motivation

The base agents-cli image is deliberately minimal: Claude Code, agent-browser, Bun, Node, and basic shell utilities. Different projects need different tools:

- **cr-crawl** needs `lighthouse`, `whois`, `dnsutils` for automated site audits
- Future projects may need language runtimes, database clients, or domain-specific CLIs

Rather than bloating the base image, projects provide a Dockerfile that layers on top.

## CLI Changes

### `--dockerfile` flag on `launch`

```bash
agents-cli launch . \
  --dockerfile ./Dockerfile \
  --output ./data/output \
  --claude-md ./prompts/crawl-agent.md \
  --prompt "..."
```

| Flag | Type | Default | Description |
|---|---|---|---|
| `--dockerfile <path>` | string | none | Path to a Dockerfile that `FROM`s the base image |

### `build` subcommand (new)

Pre-compiles the extended image without launching an agent. Useful for CI and first-run setup.

```bash
agents-cli build [path] [options]
  [path]                Codebase root (default: cwd)
  --dockerfile <path>   Path to project Dockerfile
```

Outputs the built image name on success. No-ops if the image is already cached and inputs haven't changed.

### Updated CLI help

```
agents-cli launch [path] [options]
  [path]                Codebase to mount read-only (default: cwd)
  --output <path>       Writable output dir (default: ./agent-output)
  --claude-md <path>    CLAUDE.md override — appended after system header
  --prompt <text>       Research prompt (omit for interactive)
  --model <model>       Model override (default from config)
  --dockerfile <path>   Dockerfile extending base image

agents-cli build [path] [options]
  [path]                Codebase root (default: cwd)
  --dockerfile <path>   Dockerfile extending base image
```

## Build Mechanism

1. agents-cli builds (or locates) its base image as usual → `agents-cli-sandbox:latest`
2. If `--dockerfile` is provided:
   a. Read the user's Dockerfile
   b. Compute a content hash of: base image ID + Dockerfile contents
   c. Check if a cached image `agents-cli-ext:<hash>` exists
   d. If not cached, build: `docker build -f <dockerfile> -t agents-cli-ext:<hash> .`
   e. Launch the agent container from `agents-cli-ext:<hash>` instead of the base image
3. If `--dockerfile` is not provided, behavior is unchanged — uses the base image

### Caching

The extended image tag includes a content hash so rebuilds only happen when inputs change:

```
agents-cli-ext:<sha256 of (base_image_id + dockerfile_contents)>
```

This means:
- Changing the Dockerfile triggers a rebuild
- Rebuilding the base image triggers a rebuild of all extensions
- Multiple projects can each have their own cached extension image

### Dockerfile Constraints

The user's Dockerfile **must** use the base image as its `FROM`:

```dockerfile
FROM agents-cli-sandbox:latest
```

agents-cli validates this before building. If the `FROM` line doesn't reference the base image, the build fails with a clear error message.

## Example: cr-crawl Dockerfile

```dockerfile
FROM agents-cli-sandbox:latest
RUN apt-get update && apt-get install -y --no-install-recommends \
    whois \
    dnsutils \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g lighthouse
```

## Future Direction

- **Lean base image:** Consider removing `agent-browser` from the base and offering it as an optional layer. Projects that don't need a browser get a smaller, faster image.
- **Base variants:** Different base images for different use cases (e.g., `agents-cli-sandbox:browser`, `agents-cli-sandbox:minimal`).
- **Compose-style multi-container:** For projects needing sidecar services (databases, APIs), support a compose file alongside the Dockerfile.

## Open Questions

- **Build context:** Currently the build context is the codebase root (`.`). Should this be configurable, or is the codebase root always correct? For now, use codebase root — the Dockerfile shouldn't need to COPY project files into the image (they're mounted read-only at runtime).
- **Image cleanup:** `agents-cli clean` should offer to remove cached extension images. Add `--images` flag: `agents-cli clean --images` removes extension images, `agents-cli clean --all` removes containers + images.
