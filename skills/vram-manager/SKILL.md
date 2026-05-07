---
name: vram-manager
description: GPU VRAM coordination between services sharing the same video card. Use before switching between ComfyUI, LlamaSwap, or Ollama on the same GPU to avoid out-of-memory errors.
---

# VRAM Manager Extension Skill

## Overview

This extension provides VRAM orchestration between servers sharing a GPU. It manages the unload/reload cycle so multiple services can coexist without VRAM conflicts.

## Architecture

```
GPU (16 GB VRAM)
├── ComfyUI (:8188) — image generation
├── LlamaSwap (:8080) — LLM serving
└── vram-manager    — coordination layer

Pattern: reserve → work → release
```

## When to Use

| Situation | Action |
|-----------|--------|
| Switching from LLM to image generation | `vram-manager-reserve(serverId="comfy")` → run ComfyUI → `vram-manager-release()` |
| Before a heavy inference on a loaded GPU | `vram-manager-unload(serverId="llamaswap")` to free VRAM first |
| Checking available memory | `vram-manager-system-stats()` to see free VRAM per server |
| Diagnosing OOM errors | `vram-manager-check-vram-conflict(serverId="comfy")` |
| Recovering after a crash | `vram-manager-loaded-models()` to see pending reloads |
| Resetting for a fresh session | `vram-manager-clear-config()` |

## Workflow

### Standard Pattern

```text
1. Configure servers once per session:
   vram-manager-configure-server(serverId="comfy", name="ComfyUI", baseUrl="http://127.0.0.1:8188")
   vram-manager-configure-server(serverId="llamaswap", name="LlamaSwap", baseUrl="http://127.0.0.1:8080")

2. Group servers sharing the same GPU:
   vram-manager-configure-group(groupId="gpu0", name="RTX 4060 Ti", serverIds="comfy, llamaswap")

3. Before running a heavy workload:
   vram-manager-reserve(serverId="comfy")  → returns reservation token

4. Run your workload (ComfyUI, etc.) via other tools

5. After completion:
   vram-manager-release(reservationId="...")  → reloads unloaded peers
```

### Direct Commands

```text
# Free VRAM manually
vram-manager-unload(serverId="llamaswap")

# Reload a specific server
vram-manager-reload(serverId="llamaswap")

# Reload everything
vram-manager-reload-all()
```

## Configuration Reference

### Server Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `serverId` | yes | — | Unique ID (e.g., "comfy", "llamaswap") |
| `name` | yes | — | Human-readable name |
| `baseUrl` | yes | — | Server base URL |
| `unloadEndpoint` | no | `/unload` | POST endpoint to free VRAM |
| `reloadEndpoint` | no | `/reload` | POST endpoint to reload models |

### Group Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `groupId` | yes | — | Unique ID |
| `name` | yes | — | Human-readable name |
| `serverIds` | yes | — | Comma-separated server IDs sharing the GPU |
| `vramTotalGb` | no | — | Total VRAM for info display |

## Available Tools

| Tool | Purpose |
|------|---------|
| `vram-manager-configure-server` | Register a server |
| `vram-manager-configure-group` | Group servers sharing the same GPU |
| `vram-manager-reserve` | Unload peers, return reservation token |
| `vram-manager-release` | Reload peers from reservation |
| `vram-manager-unload` | Free VRAM on one server |
| `vram-manager-reload` | Reload models on one server |
| `vram-manager-reload-all` | Reload all unloaded servers |
| `vram-manager-system-stats` | Query VRAM usage |
| `vram-manager-check-vram-conflict` | Check if switching would OOM |
| `vram-manager-loaded-models` | Show pending reloads |
| `vram-manager-get-config` | View current config |
| `vram-manager-clear-config` | Reset all config |
