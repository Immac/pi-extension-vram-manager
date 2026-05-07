# VRAM Manager — Improvement Plan

**Goal**: Evolve vram-manager from a lightweight prototype into a general VRAM coordination layer that orchestrates memory between any services sharing a GPU.

## Checkpoints

| # | Phase | Effort | Impact | Checkpoint |
|---|-------|--------|--------|------------|
| 1 | Config persistence | Low | High | `checkpoint-01-config-persistence` |
| 2 | VRAM querying | Medium | High | `checkpoint-02-vram-querying` |
| 3 | Auto-reload & loaded-models tracking | Medium | High | `checkpoint-03-reload-tracking` |
| 4 | Refactor to general VRAM layer | Medium | High | `checkpoint-04-general-layer` |
| 5 | Type safety cleanup | Low | Medium | `checkpoint-05-type-safety` |
| 6 | Remove duplicate run-comfyui | Low | Medium | `checkpoint-06-remove-duplicate` |
| 7 | Add tests | Medium | High | `checkpoint-07-tests` |
| 8 | SKILL.md | Low | High | `checkpoint-08-skill` |
| 9 | Final cleanup & documentation update | Low | Medium | `checkpoint-09-cleanup` |

Each phase ends with a git tag + test pass before moving to the next.

---

## Phase 1 — Config Persistence (Low effort, High impact)

**Problem**: Config resets every pi session. Servers/groups must be re-registered on each launch.

**Implementation**:
- Add `ConfigStore` class wrapping `pi.appendEntry()`/`getEntry()` for persistence
- Load persisted config on extension init, fall back to empty config
- Auto-save on every mutation (add/update server, group)
- Add `vram-manager-clear-config` tool to reset
- Add `vram-manager-get-config-raw` to see full persistent state

**Test**: Register servers, persist, reload session — config survives.

**Checkpoint tag**: `checkpoint-01-config-persistence`

---

## Phase 2 — VRAM Querying (Medium effort, High impact)

**Problem**: Extension doesn't actually check VRAM. Unload decisions are blind.

**Implementation**:
- Add `getVramUsage()` helper that queries:
  - ComfyUI `/system_stats` for CUDA devices
  - General `/nvidia-smi` via subprocess as fallback
- Add `vram-manager-system-stats` tool returning VRAM free/total per device
- Add `vram-manager-check-vram-conflict` tool:
  - Takes target server ID
  - Checks if other servers in group have models loaded
  - Reports free VRAM vs estimated need
- Make `vram-manager-unload` return VRAM freed (when available)

**Test**: Call system-stats tool → returns VRAM info. Call check-conflict → returns conflict/no-conflict.

**Checkpoint tag**: `checkpoint-02-vram-querying`

---

## Phase 3 — Auto-Reload & Loaded-Models Tracking (Medium effort, High impact)

**Problem**: Models are unloaded but never automatically reloaded. No tracking of what's loaded.

**Implementation**:
- Add in-memory `UnloadRegistry` tracking which servers were unloaded by the manager
- Add load endpoint support (`reloadEndpoint` on Server config)
- Add `vram-manager-reload` tool to trigger model reload on a server
- Add `vram-manager-reload-all` tool to reload all previously-unloaded servers
- Add `vram-manager-loaded-models` tool returning tracked state
- Tools return a `reservationId` that can be passed to reload

**Test**: Unload server → verify unload works → reload → verify reload task started.

**Checkpoint tag**: `checkpoint-03-reload-tracking`

---

## Phase 4 — Refactor to General VRAM Layer (Medium effort, High impact)

**Problem**: The extension is tightly coupled to ComfyUI concepts (workflow execution, polling).

**Implementation**:
- Remove ComfyUI-specific logic from core tools
- Add `vram-manager-reserve` tool:
  - Takes target server ID
  - Auto-unloads peers in same hardware group
  - Returns reservation token
- Add `vram-manager-release` tool:
  - Takes reservation token
  - Reloads previously-unloaded servers
- Keep `vram-manager-configure-server` and `vram-manager-configure-group` as-is (they're already general)
- The agent workflow becomes:
  1. `vram-manager-reserve` → get token
  2. Run your actual workload (ComfyUI, LLM inference, etc.)
  3. `vram-manager-release` → restore peers

**Test**: Reserve → verify peers unloaded → release → verify reload triggered.

**Checkpoint tag**: `checkpoint-04-general-layer`

---

## Phase 5 — Type Safety Cleanup (Low effort, Medium impact)

**Problem**: `as any` casts throughout the code bypass TypeScript's type system.

**Implementation**:
- Define proper return types: `ToolResponse<T>` = `{ content: ..., details: T }`
- Replace all `as any` casts with typed return objects
- Add proper error handling types
- Remove unused imports

**Test**: `npm run validate` passes cleanly with strict mode.

**Checkpoint tag**: `checkpoint-05-type-safety`

---

## Phase 6 — Remove Duplicate run-comfyui (Low effort, Medium impact)

**Problem**: `vram-manager-run-comfyui` hand-rolls ComfyUI API calls that duplicate `comfyui-workflow`.

**Implementation**:
- Remove `vram-manager-run-comfyui` tool entirely
- Its functionality is replaced by the general flow: `reserve` → (agent uses comfyui-workflow tools) → `release`
- Keep a note in README and SKILL.md explaining the pattern

**Test**: Extension loads without errors, no references to run-comfyui remain.

**Checkpoint tag**: `checkpoint-06-remove-duplicate`

---

## Phase 7 — Add Tests (Medium effort, High impact)

**Problem**: No test coverage.

**Implementation**:
- Add `vitest` or use Node's built-in test runner
- Unit tests for helpers: `getOtherServers`, `callServer`, `UnloadRegistry`
- Smoke tests for each tool with mocked HTTP
- Test persistence round-trip
- Test: `npm test` passes

**Checkpoint tag**: `checkpoint-07-tests`

---

## Phase 8 — SKILL.md (Low effort, High impact)

**Problem**: No agent guidance on when/how to use the extension.

**Implementation**:
- Write `SKILL.md` for the vram-manager skill
- Teach patterns:
  - Reserve → work → release
  - When to auto-manage vs. manual
  - Configuring servers and groups
- Place in `~/.pi-extensions/vram-manager/skills/vram-manager/SKILL.md`

**Test**: Skill loads and the agent can follow its guidance.

**Checkpoint tag**: `checkpoint-08-skill`

---

## Phase 9 — Final Cleanup & Documentation Update (Low effort, Medium impact)

**Problem**: README may be stale after all changes.

**Implementation**:
- Update README.md with new tool set and usage patterns
- Remove stale references to removed tools
- Verify `npm run validate` and `npm test` both green
- Final commit + tag

**Checkpoint tag**: `checkpoint-09-cleanup`

---

## How to Use Promises

During implementation, use `promise-create` for:
- Running `npm test` in background while continuing to edit
- Running `tsc --noEmit` validation alongside edits
- Running parallel test suites

Example:
```
promise-create command="npm test" name="test-suite"
# continue editing while tests run
promise-await(promiseId)  # check results when needed
```
