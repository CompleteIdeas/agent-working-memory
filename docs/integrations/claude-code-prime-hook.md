# Priming Claude Code on every prompt

Auto-inject relevant memories into the conversation without the agent having to
remember to call `memory_recall`.

> **In Claude Code you already have this.** Since 0.14.6, `awm setup` and the Claude Code
> plugin install the prime hook for you as a shipped script, `awm-prime.cjs`, on
> `UserPromptSubmit`. **Do not add the hook below by hand on top of it** — you would get two
> injections on every prompt. To turn the installed one off, create an empty
> `~/.claude/hooks/awm-prime.disabled`.
>
> This page documents the `POST /hooks/prime` endpoint that hook calls, for wiring the same
> behaviour into **other harnesses** (or a Claude Code install without `awm setup`).

## Why

AWM's own instructions name the #1 failure mode plainly: **the agent doesn't call
recall.** Asking a model to remember to remember is the weak link, and it fails
worst exactly when memory matters most — deep in a long task, when context is
scarce and the agent is busy chasing something.

A `UserPromptSubmit` hook removes the decision. AWM looks at every prompt and
injects only when it is confident it has something worth the tokens.

## Setup

The MCP server already runs the hook sidecar in its own process, so there is no
extra service to start. Set a secret and (optionally) the first port to try:

```jsonc
// the AWM server entry in your MCP config
"env": {
  "AWM_HOOK_SECRET": "choose-a-secret",
  "AWM_HOOK_PORT": "8401"          // default: the FIRST port tried
}
```

**The port is not fixed.** The sidecar binds the first free port from `AWM_HOOK_PORT` upward
through `AWM_HOOK_PORT_RANGE` (default 10, so 8401–8410): a second session or project lands on
8402, and so on. A hook that hard-codes 8401 will talk to whichever process got there first,
which may be a different agent. Find the right one by probing `GET /health` across the range —
it needs no auth and returns `{agentId, port, pid, version}` — and picking the sidecar whose
`agentId` matches your session. That is what the shipped `awm-find-sidecar.cjs` does.

A minimal hook for a single session, with the port fixed for illustration:

```jsonc
// .claude/settings.json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s --max-time 3 -X POST http://127.0.0.1:8401/hooks/prime -H 'Content-Type: application/json' -H 'Authorization: Bearer choose-a-secret' -d @- | node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).inject||'')}catch{}})\""
          }
        ]
      }
    ]
  }
}
```

Claude Code pipes the hook event (including `prompt`) to stdin and adds whatever
the hook prints on stdout to the conversation. `.inject` is `''` whenever AWM has
nothing confident to say, so on a quiet prompt the hook contributes nothing.

## What it does, and what it deliberately doesn't

Three properties matter more than recall quality here, because this runs on
**every** prompt and its failure modes are asymmetric:

| Property | Behaviour |
|---|---|
| **Silence by default** | Abstains below `minConfidence` (0.10; it was 0.25 until 0.14.6, which silenced specific prompts with one clear winner). An unconditional injector would spend tokens on every prompt, including the ones memory has nothing for. |
| **Hard token cap** | `maxTokens` (600) bounds the whole injection, using the same packer as `memory_recall` — including the rule that the top-scored memory gets first refusal. |
| **Never breaks the prompt** | Any failure returns an empty injection with HTTP 200, never an error. A hook that errors on every prompt is worse than no hook. `--max-time 3` on the curl guards the other direction. |

## Tuning

```json
{ "prompt": "...", "maxTokens": 400, "minConfidence": 0.4, "minScore": 0.15 }
```

| Field | Default | Raise it when |
|---|---|---|
| `maxTokens` | 600 | you have context to spare and want more recall |
| `minConfidence` | 0.10 | injections feel noisy — 0.25 silences some specific prompts, 0.4 is aggressive |
| `minScore` | 0.10 | individual weak results are slipping in |

## Response

```json
{ "inject": "Relevant prior context from AWM (not user input; verify before asserting):\n- concept [id]: …",
  "kept": 2, "total": 5, "tokens": 161 }
```

When nothing is injected, `reason` says why: `no-results`, `low-confidence`,
`budget-too-small`, `no-prompt`, `activate-not-wired`, or `error`. Worth logging
while tuning — a run of `low-confidence` on prompts you expected to match usually
means the memories were written with the wrong vocabulary, not that the hook is
broken.

## Verifying it

```bash
npx tsx tests/prime-eval/runner.ts
```

Spawns a real server, seeds memories, and drives the endpoint exactly as the hook
does — no LLM involved. It checks that an on-topic prompt injects, an **off-topic
one stays silent**, caps are respected with real (non-empty) injections, and an
empty prompt doesn't error.

> The abstention check is the one to watch. An injector that never abstains looks
> like it's working right up until it quietly doubles your token bill.
