# Design system

The website and workspace are light, warm paper surfaces. Tokens and responsive rules live in `apps/web/app/globals.css`. The page stays in light mode. Icons are Lucide. Components in `apps/web/components/ui` are the shadcn primitives actually used.

Update this file when a visual pattern changes. Do not describe an aspiration.

## Color

- Page and conversation background are warm paper. The sidebar is a slightly deeper paper.
- Foreground is a warm carbon brown. Muted text is a lighter brown.
- Primary is clay orange. It marks the wordmark slash, selected actions, the short accent rule on sign-in, learning, and the next step in the public story.
- Carbon is reserved for code and the main Continue surface. Olive marks recorded understanding and additions; warm red marks real failures.
- Borders are a warm sand. Destructive is a deep red. Success is a muted green.
- There is no dark theme and no forced `dark` class on the document.

## Type

- UI text is Instrument Sans, about 13.5px on the workspace.
- The word "Prentice", major editorial headings, and learning moments use Instrument Serif.
- Paths, the branch, commands, and pairing codes use IBM Plex Mono.
- Section labels are small, uppercase, and widely tracked.

## Public landing

The signed-out root opens with a large Build / Understand thesis, an illustrative file-change and Explain-back pairing, and a continuous, sticky workspace demonstration. Five chapters take one example through Build, Understand, Explain-back, Debug, and Continue. The example is labelled illustrative. Evidence categories have distinct labels; privacy copy names the local connector, authenticated relay, bounded Learning AI evidence, and vendor policy boundary. Agent compatibility, FAQ, and the closing action complete the page. The primary action opens the existing sign-in and pairing flow; it does not change provider login behavior.

Motion uses the existing settle easing, with chapter changes driven by IntersectionObserver, transform/opacity section entry, and reduced-motion overrides. The mobile demonstration remains in normal document flow with a compact sticky preview.

## Home

After a connection opens, Home reads the connector's local SQLite journal through the same authenticated local or relay transport as the workspace. It shows the latest task and its status, projects and their actual conversation counts, recorded concepts, a searchable and paginated engineering journal, a UTC task calendar, learning moments, needs-attention entries, recent conversations with a control to show all, and provider/computer status. Search and journal filters run before server pagination. Selecting a calendar day filters the journal to that task date. Pins for projects and conversations are validated and stored locally in connector settings. A return from Home opens the actual project, conversation, and task; interrupted work keeps the existing Send Again action.

There is no numerical mastery score or inferred Debug resolution. “Explored” means a recorded Explain-back question; “Explained in your own words” means recorded understood feedback. A Debug record says resolution was not recorded. Test results shown for a project are explicitly labelled latest task evidence, not current project health. “Since your last visit” compares recorded task timestamps to the local Home visit timestamp.

## Workspace

The screen is one column of conversation with a narrow left rail. It fills the viewport and scrolls inside the conversation, not the page. Home and Workspace share one mounted workspace session, so changing views keeps the draft and task stream. Browser Back/Forward restores the Home or Workspace view.

- The header shows Prentice, Home/Workspace view controls, the open repository and branch when relevant, command search, Agents, and the signed-in email (an account initial on narrow screens). Agents lists each coding agent as Ready, Not signed in, Not installed, or Needs attention, with the next step. The account control opens the account menu: the email, the computer, Remove This Computer (with a confirmation), and Sign Out.
- The rail holds Projects and conversations, Explorer, Search, and Changes. Opening Projects and conversations covers the file pane with a repository list. Chats sit under each repository. New Chat and Choose Folder are in that list. Choose Folder opens the computer's folder window. The list closes on outside click and Escape.
- Explorer, Search, and Changes stay the file pane. Search filters file names. Changes opens a read-only diff. The file viewer is read-only. On desktop, the explorer and file viewer have pointer and keyboard resizable dividers.
- The command palette opens with Cmd/Ctrl+K. It navigates Home, projects, conversations, files, diffs, the Agents menu, the account menu, and journal search. Cmd/Ctrl+Shift+H opens Home. Escape closes the palette.
- Below 960px the file pane overlays the conversation instead of sitting beside it.

## Conversation

The conversation is the center. Agent replies are shown in full. Commands and file activity stay compact. Vendor status lines are not shown.

A run that was stopped, or that Prentice closed mid-run, ends with a note that the agent's changes stay in the working tree and a Send Again button. Send Again puts the prompt in a new conversation without sending it. A Debug record shows the failed command, then its Command output (the last lines only, when cut), then "No cause was recorded". The Learning AI explanation keeps its Observed, Agent stated, and Not recorded headings.

Send continues the selected Codex conversation. New Chat starts another conversation in the same repository. Codex and Claude Code resume their saved sessions; Cursor says when continuation is not available. Understand, Explain-back, and Debug stay in that conversation. Explain-back labels a hint as Hint and a recorded answer as From the record.

The composer floats above the workspace with a distinct focus treatment and content-driven text height. Enter sends. Shift+Enter inserts a newline. A coarse pointer does not use Enter to send.

## Motion

Panels, the palette, journal entries, and the sign-in card rise a few pixels and fade in. The accent rule draws from the left. Hover, focus, and pressed states stay inside a small set of timing tokens. Reduced motion removes these transitions and smooth scrolling.

## Sign-in

The signed-out root is the public landing. Its Open Prentice action opens the paper sign-in card on the sidebar color. After sign-in, a pairing code is shown with a download for this computer and an expiry countdown. An expired code is struck through, with Get a New Code. The card shows the signed-in email and Sign Out. When the paired computer is offline, the card offers Remove This Computer. The repository is not drawn on the card.
