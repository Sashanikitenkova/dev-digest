# Telemetry — where the numbers come from

Every recipe here was run against a real session before being written down.
`jq` is at `/usr/bin/jq`. Paths assume:

```
SLUG=~/.claude/projects/-Users-olexandra-Documents-dev-digest
SID=<session-id>            # from the scratchpad path, not from mtime
SESSION=$SLUG/$SID.jsonl
SUBAGENTS=$SLUG/$SID/subagents
```

**Never `cat` any of these files.** The main transcript runs to megabytes and a
subagent transcript can exceed 5 MB. Use aggregates only.

## What each mode can and cannot see

| | in-context | deep |
|---|---|---|
| Agent roster, descriptions, launch order | yes | yes |
| Per-agent tokens / tool calls / duration | yes — notification metric | yes — transcript metric |
| Session totals split by token class | **no** | yes |
| Model and effort per request | **no** | yes |
| Files read by more than one agent | **no** | yes |
| Turn wall-clock | **no** | yes |
| Agent reports, misses, contradictions | yes — already in context | needs re-reading |

In-context is the stronger mode for judgement and the weaker one for
measurement. Deep inverts that. Say which one ran.

## The two token definitions

They are not interchangeable and they disagree by more than an order of
magnitude:

| Definition | Where | Measured example |
|---|---|---|
| `<subagent_tokens>` from the task notification | in-context | 144,170 |
| Deduped sum of the agent's own transcript | deep | 2,548,508 |

Same agent, same run. The notification excludes cache reads. Pick one per
report, label the column, and never put both in one table.

## Session totals — dedup is mandatory

One API response is written as **several** `assistant` records, each carrying an
identical full copy of `usage`. Summing them naively overcounts by ~2.4x
(measured: 10,485,186 naive vs 4,311,841 deduped). Always
`group_by(.requestId)` and take the first of each group.

```bash
jq -s '[.[]|select(.type=="assistant" and .message.usage)]
  | group_by(.requestId) | map(.[0].message.usage)
  | {requests: length,
     input:          (map(.input_tokens)                | add),
     output:         (map(.output_tokens)               | add),
     cache_read:     (map(.cache_read_input_tokens)     | add),
     cache_creation: (map(.cache_creation_input_tokens) | add),
     total: (map(.input_tokens + .output_tokens
                 + .cache_read_input_tokens + .cache_creation_input_tokens) | add)}' "$SESSION"
```

Report the split, not just `total`. Cache reads are typically most of it — on
the measured session, ~3.5M of 4.31M — so a lone "tokens spent" figure tells
the reader almost nothing.

## Agent roster — from metadata, not prose

Each subagent has a sidecar next to its transcript:

```bash
for m in "$SUBAGENTS"/*.meta.json; do
  jq -c --arg id "$(basename "$m" .meta.json | sed 's/^agent-//')" \
    '{id: $id, agentType, description, toolUseId, spawnDepth}' "$m"
done
```

`{agentType, description, toolUseId, spawnDepth}`. `toolUseId` joins to the
parent's `Agent` tool_use, so launch order needs no prose parsing — and this
covers agents still running, which notifications do not.

## Launch order and parallel batches

```bash
jq -r 'select(.type=="assistant") | .timestamp as $t | .message.content[]?
  | select(.type=="tool_use" and (.name=="Agent" or .name=="Task"))
  | [$t, .id, .input.subagent_type, .input.description] | @tsv' "$SESSION"
```

Match **both** names: the tool is `Agent` in Claude Code 2.1.246 and was `Task`
earlier. File order is launch order. Spawns whose timestamps fall within a few
seconds of each other were dispatched in one batch — that is your parallelism
signal.

## Per-subagent totals (deep definition)

```bash
for f in "$SUBAGENTS"/agent-*.jsonl; do
  at=$(jq -r .agentType "${f%.jsonl}.meta.json")
  jq -s -r --arg a "$at" '[.[]|select(.type=="assistant" and .message.usage)]
    | group_by(.requestId)
    | {agent: $a, requests: length,
       tokens: (map(.[0].message.usage
                    | .input_tokens + .output_tokens
                      + .cache_read_input_tokens + .cache_creation_input_tokens) | add)}
    | @json' "$f"
done
```

