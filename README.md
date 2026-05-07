# VRAM Manager

Orchestrates GPU memory between servers sharing the same video card. Coordinates model unload/reload cycles so ComfyUI, LlamaSwap, Ollama, and other services can coexist without VRAM conflicts.

![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=flat-square&logo=typescript)
![MIT License](https://img.shields.io/badge/license-MIT-green?style=flat-square)
![Pi Extension](https://img.shields.io/badge/pi--extension-tool-orange?style=flat-square)

## Features

- 🧠 **Server Registry** — Register any HTTP server (ComfyUI, LlamaSwap, Ollama, etc.) with custom unload/reload endpoints
- 🖥️ **Hardware Groups** — Group servers that share the same GPU for coordinated VRAM management
- 🔐 **Reserve/Release Pattern** — `vram-manager-reserve` unloads peers and returns a reservation token; `vram-manager-release` reloads them when done
- 📊 **VRAM Querying** — Query actual VRAM usage from ComfyUI `/system_stats` to make informed decisions
- ⚡ **VRAM Conflict Detection** — Check if switching between services would cause an OOM
- 🔄 **Auto-Reload Tracking** — Track which servers were unloaded and reload them in bulk
- 💾 **Config Persistence** — Servers and groups survive pi session restarts
- 🔍 **Full Inspection** — View config, VRAM stats, pending reloads at any time

## Tools

| Tool | Description |
|------|-------------|
| `vram-manager-configure-server` | Register a server with unload/reload endpoints |
| `vram-manager-configure-group` | Group servers sharing the same GPU |
| `vram-manager-reserve` | Unload peer servers, return reservation token |
| `vram-manager-release` | Reload previously-unloaded servers |
| `vram-manager-unload` | Free VRAM on one server manually |
| `vram-manager-reload` | Reload models on one server |
| `vram-manager-reload-all` | Reload all unloaded servers at once |
| `vram-manager-system-stats` | Query VRAM usage from registered servers |
| `vram-manager-check-vram-conflict` | Check if running on a server would OOM peers |
| `vram-manager-loaded-models` | Show which servers are pending reload |
| `vram-manager-get-config` | View all registered servers and groups |
| `vram-manager-clear-config` | Reset all configuration |

## Quick Start

### 1. Register servers

```text
vram-manager-configure-server(
  serverId="comfy",
  name="ComfyUI",
  baseUrl="http://127.0.0.1:8188"
)

vram-manager-configure-server(
  serverId="llamaswap",
  name="LlamaSwap",
  baseUrl="http://127.0.0.1:8080"
)
```

### 2. Create a hardware group

```text
vram-manager-configure-group(
  groupId="gpu0",
  name="RTX 4060 Ti",
  serverIds="comfy, llamaswap",
  vramTotalGb=16
)
```

### 3. Reserve → Work → Release

```text
# Reserve VRAM (unloads llamaswap automatically)
vram-manager-reserve(serverId="comfy")
→ Returns: reservationId="vram-1712345678-abc123"

# Run your workload using other tools (e.g., comfyui-workflow)
# ... ComfyUI runs with full VRAM ...

# Release VRAM (reloads llamaswap)
vram-manager-release(reservationId="vram-1712345678-abc123")
```

### 4. Check VRAM at any time

```text
vram-manager-system-stats()

vram-manager-check-vram-conflict(serverId="comfy")
```

## Usage Examples

### Manual unload/reload

```text
vram-manager-unload(serverId="llamaswap")
# ... do work ...
vram-manager-reload(serverId="llamaswap")
```

### Reload everything at once

```text
vram-manager-reload-all()
```

### Custom endpoints

```text
vram-manager-configure-server(
  serverId="ollama",
  name="Ollama",
  baseUrl="http://127.0.0.1:11434",
  unloadEndpoint="api/gpu/free",
  reloadEndpoint="api/gpu/load"
)
```

### See what's pending reload

```text
vram-manager-loaded-models()
```

## Architecture

```
┌──────────────────────────────────────────┐
│              GPU (16 GB VRAM)            │
│  ┌──────────────┐  ┌──────────────┐      │
│  │   ComfyUI   │  │ LlamaSwap    │      │
│  │  :8188      │  │ :8080        │      │
│  └──────┬───────┘  └──────┬───────┘      │
│         │ unload/reload   │ unload/reload │
│         └──── Hardware Group ────┘       │
│              vram-manager                │
└──────────────────────────────────────────┘

Pattern: reserve → work → release
```

Config is persisted across sessions via `pi.appendEntry()`. Server and group registrations survive pi restarts.

### VRAM Lifecycle

```
LLM active (loaded in VRAM)
  → User requests image generation
  → vram-manager-reserve("comfy")
    → POST /unload to llamaswap (frees ~6.4 GB)
    → returns reservation token
  → ComfyUI workflow runs with full VRAM
  → vram-manager-release(token)
    → POST /reload to llamaswap
```

## Development

### Prerequisites

- Node.js 18+
- TypeScript 5.0+

### Setup

```bash
npm install
```

### Validate

```bash
npm run validate
```

### Test

```bash
npm test
```

### Project structure

```
vram-manager/
├── package.json
├── tsconfig.json
├── README.md
├── PLAN.md
├── skills/vram-manager/SKILL.md
└── src/extensions/vram-manager/
    ├── vram-manager.ts        # All tools and helpers
    └── test/
        └── vram-manager.test.ts  # Unit tests
```

## Resources

- [Pi extension docs](https://github.com/mariozechner/pi-coding-agent)
- [ComfyUI API](https://github.com/comfyanonymous/ComfyUI)
