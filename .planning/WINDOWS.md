---
schema_version: 1
open_count: 0
waived_count: 0
fixed_count: 1
total_count: 1
last_updated: 2026-10-09T09:07:42.933Z
---

# Broken Windows Ledger

> Cross-phase defect register. With `workflow.windows_enforce` enabled, `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 01 | stub | web/app/page.tsx | 32 | LoginTiles onSelect is a no-op; plan 01-02 wires it to the password step | fixed |  | 2026-10-09T08:57:05.941Z | 2026-10-09T09:07:42.933Z |

````json
[
  {
    "id": 1,
    "kind": "stub",
    "phase": "01",
    "file": "web/app/page.tsx",
    "line": 32,
    "description": "LoginTiles onSelect is a no-op; plan 01-02 wires it to the password step",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-09T08:57:05.941Z",
    "resolved_at": "2026-10-09T09:07:42.933Z",
    "milestone": null
  }
]
````
