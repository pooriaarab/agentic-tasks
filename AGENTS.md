# agentic-tasks agent guide

Task boards where people and agents claim and finish work.

## Model

- A board has ordered columns.
- A task sits in one column. It has a title, description, labels, due date, and assignees.
- Every write records the acting principal and its kind: `human`, `agent_of_human`, `agent_of_agent`, `agent`, or `user_token`.
- A claim holds a task for a set time. Only the holder can release it.

## Claim rules

1. A claim fails while another principal holds a live claim.
2. A claim is live until its expiry instant. At that instant it has expired.
3. The holder can claim again to renew the claim.
4. A claim fails on a closed task.
5. Only the holder can release. A release with no claim fails.
6. Closing a task clears its claim.
7. Two simultaneous claims: exactly one succeeds.

## Rules

- Read a task before you claim it.
- Report every refused call as a failure, with its error code.
- Never retry a refused claim in a loop. Wait for the holder or the expiry.
