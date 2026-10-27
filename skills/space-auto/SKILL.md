---
name: space-auto
description: Run the OpenCode harness loop to a verified result without human input.
---

# space-auto

Use this skill when the user asks to complete a task end-to-end without
interruption. It drives plan -> build -> verify -> review -> finish, retries
on failure within a budget, and stops when verify passes or the budget runs out.

Invoke with `oc-harness auto "<goal>"` or `oc-harness goal "<request>"`.
