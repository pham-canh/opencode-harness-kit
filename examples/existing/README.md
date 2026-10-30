# Example: an existing repository

What `spec init --template existing` leaves behind for the Python fixture in
`eval/fixtures/spec/python-app/` — four files, no domain docs, and no source
file touched.

```
.space/charter.md               Goal, Scope, Constraints, Ready (no Requirements: the code is the spec)
.space/architecture/overview.md the layers as they are
.space/plan/milestones.md       the change you intend to make
.space/tasks.md                 hiện trạng first, then the change
```

`trace_required` is false here: the code is the design, so tasks carry no
`[REQ-NNN]` tag and a plan is not refused for lacking one. The first task is
the one that makes the test command run, because `spec decompose` will not
accept a plan whose tasks cannot prove themselves.
