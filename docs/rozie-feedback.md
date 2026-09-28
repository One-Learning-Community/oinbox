

## Popover 0.2.4 — no external or virtual anchor
Wanted: open event details next to a FullCalendar event element that the popover doesn't render.
Popover measures only its own `.rozie-popover-anchor` wrapper (filled by `anchorSlot`); there's no
`anchor` prop taking an element or a floating-ui virtual element (`getBoundingClientRect`).
Workaround (`src/ui/CalendarView.tsx` `EventPopover`): a `position: fixed` wrapper div (Popover's props
don't accept `class`/`style`) sized to the clicked event's rect, with the anchor stretched to fill it
and an empty anchor slot, mounted fresh per click. Suggest an `anchor`
prop accepting `Element | { getBoundingClientRect(): DOMRect }`. Related: FullCalendar's
`eventClick` payload drops `info.el`, so the element is recovered via `jsEvent.target.closest('.fc-event')`.
