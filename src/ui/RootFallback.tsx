import { errorDetails } from '../app/errors';

/** Last resort. No app context, no rozie, no stylesheet classes: any of those may be what failed. */
export function RootFallback(props: { error: unknown }) {
  return (
    <div
      role="alert"
      style={{ 'max-width': '520px', margin: '15vh auto', padding: '24px', font: '16px/1.5 system-ui, sans-serif', color: 'CanvasText', background: 'Canvas' }}
    >
      <p style={{ 'font-size': '18px', margin: '0 0 16px' }}>oinbox hit a problem and needs to reload.</p>
      <button type="button" style={{ font: 'inherit', padding: '8px 20px', 'min-height': '44px' }} onClick={() => location.reload()}>
        Reload
      </button>
      <details style={{ 'margin-top': '24px' }}>
        <summary>Details</summary>
        <pre style={{ 'white-space': 'pre-wrap', 'font-size': '12px' }}>{errorDetails(props.error)}</pre>
      </details>
    </div>
  );
}
