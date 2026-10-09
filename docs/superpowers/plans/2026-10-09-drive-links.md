# Drive, slice 3: Send as a link — Implementation Plan

**Goal:** Files too large for mail are uploaded to the sender's Drive and sent as one link, with a password step the sender controls.

**Spec:** `docs/superpowers/specs/2026-10-09-drive-integration-design.md`, "Slice 3: Send as a link". Builds on slices 1 and 2 on branch `drive-integration`.

This plan lists tasks, interfaces and the behaviour each task must pin. Unlike the plans for slices 1 and 2 it does not carry the code: the executor is the session that designed it, working test-first, and the user asked for the slice to be built without a stop for review.

## Global Constraints

- No new dependencies. With Drive off, nothing changes.
- Nothing is asked of OpenCloud until a file would cross the threshold.
- The offer is made when the message's attachments plus the files being added pass `linkOverMb` × 1024 × 1024 bytes, or when one file is larger than Stalwart's `maxSizeUpload` (then "Attach anyway" is not offered).
- Files for a link go from the browser to OpenCloud, never through Stalwart. Files chosen from Drive are copied inside OpenCloud.
- One folder and one link per message: `Mail attachments/<YYYY-MM-DD> <subject>`, numbered ` (2)`, ` (3)` if taken.
- A link's password is never stored in the mail store or `localStorage`: only in the message text if the sender chose that, and in `sessionStorage` for 30 minutes.
- OpenCloud stays out of CI; specs that need it skip themselves.
- Copy, verbatim: dialog title `Send as a Drive link`; buttons `Send as a link`, `Attach anyway`, `Generate`, `Copy`, `Retry`, `Cancel`; choices `Put it in the message`, `I'll send it another way`; block lines `Files for this message: <url>`, `Password: <password>`, `Available until <8 November 2026>.`; discard line `The files uploaded to Drive for it will be removed.`; reader line `Password for the Drive link:`.

## Review Focus

1. Cancel or a failure half-way through the uploads: no half-made link in the message, and no orphan folder from that run.
2. A password with `<`, `&` or quotes: shown exactly in the message, in HTML and in plain text.
3. Send pressed while link uploads run: impossible (the dialog is modal) and nothing is sent without its files.
4. The password must not survive sign-out, another tab, or 30 minutes.
5. Discarding a draft must not delete a folder whose message was sent, or one made for another message.

## Tasks

1. **Route and stack.** `/drive/ocs/*` proxied; the dev OpenCloud gets its own published port (9201) so a mailed link can be opened as its recipient would. Stack e2e: the three APIs answer, nothing else does.
2. **Client.** `rules()`, `createLink(itemId, { password?, expires? })`, `copy(from, to)`, `remove(path)`, and `upload(path, body, { signal?, onProgress? })` (XHR when progress is wanted). `DriveError` kinds gain `policy` and `exists`. The fake answers as probed: sharing rules, the password requirement and policy messages, `COPY` with 412, `DELETE`, links recorded for tests to read.
3. **Passwords.** `src/drive/password.ts`: `generatePassword(policy)`, `checkPassword(password, policy)`, `policyText(policy)`.
4. **Recall.** `src/app/linkPasswords.ts`: `remember(url, password)`, `recall(url)`, `findIn(text)`, `clear()`, over a `Storage`, 30 minutes, with an injected clock.
5. **The link service.** `src/app/driveLinks.ts`: the offer decision, the folder's name, the link block (HTML, escaped), making the link (folder, uploads or copies with progress, link, block into the body), cancel and retry, later files into the same folder, discard. `createComposers` takes optional Drive hooks for the discard note and the removal. `drive.choose` asks an optional `intercept` before downloading.
6. **The dialog.** `src/ui/LinkDialog.tsx`: the ask, the password step, progress, errors.
7. **Wiring, the reader's recall line, end to end, docs.**
