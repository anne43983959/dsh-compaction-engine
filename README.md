# dsh-compaction-engine

> **PTC-only compaction checkpoint extension for DeepSeek Harness 0.2.1-rc.5 / 0.2.2-rc.1.**
> Package version **0.2.11** (engine revision **v3.11**). Contract tests: **30/30**.

This package replaces the built-in `@deepseek-ai/dsh-compaction-basic` through the local same-name alias package, `dsh-compaction-basic-alias`, which must sit next to this directory under `plugins/`. It overrides `summarize` only when the session preset is `ptc`; other presets keep the host behavior through `super.summarize`.

The engine solves one problem: after compaction, the next model must be able to distinguish **authoritative live context** from **a historical checkpoint that may be stale**. It therefore shows the summarizer the complete current context, restricts the checkpoint to the historical region, and appends deterministic sections that mark the boundary and the evidence.

## Upstream

- **Base engine.** The built-in `@deepseek-ai/dsh-compaction-basic`, shipped with DeepSeek Harness. This package does not vendor or fork it; `resolve-host.js` borrows the running instance's copy and calls `super.summarize` for non-PTC sessions.
- **Tool index.** `tool_inventory` is provided by the separate plugin [`@hrygo/dsh-ptc-tool-search`](https://github.com/hrygo/dsh-ptc-tool-search). This engine only reads that snapshot for `## Companion Status`; it does not install, load, or unload tools. Without the plugin the section records `unavailable` and the reason.
- **Host libraries.** `@deepseek-ai/dsh-tools` (`defineTool` for `memory_read`) and `@deepseek-ai/dsh-llm` (`BlockAssembler` / `LlmError` for the PTC summarization call).

The engine does not modify the host, the preset, or the profile. It hooks the compaction slot through the alias package in the companion repository [`dsh-compaction-basic-alias`](https://github.com/anne43983959/dsh-compaction-basic-alias).

## Behaviour

For PTC sessions:

1. **Full context, history-only checkpoint.** The engine calls `session.deriveMessages()` when available and falls back to the host input. When the derived messages already contain the unshadowed tail, the engine appends a `CURRENT CONTEXT — SUMMARIZE HISTORY ONLY` boundary; otherwise it appends the tail after a `RETAINED CURRENT TAIL` boundary together with a tail state block. The instruction requires the model to summarize only events up to the historical cutoff (`asOfSeq`, the maximum seq present in the host input) and forbids copying the tail into the checkpoint or into Temporal Facts.
2. **Timeline anchors and evidence pointers.** A bounded map of real user instructions, tool results of at least 2,000 characters, and recent assistant text is rendered with seq/turn/step/kind. Tool entries carry tool name, status, character count, and `read=memory_read(seq=N)`. The map is injected into the instruction as `## Timeline Anchors` and `## Evidence Pointers`.
3. **Temporal Facts.** The model writes a ninth section with latest values, `superseded` lines, `kind=state|requirement`, and a verbatim `evidence` quote. The validator checks that the cited seq exists, that the source role matches the kind (user for requirement, assistant/tool for state), that the quote is verbatim after NFKC and whitespace normalization, and that numeric, path, and quoted literals in the claim appear inside the quote. A uniquely recoverable seq is corrected; a citation that cannot be grounded is replaced with `(source=unverified)` and listed in `## Fact Audit`. The audit also requires at least one verified state fact and otherwise emits `no_verified_state_fact`.
4. **One external review pass.** After the draft, `auditDraft` checks required sections, Temporal Facts corrections, unverified facts, and state coverage. If there are findings, one constrained revision call receives the same context, the draft, and structured notes. The revision must keep the draft as the body, preserve its detail and length, apply the notes, add no review section, and perform no self-audit. A post-review audit runs; if any required section is missing, the draft is kept, otherwise the revision is accepted. `reviewPass: false` disables the pass.
5. **Deterministic suffix.** The engine appends, in order: `## Loaded Skills`, `## Reload Skills Checkpoint`, `## Companion Status`, `## Evidence Index` (conditional), `## Historical Declaration`, `## State Boundary (authoritative)` (when a tail exists), and `## Fact Audit` (when there are findings). Loaded skills come from `skill` tool calls in the session log; the reload checkpoint lists them but does not execute a reload. Companion Status is a read-only `tool_inventory` snapshot; when the tool is missing it records `unavailable` and the reason. Evidence Index lists tool results of at least 2,000 characters when the input is at least 20,000 tokens: at most 12 entries, budget `min(1500, max(600, 15% of body chars))`, cited seqs deduplicated, omitted count appended. State Boundary records `asOf`, `current`, the tail's final assistant and turn/end, and a `currentAction` line.
6. **Language follows the user.** The engine inspects the last 20 real user messages; a CJK-to-Latin ratio above 0.3 selects Chinese, otherwise English. Paths, commands, error strings, identifiers, numbers, and verbatim user quotes are preserved.
7. **Emergency pointerization only.** If the estimated input exceeds `context window - maxTokens - 5%`, the engine replaces tool results above 2,000 characters with `[[TOOL_RESULT ...]]` pointers and may feed back up to eight `READ seq=N` results. This is a fallback, not the default, and it is not quality-equivalent to full context.
8. **Hot-loaded prompt supplement.** A per-home file, `$DSH_HOME/compaction-prompt.md` or `DSH_COMPACTION_PROMPT`, is read on every summarization (mtime and size cached), capped at 12,000 characters, and appended as `## Hot-loaded Prompt Guidance`. No restart is required.

The engine also registers `memory_read(seq)` when the host does not already provide it. The tool returns one session event as canonical JSON, truncated at 12,000 characters, so the main agent can verify a pointer or a checkpoint claim instead of guessing.

## Checkpoint layout

The model owns the first nine sections; the engine owns the suffix:

```text
## Primary Request and Intent
## Key Technical Concepts
## Files and Code
## Errors and Fixes
## Pending Jobs
## Current Work
## Next Step
## Critical Context
## Temporal Facts

## Loaded Skills
## Reload Skills Checkpoint
## Companion Status
## Evidence Index
## Historical Declaration
## State Boundary (authoritative)
## Fact Audit
```

## Install

Prerequisites: DSH `0.2.1-rc.5` or `0.2.2-rc.1`, Git, and access to the launcher data directory (referred to below as `<launcher>`).

The alias imports the engine by relative path, so **both repositories must be cloned as siblings** under `<launcher>/plugins/`:

```powershell
git clone https://github.com/anne43983959/dsh-compaction-engine.git     "<launcher>/plugins/dsh-compaction-engine"
git clone https://github.com/anne43983959/dsh-compaction-basic-alias.git "<launcher>/plugins/dsh-compaction-basic-alias"
```

Do not install the engine directly, and do not use `dsh plugin add github:` for this pair: the alias resolves the engine through the sibling directory, not through the package store.

Then link-install the **alias** into the target profile:

```powershell
$launcher = '<launcher>'
$version  = '<running dsh version>'   # e.g. 0.2.2-rc.1
$home     = '<actual home directory>' # the running version and the home name can differ
$bin      = "$launcher/versions/$version/node_modules/@deepseek-ai/dsh/lib/bin.js"
$store    = "$launcher/.pnpm-store"

$env:DSH_HOME = $home
node $bin plugin --profile web add "link:$launcher/plugins/dsh-compaction-basic-alias" --config.store-dir=$store
```

Notes:

- Pass the parent store directory (`<launcher>/.pnpm-store`), not the versioned `storeDir` from `.modules.yaml`. The version segment is appended by pnpm.
- Do not add the alias or the engine to `dsh.profile.bundles`, and do not disable `compaction-basic` with a profile patch. The alias is resolved through the preset's bare package name.
- Use the actual home directory. Its name can differ from the running version (for example when a home is reused across patch releases).
- Restart the instance and create a **new PTC session**; existing agents keep their old module surface.
- Verify by running `/compact` in a PTC session and checking that the suffix sections are present.

Update both clones, then restart:

```powershell
git -C "<launcher>/plugins/dsh-compaction-engine" pull
git -C "<launcher>/plugins/dsh-compaction-basic-alias" pull
```

Rollback:

```powershell
node $bin plugin --profile web remove '@deepseek-ai/dsh-compaction-basic' --config.store-dir=$store
```

Restart afterwards. Restore the pre-install `package.json` and lockfile only if the profile changed for another reason. A controlled rollback should confirm that a new PTC summary no longer contains `## Companion Status` or `## Reload Skills Checkpoint`.

## Host module resolution

`resolve-host.js` borrows three host packages at load time; the alias shadows `@deepseek-ai/dsh-compaction-basic`, so the real base cannot be resolved through the profile. The order is:

1. `DSH_COMPACTION_BASIC_URL`, `DSH_TOOLS_URL`, `DSH_LLM_URL` (tests and emergency overrides; the LLM URL may be omitted when it can be derived from the basic package);
2. the running DSH entry point from `process.argv[1]`, resolved with `createRequire`;
3. `DSH_HOME`, matched by the home's version series;
4. the newest installed DSH under `<launcher>/versions` (tests only).

Resolution failure throws at module load; the plugin does not silently degrade to an unknown module.

## Peers

The engine and the alias declare host-provided peers, marked optional so a package manager does not fetch internal packages; the compatibility gate still evaluates the range against the running DSH version.

Range: `>=0.2.1-rc.5 <0.2.3-0` with prerelease support, so 0.2.1-rc.5 and 0.2.2-rc.1 pass while 0.2.3-rc.1 and 0.3.0 do not.

- Engine peers: `@deepseek-ai/dsh`, `@deepseek-ai/dsh-compaction-basic`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-llm`.
- Alias peers: `@deepseek-ai/dsh` and `@deepseek-ai/dsh-tools`. It cannot peer on `@deepseek-ai/dsh-compaction-basic` because that is its own package name.

## Configuration

| Key | Default | Effect |
| --- | --- | --- |
| `reviewPass` | `true` | Enables the single external review pass. `false` keeps the draft only. |
| `summarizationProvider` + `summarizationModel` | host session target | Explicit provider/model for the PTC summarization call. Both must be set. |
| `maxTokens` | host default | Passed to the LLM stream and reserved in the overflow check. |
| `DSH_COMPACTION_PROMPT` | unset | Absolute path to the hot-loaded supplement, overriding `$DSH_HOME/compaction-prompt.md`. |
| `tool_inventory` | optional | Read-only snapshot for Companion Status; absence is not an error. |

## Failure semantics

- Host module resolution failure: module load throws; no silent fallback.
- `summarizePtc` failure: the engine logs a warning and falls back to `super.summarize` (the host's base path).
- `tool_inventory` missing or failing: Companion Status records `unavailable` plus the reason; compaction continues.
- `memory_read` already registered: the engine does not replace it.
- Review pass exception: the draft is kept and a warning is logged.
- Reviewed output missing a required section: the draft is kept; the post-review findings are written to Fact Audit.
- Truncated LLM output (`max-tokens`): treated as an incomplete checkpoint and surfaced as an error.
- Evidence Index conditions unmet: no index section is appended.
- Non-PTC preset: the base engine runs; none of the custom sections appear.

## Tests

```powershell
node tests/contract.test.js
node --check index.js
node --check v3.js
node --check resolve-host.js
```

The suite contains 30 contract tests: host module resolution; skill extraction; contract content; suffix assembly; pointer format and READ; pointerization and READ resolution; legacy tool/result shape; Companion Status fallback; shared inventory success and failure; timeline anchors and evidence pointers; language detection; PTC instruction; hot prompt loading; bounded Evidence Index; full-context PTC summarize; host LLM stream call; retained-tail collection and prompt; one external review pass; adjacent-line evidence rejection; verified-state counts and prior-unverified retention; draft fallback after a section-losing review; source correction from a verbatim quote; unverified marking without an exact quote; rejection of a state fact whose only quote is a user requirement; literal-grounded acceptance; State Boundary rendering.

The workspace sandbox blocks the Node test runner's child-process spawn; run the test file directly rather than `node --test`.

## Known limitations

- Fact verification is deterministic and literal. A claim whose evidence quote covers only part of the quoted claim is marked unverified even when the underlying event exists; this is conservative but produces false negatives. Verified state coverage is frequently zero.
- There is no instruction ledger or semantic coverage audit. Missing user constraints cannot be detected mechanically.
- The reload checkpoint lists skills; it does not reload them.
- There is no automatic `requiredToolsBySkill` source. Pins come from the tool-search configuration or `tool_require`.
- Emergency pointerization is a degraded mode for overflow only.
- Loaded Skills lists every distinct skill invoked anywhere in the session, not just the relevant ones.
- Two LLM calls are made when the audit finds issues; latency increases accordingly.
- Non-PTC sessions are out of scope.

## Files

| File | Role |
| --- | --- |
| `index.js` | Engine class, summarize pipeline, audit, suffix, tool registration, host resolution wiring. |
| `v3.js` | Prompt builder, anchors, retained tail, evidence index, language detection, Temporal Facts validator, State Boundary. |
| `resolve-host.js` | Host module resolution. |
| `hot-prompt.js` | Per-home prompt supplement with mtime/size cache. |
| `LICENSE` | MIT license. |
| `tests/contract.test.js` | 30 contract tests. |

## Version history

| Revision | Main change |
| --- | --- |
| v3.0 | Full-context default, Timeline Anchors, Temporal Facts, Evidence Index, language override, emergency pointerization. |
| v3.1 | Retained-tail global view: the summarizer sees the unshadowed tail and summarizes only history. |
| v3.2 | Count-fact source correction, Fact Audit, State Boundary. |
| v3.3 | Current-context summarization instead of replaying the full shadowed history. |
| v3.4 | General fact verification with verbatim evidence and source-role checks. |
| v3.5 | Per-home hot-loaded prompt supplement. |
| v3.6 | Performance revision. |
| v3.7 | Prompt balance revision. |
| v3.8 | Original-length and self-audit audit; no post-generation readback or counting. |
| v3.9 | Self-audit definition correction; length is not a generation target. |
| v3.10 | External two-pass review: draft, engine audit, one constrained revision. |
| v3.11 | Evidence-continuation fix, verified-state audit, post-review re-audit with draft fallback, unverified re-inclusion. 30/30 tests. |

## Development record

The full plan, decision log, acceptance reports, and experiments stay outside this package in the launcher workspace under `docs/plans/dsh-compaction-engine/`. The npm package is marked `private` and is not published to npm; installation is from the cloned repository, and the companion alias repository must be cloned next to it.

## License

MIT. See [LICENSE](LICENSE).
