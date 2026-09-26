#!/usr/bin/env python3
"""Seed oinbox dev mailboxes. Stdlib only; runs inside the compose network.

* Inbound mail is delivered over SMTP to stalwart:25 (plain MTA, no auth).
* Messages *written by alice* are stored in her Sent mailbox with Email/import and,
  when they have local recipients, submitted with EmailSubmission/set so the
  recipient (bob) receives them through Stalwart's own MTA.
* Idempotent: aborts early if alice already has a message with the
  X-Oinbox-Seed header.
"""
import base64
import json
import os
import smtplib
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import format_datetime

SMTP_HOST = os.environ.get("SMTP_HOST", "stalwart")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "25"))
JMAP_BASE = os.environ.get("JMAP_BASE", "http://stalwart:8080")
PASSWORD = os.environ.get("SEED_PASSWORD", "oinbox-dev-pass")
DOMAIN = "example.test"
ALICE = f"alice@{DOMAIN}"
BOB = f"bob@{DOMAIN}"
USING = [
    "urn:ietf:params:jmap:core",
    "urn:ietf:params:jmap:mail",
    "urn:ietf:params:jmap:submission",
]
NOW = datetime.now(timezone.utc).replace(microsecond=0)


def ago(days=0, hours=0, minutes=0):
    return NOW - timedelta(days=days, hours=hours, minutes=minutes)


# ---------------------------------------------------------------- JMAP helpers
def _auth(user):
    return "Basic " + base64.b64encode(f"{user}:{PASSWORD}".encode()).decode()