Same dedup rule applies inside a subagent transcript.

## Notification metric (in-context definition)

The `<usage>` block is persisted in the transcript too, inside the notification
text — on `queue-operation` records, which carry their own timestamp:

```bash
jq -r 'select(.type=="queue-operation" and ((.content // "")|test("subagent_tokens")))
  | [.timestamp,
     (.content|capture("<task-id>(?<v>[^<]+)").v),
     (.content|capture("<subagent_tokens>(?<v>[0-9]+)").v),
     (.content|capture("<tool_uses>(?<v>[0-9]+)").v),
     (.content|capture("<duration_ms>(?<v>[0-9]+)").v)] | @tsv' "$SESSION"
```

Two traps: **notifications repeat**, so dedupe by task-id; and an agent still
running has none, so fall back to the sidecar roster.

Note the parentheses around each `capture(...)` — inside `[...]`, `|` binds
looser than `,`, and the version without them silently produces wrong output
rather than an error.

## Tool calls and errors per agent

```bash
for f in "$SUBAGENTS"/agent-*.jsonl; do
  at=$(jq -r .agentType "${f%.jsonl}.meta.json")
  calls=$(jq '[.message.content[]?|select(.type=="tool_use")]|length' "$f" | paste -sd+ - | bc)
  errs=$(jq  '[.message.content[]?|select(.type=="tool_result" and .is_error==true)]|length' "$f" | paste -sd+ - | bc)
  echo "$at calls=$calls errors=$errs"
done
```

`is_error` is `false` or absent on a success, so `== true` is the correct test.
Zero errors is a normal, truthful result — do not read it as a broken recipe.

## Files touched by more than one agent

The duplication signal. **Read/Grep/Glob alone is not enough**: agents in this
repo do most of their reading through `Bash` (`cat`, `sed`, `grep`). On the
measured session that was 29 Bash calls against 17 Read calls for one agent, so
the structured-tool-only version found no overlap at all while the combined
version found plenty.

```bash
for f in "$SUBAGENTS"/agent-*.jsonl; do
  id=$(basename "$f" .jsonl); id=${id#agent-}
  { jq -r 'select(.type=="assistant")|.message.content[]?
      |select(.type=="tool_use" and (.name=="Read" or .name=="Grep" or .name=="Glob"))
      |(.input.file_path // .input.path // "")' "$f"
    jq -r 'select(.type=="assistant")|.message.content[]?
      |select(.type=="tool_use" and .name=="Bash")|.input.command' "$f" \
      | grep -oE '[A-Za-z0-9_./-]+\.(ts|tsx|md|json|sql)'
  } | sed "s#^$PWD/##" | grep -v '^$' | sort -u | sed "s#^#$id\t#"
done | sort -u | cut -f2 | sort | uniq -c | awk '$1>1' | sort -rn
```

The Bash half is a **heuristic** — it greps paths out of command strings and
will miss unusual quoting and catch the occasional non-path. Label it as such
in the report. The structured half is exact; quote them separately when the
distinction matters.

Real output from the measured session: `CLAUDE.md` read by 4 agents,
`reviewer-core/src/prompt.ts` by 3. That is the re-derivation cost, in files.

## Turn wall-clock

```bash
jq -r 'select(.type=="system" and .subtype=="turn_duration")
  | [.timestamp, .durationMs, .messageCount] | @tsv' "$SESSION"
```

Session span is the first and last `.timestamp` across all records. There is no
single stored duration for the whole session.

## What is not on disk

- **No cost or dollar figures anywhere.** Not in the transcripts, not in
  `~/.claude`. `~/.claude/telemetry/` exists and is empty; there is no usage
  database. This is why the retro reports tokens and not money.
- **No pre-computed session aggregate** — it must be summed with dedup.
- Subagent `duration_ms` and `tool_uses` exist only in notification text, and
  only after the agent has reported. For an in-flight agent, count `tool_use`
  blocks and difference timestamps instead.
- Sessions from Claude Code 2.1.241 and earlier hold **no** subagent records at
  all. That is an empty result, not a failure.
