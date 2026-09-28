#!/usr/bin/env python3
"""Seed alice's calendars for the dev stack (idempotent).

Events sit in the current week (starting Sunday, FullCalendar's default firstDay) and are moved
back into it on every run, matched by a fixed uid. Nothing is ever duplicated.

Stalwart 0.16 specifics (probed 2026-09-28):
* JSCalendar "bis" field names: singular `recurrenceRule`; participants use `calendarAddress`
  and the organizer `organizerCalendarAddress`. The older `email`/`sendTo` are silently dropped.
* The CalendarEvent/query `uid` filter matches nothing, so events are listed and matched here.
* `sendSchedulingMessages: false` keeps the seed from emailing invitations to bob.
"""
import base64
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

JMAP_BASE = os.environ.get("JMAP_BASE", "http://stalwart:8080")
PASSWORD = os.environ.get("SEED_PASSWORD", "oinbox-dev-pass")
ALICE = "alice@example.test"
BOB = "bob@example.test"
CALENDARS = "urn:ietf:params:jmap:calendars"
USING = ["urn:ietf:params:jmap:core", CALENDARS]
NY = "America/New_York"
TEAM_COLOR = "#0b8043"


def _auth():
    return "Basic " + base64.b64encode(f"{ALICE}:{PASSWORD}".encode()).decode()


def jmap(calls):
    req = urllib.request.Request(
        f"{JMAP_BASE}/jmap/",
        data=json.dumps({"using": USING, "methodCalls": calls}).encode(),
        headers={"Authorization": _auth(), "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as r:
        body = json.load(r)
    for name, args, tag in body["methodResponses"]:
        if name == "error":
            raise SystemExit(f"JMAP error in {tag}: {args}")
        for key in ("notCreated", "notUpdated", "notDestroyed"):
            if args.get(key):
                raise SystemExit(f"JMAP {name} {key}: {args[key]}")
    return {tag: args for _, args, tag in body["methodResponses"]}


def account():
    req = urllib.request.Request(f"{JMAP_BASE}/jmap/session", headers={"Authorization": _auth()})
    with urllib.request.urlopen(req) as r:
        return json.load(r)["primaryAccounts"][CALENDARS]


def week_start():
    # US Eastern "today" (fixed -5h; within an hour of midnight during DST it may pick the
    # neighbouring day, which only matters for a seed run at that exact time).
    today = (datetime.now(timezone.utc) - timedelta(hours=5)).date()
    return today - timedelta(days=(today.weekday() + 1) % 7)


def at(day, hhmm="00:00"):
    return f"{day.isoformat()}T{hhmm}:00"


def person(name, email, status, owner=False):
    roles = {"attendee": True, **({"owner": True} if owner else {})}
    return {"@type": "Participant", "name": name, "calendarAddress": f"mailto:{email}",
            "roles": roles, "participationStatus": status}


def events(sun, default_cal, team_cal):
    def d(n):
        return sun + timedelta(days=n)

    def timed(cal, title, day, hhmm, duration, tz=NY, **extra):
        return {"calendarIds": {cal: True}, "title": title, "start": at(day, hhmm),
                "timeZone": tz, "duration": duration, **extra}

    def all_day(cal, title, day, days):
        # Floating (no timeZone key): the event keeps its date wherever the viewer is.
        return {"calendarIds": {cal: True}, "title": title, "start": at(day),
                "showWithoutTime": True, "duration": f"P{days}D"}

    sync_first = d(1) - timedelta(days=14)
    return {
        "design-review": timed(
            default_cal, "Design review", d(1), "10:00", "PT1H",
            description="Walk through the new inbox layout.",
            locations={"l1": {"@type": "Location", "name": "Room 4"}},
            organizerCalendarAddress=f"mailto:{ALICE}",
            participants={"alice": person("Alice Example", ALICE, "accepted", owner=True),
                          "bob": person("Bob Example", BOB, "needs-action")}),
        "one-on-one": timed(team_cal, "1:1 with Bob", d(2), "14:00", "PT30M"),
        "sprint-planning": timed(team_cal, "Sprint planning", d(3), "13:00", "PT1H30M"),
        "london-call": timed(default_cal, "Call with London office", d(3), "15:00", "PT45M", tz="Europe/London"),
        "release-freeze": all_day(default_cal, "Release freeze", d(2), 1),
        "team-offsite": all_day(team_cal, "Team offsite", d(4), 2),
        # The moved occurrence overrides only `start`: Stalwart then returns it without a title
        # and with a bogus duration, which the client must repair from the base event.
        "weekly-sync": timed(
            default_cal, "Weekly sync", sync_first, "09:30", "PT30M",
            recurrenceRule={"@type": "RecurrenceRule", "frequency": "weekly"},
            recurrenceOverrides={at(d(1), "09:30"): {"start": at(d(1), "11:00")},
                                 at(d(8), "09:30"): {"excluded": True}}),
    }


def main():
    acct = account()
    cals = jmap([["Calendar/get", {"accountId": acct}, "c"]])["c"]["list"]
    default_cal = next((c["id"] for c in cals if c.get("isDefault")), cals[0]["id"])
    team_cal = next((c["id"] for c in cals if c["name"] == "Team"), None)
    if team_cal is None:
        r = jmap([["Calendar/set", {"accountId": acct, "create": {"t": {"name": "Team", "color": TEAM_COLOR}}}, "s"]])
        team_cal = r["s"]["created"]["t"]["id"]

    listed = jmap([
        ["CalendarEvent/query", {"accountId": acct}, "q"],
        ["CalendarEvent/get", {"accountId": acct, "#ids": {"resultOf": "q", "name": "CalendarEvent/query", "path": "/ids"},
                               "properties": ["uid"]}, "g"],
    ])["g"]["list"]
    by_uid = {e.get("uid"): e["id"] for e in listed}

    sun = week_start()
    create, update = {}, {}
    for i, (key, ev) in enumerate(events(sun, default_cal, team_cal).items()):
        uid = f"oinbox-seed-{key}@example.test"
        if uid in by_uid:
            update[by_uid[uid]] = ev
        else:
            create[f"e{i}"] = {**ev, "uid": uid}
    jmap([["CalendarEvent/set", {"accountId": acct, "sendSchedulingMessages": False,
                                 "create": create, "update": update}, "s"]])
    print(f"seed: calendar: {len(create)} events created, {len(update)} moved to the week of {sun.isoformat()}")


if __name__ == "__main__":
    sys.exit(main())
