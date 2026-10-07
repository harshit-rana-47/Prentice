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

Build, understand, explain-back, and return to the agent are in the workspace now. Debug runs only when the current session recorded a real failure. Demonstrated understanding is remembered on this computer for this repository, so later explain-back questions can skip a fact the user already showed they know. Teaching an answer is not the same as the user demonstrating it. That memory is not copied to the cloud.

## What Prentice is

Prentice is a hosted learning experience around Codex, Claude Code, and Cursor. A signed-in user connects one computer. That computer opens one git repository, routes a task, forwards the original prompt, shows the session, and explains the diff that git recorded. The repository stays on the computer.

The workspace is one conversation. The repository, its chats, the file tree, search, and changes open from the side and close again. Understand, Explain-back, and Debug stay inside the conversation. Learning is not a separate application.

The fixture provider exists so local development can prove the loop without a paid model call. A connector started for the hosted site does not use it. That computer needs a connected coding account.

## What Prentice is not

- Not another coding agent. The connected tool writes the code. Prentice routes, watches, and explains.
- Not a generic chatbot. Questions come from the task's evidence.
- Not a Cursor clone. The editor is a read-only view of the repo and the diff.
- Not an RAG-first product. Nothing is embedded or retrieved from a knowledge base.
- Not an artificial debugging platform. Debug does not invent a bug, a root cause, or a fix.
- Not a cloud IDE. The website is the learning surface. The repository and the coding agent stay on the user's computer. Redis and BullMQ are not part of the design that shipped.

## Principles

- Sending a message starts the task in the open repository. The user can change the coding agent before the first message of a new conversation, and chooses how much debug help to reveal.
- Observed facts, agent statements, and Prentice inferences stay separate. Observed is what Prentice established directly: git, parsed symbols, recorded commands, exit codes, and a failed command's own output. Agent stated is what the coding agent reported or claimed. Prentice inference is a conclusion Prentice derives from that evidence. An agent statement is never presented as observed.
- File changes are what git shows.
- A debug entry requires a recorded failure: a failed command, a failed test sentence, a session failure, or a failed tool. An interrupt is not a defect, and neither is a coding agent that is not installed or not signed in. Debug may show a bounded, failure-scoped slice of the command's real output. It never invents a cause.
- The repository and the session record stay on this machine. The connector sends the recorded evidence summary to Prentice, and Prentice calls Groq. Prentice does not store that summary or the explain-back answers. The UI shows connection state, not credentials.
- If the evidence is thin, Prentice says so. It does not invent why the agent chose an approach.
- Explain-back scales with the change. A tiny change can be skipped. There is no score and no rank.

## Decisions

- Account login replaced pasted API keys. Connection is each agent's own sign-in on this computer. Prentice does not ask for or store coding-agent API keys.
- Coding agents are not bundled. The person installs Codex, Claude Code, or the Cursor CLI. Prentice installs only its connector, and finds each agent as not installed, signed out, ready, or unavailable.
- The fixture is the router pool only in local development, and only when no real account is connected. A paired computer does not receive it.
- Telemetry is stored and does not change routing.
- Engineering memory and retrieval wait. Debug is limited to the current task. The learning record is not copied to the cloud.
- Before/after architecture diagrams are withheld until a change actually supports one. The current analysis does not draw them.
