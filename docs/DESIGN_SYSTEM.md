# Design system

The workspace is a light, warm paper surface. Tokens live in `apps/web/app/globals.css`. The page stays in light mode. Icons are Lucide. Components in `apps/web/components/ui` are the shadcn primitives actually used.

Update this file when a visual pattern changes. Do not describe an aspiration.

## Color

- Page and conversation background are warm paper. The sidebar is a slightly deeper paper.
- Foreground is a warm carbon brown. Muted text is a lighter brown.
- Primary is clay orange. It marks the wordmark rule, the selected account action, and the short accent rule on the sign-in card.
- Borders are a warm sand. Destructive is a deep red. Success is a muted green.
- There is no dark theme and no forced `dark` class on the document.

## Type

- UI text is Instrument Sans, about 13.5px on the workspace.
- The word "Prentice" and conversation headings use Instrument Serif.
- Paths, the branch, commands, and pairing codes use IBM Plex Mono.
- Section labels are small, uppercase, and widely tracked.

## Workspace

The screen is one column of conversation with a narrow left rail. It fills the viewport and scrolls inside the conversation, not the page.

- The header shows Prentice, the open repository name, the branch, and Accounts.
- The rail holds Projects and conversations, Explorer, Search, and Changes. Opening Projects and conversations covers the file pane with a repository list. Chats sit under each repository. New Chat and Choose Folder are in that list. Choose Folder opens the computer's folder window. The list closes on outside click and Escape.
- Explorer, Search, and Changes stay the file pane. Search filters file names. Changes opens a read-only diff. The file viewer is read-only.
- Below 960px the file pane overlays the conversation instead of sitting beside it.

## Conversation

The conversation is the center. Agent replies are shown in full. Commands and file activity stay compact. Vendor status lines are not shown.

Send continues the selected Codex conversation. New Chat starts another conversation in the same repository. Claude Code and Cursor say when continuation is not available. Understand, Explain-back, and Debug stay in that conversation. Explain-back labels a hint as Hint and a recorded answer as From the record.

Enter sends. Shift+Enter inserts a newline. A coarse pointer does not use Enter to send.

## Motion

Panels and the sign-in card rise a few pixels and fade in. The accent rule draws from the left. Hover, focus, and pressed states stay inside the same timing. Reduced motion removes those transitions.

## Sign-in

The signed-out screen is a paper card on the sidebar color. After sign-in, a pairing code is shown with a download for this computer. The repository is not drawn on the card.
