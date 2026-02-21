## General

- Use lowercase SQL reserved words for readability (e.g., `select * from Table`)
- Don't use inline `import()` unless dynamically loading
- Don't create summary documents; update existing documentation
- Stay DRY; If you see code that isn't DRY, refactor and abstract.
- No lengthy summaries
- Don't worry about backwards compatibility yet.
- Use yarn
- No half-baked janky parsers; use a full-fledged parser or better, brainstorm with the dev for another way
- .editorconfig contains formatting (tabs for code)

## Tasks

- If the user mentions tasks (e.g. work task...), read tasks/AGENTS.md to know what to do

## Launch process tool (if under PowerShell)

The `launch-process` tool wraps commands in `powershell -Command ...`, which strips inner quotes and parses parentheses as subexpressions. This makes `git commit -m "task(review): ..."` impossible — no escaping strategy works.
Use a file or pipe based pattern as a work-around.  e.g. `git commit -F .git/COMMIT_EDITMSG`

----

For all but the most trivial asks, start with packages/quereus/README.md to come up to speed; read and maintain this and other docs (in docs/) along with the work. 
