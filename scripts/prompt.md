## SETUP

Create a new github branch before starting any work

## ISSUES

Issues JSON is provided at start of context. Parse it to get open issues with their bodies and comments.

You've also been passed a file containing the last 10 RALPH commits (SHA, date, full message). Review these to understand what work has been done.

## TASK BREAKDOWN

Break down the issues into tasks. An issue may contain a single task (a small bugfix or visual tweak) or many, many tasks (a PRD or a large refactor).

Make each task the smallest possible unit of work. We don't want to outrun our headlights. Aim for one small change per task.

## TASK SELECTION

DO NOT work on issues which have the "not ready for RALPH" label

Pick the next task. Prioritize tasks in this order:

1. Critical bugfixes
2. Tracer bullets for new features
Tracer bullets comes from the Pragmatic Programmer. When building systems, you want to write code that gets you feedback as quickly as possible. Tracer bullets are small slices of functionality that go through all layers of the system, allowing you to test and validate your approach early. This helps in identifying potential issues and ensures that the overall architecture is sound before investing significant time in development.

TL;DR - build a tiny, end-to-end slice of the feature first, then expand it out.

3. Polish and quick wins
4. Refactors

If all tasks are complete, output COMPLETE. Then push the commits.

## EXPLORATION

Explore the repo and fill your context window with relevant information that will allow you to complete the task.

# EXECUTION

Complete the task.

If you find that the task is larger than you expected (for instance, requires a refactor first), output "HANG ON A SECOND".

Then, find a way to break it into a smaller chunk and only do that chunk (i.e. complete the smaller refactor).

# FEEDBACK LOOPS

Before committing, run the feedback loops:

- use agent-browser to test on ledger.localhost site (Administrator/admin are credentials) (/app/ledger-lab)

# COMMIT

Make a git commit. The commit message must:

1. Include task completed + PRD reference
1. Key decisions made
1. Files changed
1. Blockers or notes for next iteration

Keep it concise.

# THE ISSUE

If the task is complete, raise the PR (use gh cli) and link the github issue in the PR

If the task is not complete, leave a comment on the GitHub issue with what was done.

# FINAL RULES

* Send me a Telegram Message using `bwh_bot --help`, attach relevant screenshots related to the fix/feature.

ONLY WORK ON A SINGLE TASK.