# Accessibility script

A manual pass over the eight main flows, run twice: once with the keyboard only, once with VoiceOver in Safari (Cmd+F5 turns it on; Ctrl+Option is "VO").
For each step, note whether the control can be reached, what is announced, and where focus is afterwards. Anything surprising is a finding for `docs/beta-audit.md`.

Setup: the dev stack with seeded mail (`deploy/README.md`), signed out, at http://localhost:8080.

| Column | Meaning |
|---|---|
| Reach | Could you get to the control without a pointer? (yes / no / awkward) |
| Says | What VoiceOver announced: name, role, state |
| Focus after | Where focus was once the step finished |

## 1. Sign in

| # | Step | Reach | Says | Focus after |
|---|---|---|---|---|
| 1.1 | Load `/`. Find and activate "Sign in". | | | |
| 1.2 | On Stalwart's page, fill in the user and password and submit. | | | |
| 1.3 | Back in oinbox: is the arrival in the inbox announced? Where is focus? | | | |

## 2. Read a thread

| # | Step | Reach | Says | Focus after |
|---|---|---|---|---|
| 2.1 | Move to the thread list. Is it announced as a list, with a count? | | | |
| 2.2 | Move down three rows (`j`, or VO+Down). Does each row give sender, subject, date and unread state? | | | |
| 2.3 | Open "Q3 planning offsite" (`o` or Enter). | | | |
| 2.4 | Read the messages in order. Are collapsed messages announced as collapsed? Can they be expanded? | | | |
| 2.5 | Enter the message body (it is an iframe). Can it be read, and left again? | | | |
| 2.6 | Go back to the list (`u`). Is focus on the row you opened? | | | |

## 3. Reply

| # | Step | Reach | Says | Focus after |
|---|---|---|---|---|
| 3.1 | Open a thread and press `r` (or activate Reply). | | | |
| 3.2 | Are To, Subject and the body each labelled? | | | |
| 3.3 | Add a second recipient from the suggestions. Are the suggestions announced, and the choice? | | | |
| 3.4 | Type a sentence. Is "Draft saved" announced, once, without stealing focus? | | | |
| 3.5 | Send (Ctrl+Enter). Is "Sending…" announced with its Undo? Can Undo be reached in time? | | | |
| 3.6 | After sending: where is focus? | | | |

## 4. Triage

| # | Step | Reach | Says | Focus after |
|---|---|---|---|---|
| 4.1 | On a row, press `e` (archive). Is the confirm dialog announced with its title? Which button has focus? | | | |
| 4.2 | Cancel. Is focus back on the row? | | | |
| 4.3 | Archive for real. Is the result announced? Where is focus (the next row, not the page)? | | | |
| 4.4 | Undo from the toast. | | | |
| 4.5 | Star (`s`), mark unread (`U`), delete (`#`). Is each result announced once? | | | |
| 4.6 | Select two rows (`x`) and archive both. Is the selection count announced? | | | |

## 5. Label

| # | Step | Reach | Says | Focus after |
|---|---|---|---|---|
| 5.1 | Create a label from the sidebar "+". Is the dialog labelled; is an error (duplicate name) announced? | | | |
| 5.2 | Apply it to a thread (`l`). Is the picker a list with a search field; is the choice announced? | | | |
| 5.3 | Open the label's "⋯" menu, rename it, then delete it. Does focus return to the menu button each time? | | | |

## 6. Search

| # | Step | Reach | Says | Focus after |
|---|---|---|---|---|
| 6.1 | Press `/`. Is the search field announced? | | | |
| 6.2 | Search `from:bob`. Are the number of results or "no results" announced? | | | |
| 6.3 | Open a result and go back. | | | |
| 6.4 | Clear the search. | | | |

## 7. Change a setting

| # | Step | Reach | Says | Focus after |
|---|---|---|---|---|
| 7.1 | Open Settings from the top bar. Is the page heading announced? | | | |
| 7.2 | Edit the signature of an identity and save. Is the editor labelled; is the save announced? | | | |
| 7.3 | Turn the vacation responder on, set dates with the date picker, save. Are the switch state and the dates announced? | | | |
| 7.4 | Turn it off again. Does the banner come and go with an announcement? | | | |

## 8. Answer an invitation

| # | Step | Reach | Says | Focus after |
|---|---|---|---|---|
| 8.1 | Open an invitation email (have Bob invite Alice to an event tomorrow). Is the card read before the body: title, time, organiser, guests? | | | |
| 8.2 | Activate Accept. Is the new state announced ("Accepted", pressed)? | | | |
| 8.3 | Open the calendar. Can the event be reached and opened from the keyboard? | | | |
| 8.4 | Close the card with Escape. Is focus back on the event? | | | |

## Throughout

- Focus is always visible, in the light and the dark theme.
- No keyboard trap: Tab and Shift+Tab leave every widget, Escape closes every overlay.
- Icon-only buttons (top bar, message actions, composer toolbar) have names.
- Toasts, new mail arriving, the connection banner ("Can't reach the server. Retrying…") and the save status are announced once each, politely. To see the banner, stop Stalwart: `docker compose -f deploy/docker-compose.yml stop stalwart`.
- With "Reduce motion" on (System Settings › Accessibility › Display), nothing slides or fades in a way that matters.
- At 200% zoom nothing is cut off and nothing needs sideways scrolling.
