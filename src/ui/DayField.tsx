import { DatePicker, type DatePickerHandle } from '@rozie-ui/date-picker-solid';
import { Popover } from '@rozie-ui/popover-solid';
import { createEffect, createSignal, on } from 'solid-js';

const dayLabel = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** A day, or the open choice (`empty`), picked from a calendar in a popover. */
export function DayField(props: { label: string; value: string | null; empty: string; min?: string; onChange: (day: string | null) => void }) {
  const [open, setOpen] = createSignal(false);
  let button: HTMLButtonElement | undefined;
  let picker: DatePickerHandle | undefined;

  createEffect(on(open, (isOpen) => {
    if (isOpen) queueMicrotask(() => picker?.focus());
  }, { defer: true }));

  const close = () => {
    setOpen(false);
    button?.focus();
  };

  const text = () => (props.value ? dayLabel(props.value) : props.empty);

  return (
    <div class="day-field">
      <span class="day-label">{props.label}</span>
      <Popover
        open={open()}
        onOpenChange={setOpen}
        trigger="manual"
        placement="bottom-start"
        strategy="fixed"
        offset={4}
        anchorSlot={() => (
          <button ref={button} type="button" class="btn tonal day-button" aria-label={`${props.label}: ${text()}`} aria-haspopup="dialog" aria-expanded={open()}
            onClick={() => setOpen(!open())}>
            {text()}
          </button>
        )}
      >
        <div
          class="day-popover"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
        >
          <DatePicker
            ref={(h: DatePickerHandle) => (picker = h)}
            value={props.value ?? ''}
            min={props.min}
            showFooter
            locale={navigator.language}
            labels={{ clear: props.empty, root: props.label }}
            onChange={(e: { value: string }) => {
              props.onChange(e.value || null);
              close();
            }}
          />
        </div>
      </Popover>
    </div>
  );
}
