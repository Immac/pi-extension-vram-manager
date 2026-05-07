# VRAM Manager

Orchestrates GPU memory between servers sharing the same video card. Coordinates model unload/reload cycles so ComfyUI, LlamaSwap, Ollama, and other services can coexist without VRAM conflicts.

![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=flat-square&logo=typescript)
![MIT License](https://img.shields.io/badge/license-MIT-green?style=flat-square)
![Pi Extension](https://img.shields.io/badge/pi--extension-tool-orange?style=flat-square)

## Features

- 🧠 **Server Registry** — Register any HTTP server (ComfyUI, LlamaSwap, Ollama, etc.) with custom unload endpoints
- 🖥️ **Hardware Groups** — Group servers that share the same GPU for coordinated VRAM management
- ⚡ **Auto-Unload** — Before running a ComfyUI workflow, automatically unload models from peer servers in the same hardware group
- 🔄 **Manual Unload** — Explicitly unload models from any registered server at any time
- 🎯 **Workflow Execution** — Queue and poll ComfyUI workflows with automatic VRAM coordination
- 🔍 **Configuration Inspection** — View current server and group registrations

## Tools

| Tool | Description |
|------|-------------|
| `vram-manager-configure-server` | Register or update a server (id, name, baseUrl, unloadEndpoint) |
| `vram-manager-configure-group` | Create a hardware group; servers in the same group share a GPU |
| `vram-manager-run-comfyui` | Execute a ComfyUI workflow with optional auto-VRAM management |
| `vram-manager-unload` | Manually unload models from a specific server |
| `vram-manager-get-config` | Show all registered servers and hardware groups |

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

### 3. Run a workflow (auto-unloads peers)

```text
vram-manager-run-comfyui(
  workflow='{"prompt": {...}}',
  serverId="comfy",
  autoManageVram=true
)
```

This will:
1. Detect that `llamaswap` shares the `gpu0` group with `comfy`
2. POST to `llamaswap/unload` to free VRAM
3. Queue the workflow on ComfyUI
4. Poll for completion (up to 60 seconds)

## Usage Examples

### Run with auto-management disabled

```text
vram-manager-run-comfyui(
  workflow="workflow_api.json",
  serverId="comfy",
  autoManageVram=false
)
```

Skips the unload step — useful when you know there's enough free VRAM.

### Manual server unload

```text
vram-manager-unload(serverId="llamaswap")
```

Frees VRAM by calling the server's unload endpoint directly.

### Inspect configuration

```text
vram-manager-get-config()
```

Returns registered servers and hardware groups.

### Custom unload endpoint

```text
vram-manager-configure-server(
  serverId="ollama",
  name="Ollama",
  baseUrl="http://127.0.0.1:11434",
  unloadEndpoint="api/gpu/unload"
)
```

## Architecture

```
┌──────────────────────────────────────────┐
│              GPU (16 GB VRAM)            │
│  ┌──────────────┐  ┌──────────────┐      │
│  │   ComfyUI   │  │ LlamaSwap    │      │
│  │  :8188      │  │ :8080        │      │
│  └──────────────┘  └──────────────┘      │
│         ↕ unload        ↕ unload         │
│         └──── Hardware Group ────┘       │
│              vram-manager                │
└──────────────────────────────────────────┘
```

The extension keeps a runtime-only configuration (no disk persistence). Servers and groups are registered fresh each session.

### VRAM Lifecycle

```
LLM active (loaded in VRAM)
  → User requests image generation
  → vram-manager detects hardware group conflict
  → POST /unload to LlamaSwap (frees ~6.4 GB)
  → ComfyUI workflow runs with full VRAM
  → LLM reloads on next inference call
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

### Project structure

```
vram-manager/
├── package.json
├── tsconfig.json
├── README.md
└── src/extensions/vram-manager/
    └── vram-manager.ts        # Entrypoint with all tools
```

## Resources

- [Pi extension docs](https://github.com/mariozechner/pi-coding-agent)
- [ComfyUI API](https://github.com/comfyanonymous/ComfyUI)