def jmap(user, calls):
    req = urllib.request.Request(
        f"{JMAP_BASE}/jmap/",
        data=json.dumps({"using": USING, "methodCalls": calls}).encode(),
        headers={"Authorization": _auth(user), "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as r:
        body = json.load(r)
    for name, args, tag in body["methodResponses"]:
        if name == "error":
            raise SystemExit(f"JMAP error in {tag}: {args}")
        for key in ("notCreated", "notUpdated"):
            if args.get(key):
                raise SystemExit(f"JMAP {name} {key}: {args[key]}")
    return {tag: args for _, args, tag in body["methodResponses"]}


def session(user):
    req = urllib.request.Request(f"{JMAP_BASE}/jmap/session", headers={"Authorization": _auth(user)})
    with urllib.request.urlopen(req) as r:
        s = json.load(r)
    return s["primaryAccounts"]["urn:ietf:params:jmap:mail"]


def upload(user, account_id, raw: bytes):
    req = urllib.request.Request(
        f"{JMAP_BASE}/jmap/upload/{account_id}/",
        data=raw,
        headers={"Authorization": _auth(user), "Content-Type": "message/rfc822"},
    )
    with urllib.request.urlopen(req) as r:
        return json.load(r)["blobId"]


# ---------------------------------------------------------------- message builder
def build(frm, to, subject, date, msgid, text=None, html=None, cc=None, reply_to=None):
    """reply_to: previous message dict (for In-Reply-To/References)."""
    m = EmailMessage()
    m["From"] = frm
    m["To"] = ", ".join(to) if isinstance(to, list) else to
    if cc:
        m["Cc"] = ", ".join(cc)
    m["Subject"] = subject
    m["Date"] = format_datetime(date)
    m["Message-ID"] = f"<{msgid}>"
    m["X-Oinbox-Seed"] = "1"
    if reply_to is not None:
        m["In-Reply-To"] = f"<{reply_to['id']}>"
        m["References"] = " ".join(f"<{r}>" for r in reply_to["refs"] + [reply_to["id"]])
    m.set_content(text or "(this message has an HTML body)")
    if html:
        m.add_alternative(html, subtype="html")
    return m


def ref(msgid, parent=None):
    return {"id": msgid, "refs": (parent["refs"] + [parent["id"]]) if parent else []}


# ---------------------------------------------------------------- scenario
def scenario():
    """Returns a chronologically ordered list of (kind, EmailMessage, extra).
    kind = "smtp"  -> deliver over SMTP to envelope rcpts in extra
    kind = "alice" -> alice-authored: import into her Sent, submit to local rcpts in extra
    """
    out = []
    A = "Alice Example <alice@example.test>"
    B = "Bob Example <bob@example.test>"
    CAROL = "Carol Nguyen <carol@partner.test>"
    DAVE = "Dave Okafor <dave@partner.test>"
    ERIN = "Erin Walsh <erin@design.test>"
    CI = "CI Bot <ci@builds.test>"

    # Thread 1: Q3 planning offsite (external thread, alice replies -> Sent, bob cc'd)
    t1a = ref("offsite-1@partner.test")
    out.append(("smtp", build(CAROL, [A], "Q3 planning offsite", ago(9, 6), t1a["id"],
        "Hi Alice,\n\nWe're planning the Q3 offsite for the week of the 14th. Can your team "
        "present the quarterly roadmap? We have the lakeside venue booked.\n\nCarol"), [ALICE]))
    t1b = ref("offsite-2@partner.test", t1a)
    out.append(("smtp", build(DAVE, [A], "Re: Q3 planning offsite", ago(9, 4), t1b["id"],
        "Adding: the venue has a projector but no whiteboards. Bring markers.\n\n"
        "> We're planning the Q3 offsite for the week of the 14th.\n\nDave", cc=[CAROL], reply_to=t1a), [ALICE]))
    t1c = ref("offsite-3@example.test", t1b)
    out.append(("alice", build(A, [CAROL, DAVE], "Re: Q3 planning offsite", ago(9, 2), t1c["id"],
        "Happy to present the roadmap. I'm looping in Bob, who owns the zeppelin integration demo.\n\n"
        "On the whiteboards: noted, we'll bring a portable one.\n\nAlice\n\n"
        "> Adding: the venue has a projector but no whiteboards.", cc=[B], reply_to=t1b), [BOB]))
    t1d = ref("offsite-4@partner.test", t1c)
    out.append(("smtp", build(CAROL, [A], "Re: Q3 planning offsite", ago(8, 20), t1d["id"],
        "Perfect, thanks both. Agenda draft to follow.\n\nCarol", cc=[DAVE, B], reply_to=t1c), [ALICE, BOB]))
    t1e = ref("offsite-5@partner.test", t1d)
    out.append(("smtp", build(CAROL, [A, B], "Re: Q3 planning offsite", ago(7, 3), t1e["id"],
        "Agenda attached inline:\n 09:00 Welcome\n 10:00 Quarterly roadmap (Alice)\n"
        " 11:30 Zeppelin demo (Bob)\n 13:00 Lunch by the lake\n\nCarol", reply_to=t1d), [ALICE, BOB]))

    # Thread 2: Lunch Friday? (internal: bob <-> alice, alice's reply is submitted to bob)
    t2a = ref("lunch-1@example.test")
    out.append(("smtp", build(B, [A], "Lunch Friday?", ago(6, 5), t2a["id"],
        "Tacos on Friday? The new place on 5th street.\n\nBob"), [ALICE]))
    t2b = ref("lunch-2@example.test", t2a)
    out.append(("alice", build(A, [B], "Re: Lunch Friday?", ago(6, 4), t2b["id"],
        "Yes! 12:30 works for me.\n\n> Tacos on Friday? The new place on 5th street.", reply_to=t2a), [BOB]))
    t2c = ref("lunch-3@example.test", t2b)
    out.append(("smtp", build(B, [A], "Re: Lunch Friday?", ago(6, 3), t2c["id"],
        "Booked a table for two at 12:30.\n\nBob", reply_to=t2b), [ALICE]))

    # Thread 3: HTML reply with a remote image and a quoted reply (alice's original is Sent-only)
    t3a = ref("redesign-1@example.test")
    out.append(("alice", build(A, ["Erin Walsh <erin@design.test>"], "Homepage redesign feedback", ago(5, 8), t3a["id"],
        "Hi Erin,\n\nThe new hero section looks great. Could we try a darker navy for the header "
        "and larger body text?\n\nAlice"), []))
    t3b = ref("redesign-2@design.test", t3a)
    out.append(("smtp", build(ERIN, [A], "Re: Homepage redesign feedback", ago(5, 1), t3b["id"],
        "Updated mockup below (view the HTML version).\n\nOn the header: switched to navy #1b2a4a.\n\n"
        "> The new hero section looks great. Could we try a darker navy for the header and larger body text?",
        html=(
            "<html><body style=\"font-family:Georgia,serif\">"
            "<p>Hi Alice,</p>"
            "<p>Here is the updated mockup with the <b>navy header</b> and 18px body text:</p>"
            "<p><img src=\"https://picsum.photos/seed/oinbox-redesign/600/240\" width=\"600\" height=\"240\" "
            "alt=\"Homepage mockup\"></p>"
            "<p>Tracking pixel (remote, should be blocked by default): "
            "<img src=\"https://tracker.design.test/open.gif?u=alice\" width=\"1\" height=\"1\" alt=\"\"></p>"
            "<p>Erin</p>"
            "<div class=\"gmail_quote\"><p>On " + format_datetime(ago(5, 8)) + ", Alice Example &lt;alice@example.test&gt; wrote:</p>"
            "<blockquote type=\"cite\" style=\"margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex\">"
            "<p>Hi Erin,</p><p>The new hero section looks great. Could we try a darker navy for the header "
            "and larger body text?</p><p>Alice</p></blockquote></div>"
            "</body></html>"
        ), reply_to=t3a), [ALICE]))

    # Thread 4: CI failures (4 automated messages, one thread)
    t4 = None
    for i, (h, status) in enumerate([(4, "failed"), (3, "failed"), (2, "failed"), (1, "passed")]):
        nxt = ref(f"ci-main-{i}@builds.test", t4)
        subj = "Build " + status + " on main" if i == 0 else "Re: Build failed on main"
        out.append(("smtp", build(CI, [A], subj, ago(4, h), nxt["id"],
            f"Pipeline #{812 + i} {status}.\nJob: unit-tests\nCommit: {'abcdef0123'[i:i+7]}\n", reply_to=t4), [ALICE]))
        t4 = nxt

    # Thread 5: Invoice with follow-up
    t5a = ref("invoice-1042@vendor.test")
    out.append(("smtp", build("Billing <billing@vendor.test>", [A], "Invoice #1042", ago(3, 10), t5a["id"],
        "Your invoice #1042 for $1,240.00 is due in 14 days."), [ALICE]))
    t5b = ref("invoice-1042-r@vendor.test", t5a)
    out.append(("smtp", build("Billing <billing@vendor.test>", [A], "Re: Invoice #1042", ago(1, 9), t5b["id"],
        "Friendly reminder: invoice #1042 is due in 3 days.", reply_to=t5a), [ALICE]))

    # Thread 6: Bob-only thread (bob's mailbox has content too)
    t6a = ref("zeppelin-1@partner.test")
    out.append(("smtp", build(DAVE, [B], "Zeppelin integration API keys", ago(3, 6), t6a["id"],
        "Bob, the staging API keys for the zeppelin integration are in the vault."), [BOB]))
    t6b = ref("zeppelin-2@partner.test", t6a)
    out.append(("smtp", build(DAVE, [B], "Re: Zeppelin integration API keys", ago(3, 5), t6b["id"],
        "Correction: they're under /staging/zeppelin, not /prod.", reply_to=t6a), [BOB]))

    # Thread 7: long-ish discussion, 3 participants
    t7 = None
    lines = [
        (CAROL, "Proposal: move the weekly sync to Tuesdays at 10:00."),
        (DAVE, "Tuesday works, but 10:30 is better for the west coast folks."),
        (CAROL, "10:30 it is. Alice, does that clash with your standup?"),
    ]
    for i, (who, body) in enumerate(lines):
        nxt = ref(f"sync-{i}@partner.test", t7)
        out.append(("smtp", build(who, [A], ("Re: " if i else "") + "Weekly sync time", ago(2, 12 - i), nxt["id"],
            body, reply_to=t7), [ALICE]))
        t7 = nxt
    t7r = ref("sync-3@example.test", t7)
    out.append(("alice", build(A, [CAROL, DAVE], "Re: Weekly sync time", ago(2, 8), t7r["id"],
        "No clash, Tuesday 10:30 is fine.\n\nAlice", reply_to=t7), []))

    # Singles
    singles = [
        ("Newsletter <news@weekly.test>", "This week in JMAP: push, sieve and more", ago(8, 1),
         "Top stories: EventSource vs WebSocket push, Sieve vacation responses, and quota handling."),
        ("HR <hr@example.test>", "Reminder: submit your timesheet", ago(7, 1),
         "Please submit your timesheet by Friday 17:00."),
        ("Security <security@example.test>", "New sign-in to your account", ago(5, 3),
         "We noticed a new sign-in from Firefox on Linux. If this was you, no action is needed."),
        ("Frank Li <frank@partner.test>", "Conference talk slides", ago(4, 7),
         "Slides from my talk on offline-first mail clients are at https://example.invalid/slides."),
        ("Travel <travel@airline.test>", "Your itinerary: SFO to JFK", ago(3, 2),
         "Flight OA123 departs 08:15, seat 14C. Confirmation code ZEPP42."),
        ("Grace Kim <grace@partner.test>", "Question about the roadmap", ago(2, 3),
         "Is the quarterly roadmap deck shareable outside the company?"),
        ("Newsletter <news@weekly.test>", "This week in JMAP: collapseThreads deep dive", ago(1, 1),
         "How servers compute collapsed thread queries and why queryChanges is hard."),
        ("Heidi Park <heidi@partner.test>", "Unicode test: café, naïve, 日本語, emoji 🎉", ago(0, 5),
         "Testing non-ASCII subjects and bodies: résumé, Zürich, Ελληνικά, 中文."),
    ]
    for i, (frm, subj, date, body) in enumerate(singles):
        out.append(("smtp", build(frm, [A], subj, date, f"single-{i}@seed.test", body), [ALICE]))

    out.sort(key=lambda x: x[1]["Date"].datetime)
    return out


# ---------------------------------------------------------------- main
def existing_message_ids(user):
    acct = session(user)
    r = jmap(user, [
        ["Email/query", {"accountId": acct}, "q"],
        ["Email/get", {"accountId": acct, "#ids": {"resultOf": "q", "name": "Email/query", "path": "/ids"},
                       "properties": ["messageId"]}, "g"],
    ])
    return {mid for e in r["g"]["list"] for mid in (e.get("messageId") or [])}


def main():
    alice_acct = session(ALICE)
    # Per-message idempotency keyed on Message-ID (note: Stalwart 0.16 returns no results
    # for the Email/query `header` filter, so we compare Email/get messageId instead).
    present = existing_message_ids(ALICE) | existing_message_ids(BOB)

    boxes = jmap(ALICE, [["Mailbox/get", {"accountId": alice_acct, "properties": ["role"]}, "m"]])["m"]["list"]
    sent_id = next(b["id"] for b in boxes if b["role"] == "sent")
    identity_id = jmap(ALICE, [["Identity/get", {"accountId": alice_acct}, "i"]])["i"]["list"][0]["id"]

    msgs = scenario()
    n_smtp = n_sent = 0
    skipped = 0
    for kind, msg, rcpts in msgs:
        if msg["Message-ID"].strip("<>") in present:
            skipped += 1
            continue
        if kind == "smtp":
            sender = msg["From"].addresses[0].addr_spec
            # one session per message: Stalwart caps messages per SMTP session
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as smtp:
                smtp.ehlo("seed.oinbox.test")
                smtp.send_message(msg, from_addr=sender, to_addrs=rcpts)
            n_smtp += len(rcpts)
        else:
            blob = upload(ALICE, alice_acct, msg.as_bytes())
            calls = [["Email/import", {"accountId": alice_acct, "emails": {"e": {
                "blobId": blob, "mailboxIds": {sent_id: True}, "keywords": {"$seen": True}}}}, "imp"]]
            if rcpts:
                calls.append(["EmailSubmission/set", {"accountId": alice_acct, "create": {"s": {
                    "identityId": identity_id, "emailId": "#e",
                    "envelope": {"mailFrom": {"email": ALICE}, "rcptTo": [{"email": x} for x in rcpts]}}}}, "sub"])
            jmap(ALICE, calls)
            n_sent += 1
        # receivedAt has 1-second resolution; keep delivery order == chronological order
        time.sleep(1.05)
    print(f"seed: {n_smtp} SMTP deliveries, {n_sent} alice-authored messages stored in Sent, "
          f"{skipped} messages already present")


if __name__ == "__main__":
    sys.exit(main())
