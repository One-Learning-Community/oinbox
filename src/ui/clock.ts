import { createSignal } from 'solid-js';

const [now, setNow] = createSignal(new Date());
setInterval(() => setNow(new Date()), 60_000);

/** The current time, refreshed every minute, for text that depends on a day boundary. */
export { now };
