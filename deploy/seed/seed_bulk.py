#!/usr/bin/env python3
"""Fill carol's mailbox with real mail for the large-mailbox audit. Stdlib only.

Reads an extracted copy of the CMU Enron corpus (https://www.cs.cmu.edu/~enron/, the
`maildir/` tree: maildir/<user>/<folder>/<n>.) and stores messages with Email/import.

  python3 seed_bulk.py --source /corpus/maildir --count 50000 --spread-days 730

Idempotent: a message whose Message-ID carol already has is skipped.
"""
import argparse
import base64
import email
import email.policy
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

JMAP_BASE = os.environ.get("JMAP_BASE", "http://stalwart:8080")
PASSWORD = os.environ.get("SEED_PASSWORD", "oinbox-dev-pass")
USER = "carol@example.test"
USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"]
BATCH = 50
SENT_FOLDERS = {"sent", "sent_items", "_sent_mail", "sent_mail"}
INBOX_FOLDERS = {"inbox", "notes_inbox"}
MAX_LABELS = 20
AUTH = "Basic " + base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode()


def http(path, data=None, content_type="application/json"):
    req = urllib.request.Request(JMAP_BASE + path, data=data, headers={"Authorization": AUTH, "Content-Type": content_type})
    with urllib.request.urlopen(req, timeout=120) as res:
        return json.load(res)


def jmap(calls):
    body = http("/jmap/", json.dumps({"using": USING, "methodCalls": calls}).encode())
    out = {}
    for name, args, tag in body["methodResponses"]:
        if name == "error":
            raise RuntimeError(f"{tag}: {args}")
        out[tag] = args
    return out


def walk(source):
    """Yield (folder, path) for every message file, in a stable order."""
    for user in sorted(os.listdir(source)):
        user_dir = os.path.join(source, user)
        if not os.path.isdir(user_dir):
            continue
        for folder in sorted(os.listdir(user_dir)):
            folder_dir = os.path.join(user_dir, folder)
            if not os.path.isdir(folder_dir):
                continue
            for root, _dirs, files in os.walk(folder_dir):
                for name in sorted(files):
                    yield folder.lower(), os.path.join(root, name)


def existing_message_ids(account):
    seen, position = set(), 0
    while True:
        r = jmap([
            ["Email/query", {"accountId": account, "position": position, "limit": 1000}, "q"],
            ["Email/get", {"accountId": account, "#ids": {"resultOf": "q", "name": "Email/query", "path": "/ids"}, "properties": ["messageId"]}, "g"],
        ])
        for e in r["g"]["list"]:
            seen.update(e.get("messageId") or [])
        if len(r["q"]["ids"]) < 1000:
            return seen
        position += 1000


def mailboxes(account):
    r = jmap([["Mailbox/get", {"accountId": account, "ids": None}, "m"]])
    by_role = {m["role"]: m["id"] for m in r["m"]["list"] if m.get("role")}
    by_name = {m["name"]: m["id"] for m in r["m"]["list"] if not m.get("role")}
    return by_role, by_name


def ensure_label(account, by_name, name):
    if name not in by_name:
        r = jmap([["Mailbox/set", {"accountId": account, "create": {"x": {"name": name}}}, "c"]])
        by_name[name] = r["c"]["created"]["x"]["id"]
    return by_name[name]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="the corpus's maildir/ directory")
    ap.add_argument("--count", type=int, default=50000)
    ap.add_argument("--spread-days", type=int, default=730)
    args = ap.parse_args()

    session = http("/jmap/session")
    account = session["primaryAccounts"]["urn:ietf:params:jmap:mail"]
    upload_path = "/jmap/upload/" + account + "/"
    by_role, by_name = mailboxes(account)
    seen = existing_message_ids(account)
    print(f"bulk: carol has {len(seen)} messages; target {args.count}", flush=True)

    now = datetime.now(timezone.utc).replace(microsecond=0)
    step = timedelta(days=args.spread_days) / max(args.count, 1)
    pending, total, skipped, failed = {}, len(seen), 0, 0

    def flush():
        nonlocal total, failed
        if not pending:
            return
        r = jmap([["Email/import", {"accountId": account, "emails": pending}, "i"]])
        total += len(r["i"].get("created") or {})
        failed += len(r["i"].get("notCreated") or {})
        pending.clear()
        print(f"bulk: {total}/{args.count} (skipped {skipped}, failed {failed})", flush=True)

    for n, (folder, path) in enumerate(walk(args.source)):
        if total + len(pending) >= args.count:
            break
        with open(path, "rb") as f:
            raw = f.read()
        try:
            msg = email.message_from_bytes(raw, policy=email.policy.compat32)
        except Exception:
            failed += 1
            continue
        mid = (msg.get("Message-ID") or "").strip().strip("<>")
        if not mid or mid in seen:
            skipped += 1
            continue
        seen.add(mid)
        if folder in SENT_FOLDERS:
            box, keywords = by_role["sent"], {"$seen": True}
        elif folder in INBOX_FOLDERS or len(by_name) >= MAX_LABELS and folder not in by_name:
            box, keywords = by_role["inbox"], ({} if n % 5 == 0 else {"$seen": True})
        else:
            box, keywords = ensure_label(account, by_name, folder), {"$seen": True}
        # Newest first in walk order would cluster one user's mail; spread evenly across the window instead.
        received = now - step * ((n * 7919) % args.count)
        blob = http(upload_path, raw, "message/rfc822")
        pending[f"m{n}"] = {"blobId": blob["blobId"], "mailboxIds": {box: True}, "keywords": keywords, "receivedAt": received.strftime("%Y-%m-%dT%H:%M:%SZ")}
        if len(pending) >= BATCH:
            flush()
    flush()
    print(f"bulk: done, {total} messages (skipped {skipped}, failed {failed})", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
