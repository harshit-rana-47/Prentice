# Design system

The UI is a dark IDE workspace. Tokens come from shadcn `base-nova` in `apps/web/app/globals.css`. The root layout forces `class="dark"`. Icons are Lucide. Components in `apps/web/components/ui` are the shadcn primitives actually used: button, input, textarea, checkbox, toggle group.

Update this file when a visual pattern changes. Do not describe an aspiration.

## Color

Dark surfaces are warm, not neutral black.

- Page background `oklch(0.17 0.012 75)`, foreground `oklch(0.96 0.01 90)`.
- Cards and popovers `oklch(0.22 0.014 75)`.
- Primary is an amber `oklch(0.76 0.11 68)` with dark amber text. It is the accent for the wordmark, active intensity, diff hunk headers, and in-progress login text.
- Borders are `oklch(1 0 0 / 10%)`. Inputs are `oklch(1 0 0 / 15%)`.
- Muted text is `oklch(0.708 0 0)`.
- Sidebar is `oklch(0.205 0 0)` with a white foreground. Sidebar accent is `oklch(0.269 0 0)`.
- Destructive is `oklch(0.704 0.191 22.216)`. Deletions and failed login text use it.
- Additions use `text-emerald-400` in the changes list and `bg-emerald-500/10 text-emerald-300` in the diff.
- The light `:root` tokens exist because the shadcn file includes them. The app does not switch to light mode.

## Type

- UI text is Geist, 14px (`text-sm`) on the workspace.
- The word "Prentice" in the top bar is Fraunces at `text-base`.
- Code, diffs, and the CodeMirror scroller are Geist Mono. Diff lines are 13px with `leading-6`.
- Section labels are 11px, uppercase, wide tracking, muted. Examples: `PRENTICE`, `CHANGES`, `SEARCH`.

## Space, border, radius

- The workspace grid is `h-dvh`, `min-w-[880px]`, columns `44px / minmax(180px, 220px) / minmax(0, 1fr) / minmax(240px, 320px)`, rows `44px / 1fr / 28px`.
- Panels are separated by `border-border`, not by cards.
- Base radius is `0.625rem`. Buttons use `rounded-lg`. Learning rows and the account menu use `rounded-md` and `rounded-lg`.
- Sidebar rows use `px-3 py-1` or `px-2 py-2`. Nested explorer files indent `8 + depth * 12` pixels. Folders start open when `depth < 1`.

## Activity bar

A 44px vertical nav. Each item is an icon button with an accessible name: Explorer, Search, Source Control, Run / Tests, Prentice. The selected item uses the sidebar accent. Accounts is a separate control in the top bar, not an activity.

## Sidebar

One left column. Its contents swap with the activity. It does not navigate to another page.

- Explorer: repo path field, branch, file tree, `A` / `M` / `D` marks from git status.
- Search: one input, placeholder "Filter by file name", the first 200 matching paths. It filters the tree. It does not search file contents.
- Source control: change count, `+additions` in emerald, `-deletions` in destructive, one row per path. A row opens the diff.
- Run / Tests: timeline rows whose title or detail matches command, test, npm, pnpm, pytest, or vitest. Empty copy: "This task has not reported a command."
- Prentice: the learning checklist.

## Editor and tabs

Tabs sit above a read-only CodeMirror view (`theme="dark"`, line numbers, fold gutter) or a unified diff. The close control is a `×` on the tab label. Empty editor space stays empty until a file or diff is opened.

Diff lines keep their prefix. Headers are muted, hunk lines are primary, additions are emerald, deletions are destructive.

## Agent panel

The right column is 240–320px. Two text tabs, Agent and Prentice, switch the column. The editor and explorer stay.

Agent holds the prompt textarea, Send, the routing summary, Use / Change, consent, and the timeline. Status tones in the timeline are the domain tones: neutral, change, ok, fail. The fixture is labeled "Demo provider. No vendor call."

## Learning panel

Checklist marks are characters, not badges: `✓` done, `→` current, `○` pending, `×` failed build.

Rows are Build, Understand, Explain-back, Debug. Detail is one or two muted lines under the title. Understand counts files and concepts with singular or plural wording.

Understand keeps the headings Observed, Agent stated, and Prentice inference. Citations are buttons in the form `symbol → path`. Explain-back is a short prompt, a textarea with placeholder "Write your explanation...", Submit, and Skip when the policy allows it. Feedback headings are "You understand" and "Still unclear".

Debug lists the help steps already revealed. More help and Less help are small outline and default buttons.

"Return to build" is the way back to the agent column. It does not clear the task or the open file.

## Controls and states

- Primary buttons are the amber default variant. Secondary actions, including Connect and overrides, are `outline` or `ghost` at size `sm`.
- Inputs and textareas are the shadcn controls on the dark input token.
- Disabled buttons drop to 50% opacity.
- Errors are `text-destructive` or the runtime error message in the workspace. Empty sections use `text-muted-foreground` and say what is missing, for example "No active issue" and "Git did not return a diff for this path."
- Account rows use `● Connected` and `○ Not connected`. Pending login text is primary. Failed login text is destructive.
- The status bar is the 28px bottom row: branch, change count, additions and deletions, and the runtime label.
