# Brain

Prentice keeps the speed of coding agents while putting understanding, real debugging, and engineering judgment back into the development loop.

Update this file when a product decision changes what Prentice is trying to become. Do not update it for an implementation detail.

## Core loop

```text
BUILD
→ UNDERSTAND
→ EXPLAIN-BACK
→ CONTINUE BUILDING
→ DEBUG REAL PROBLEMS
→ LEARN
→ BUILD AGAIN
```

Build, understand, explain-back, and return to the agent are in the workspace now. Debug runs only when the current session recorded a real failure. The "learn" step is that explain-back and debug, for this task. A memory that carries learning across tasks is not built.

## What Prentice is

Prentice is a local development layer around Codex, Claude Code, and Cursor. It opens one git repository, routes a task, forwards the original prompt, shows the session, and explains the diff that git recorded.

The workspace is the product surface: explorer, search, source control, the current task's command lines, the editor, the agent, and the Prentice learning panel stay on one screen. Learning is a panel in that workspace, not a separate application.

The fixture provider exists so the loop can be proven without a paid model call. It is labeled as a demo.

## What Prentice is not

- Not another coding agent. The connected tool writes the code. Prentice routes, watches, and explains.
- Not a generic chatbot. Questions come from the task's evidence.
- Not a Cursor clone. The editor is a read-only view of the repo and the diff.
- Not an RAG-first product. Nothing is embedded or retrieved from a knowledge base.
- Not an artificial debugging platform. Debug does not invent a bug, a root cause, or a fix.
- Not a hosted multi-user product, and not a queue or cache platform. Redis and BullMQ are not part of the design that shipped.

## Principles

- The user chooses the route, consents before a run, and chooses how much debug help to reveal.
- Observed facts, agent statements, and Prentice inferences stay separate.
- File changes are what git shows.
- A debug entry requires a recorded failure: a failed command, a failed test sentence, a session failure, or a failed tool. An interrupt is not a defect.
- The repository and the session record stay on this machine. The UI shows connection state, not credentials.
- If the evidence is thin, Prentice says so. It does not invent why the agent chose an approach.
- Explain-back scales with the change. A tiny change can be skipped. There is no score and no rank.

## Decisions

- Account login replaced pasted API keys. Connection is the official CLI or SDK login for each tool.
- The fixture is the router pool only when no real account is connected.
- Telemetry is stored and does not change routing.
- Engineering memory, retrieval, and hosted sync wait. Debug is limited to the current task.
- Before/after architecture diagrams are withheld until a change actually supports one. The current analysis does not draw them.
