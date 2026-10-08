import { fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal, ErrorBoundary } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { PaneBoundary } from './PaneBoundary';
import { RootFallback } from './RootFallback';

function Bomb(props: { armed: () => boolean; value?: unknown }) {
  return (
    <>
      {(() => {
        if (props.armed()) throw props.value ?? new Error('kaboom');
        return <p>fine</p>;
      })()}
    </>
  );
}

describe('PaneBoundary', () => {
  it('shows a fallback for its pane only, and recovers on Try again', async () => {
    const report = vi.fn();
    const [armed, setArmed] = createSignal(true);
    render(() => (
      <>
        <p>sibling</p>
        <PaneBoundary name="list" report={report}>
          <Bomb armed={armed} />
        </PaneBoundary>
      </>
    ));
    expect(screen.getByRole('alert')).toHaveTextContent('This part of oinbox hit a problem.');
    expect(screen.getByText('sibling')).toBeInTheDocument();
    expect(report).toHaveBeenCalledWith(expect.any(Error), 'list');
    expect(screen.getByText(/kaboom/)).toBeInTheDocument();
    setArmed(false);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('fine')).toBeInTheDocument();
  });

  it('renders for a thrown value that is not an Error', () => {
    render(() => (
      <PaneBoundary name="x" report={() => {}}>
        <Bomb armed={() => true} value="just a string" />
      </PaneBoundary>
    ));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/just a string/)).toBeInTheDocument();
  });

  it('shows nothing when silent', () => {
    const { container } = render(() => (
      <PaneBoundary name="invite" silent report={() => {}}>
        <Bomb armed={() => true} />
      </PaneBoundary>
    ));
    expect(container).toBeEmptyDOMElement();
  });

  it('lets the root fallback take over when reporting itself throws', () => {
    render(() => (
      <ErrorBoundary fallback={(e) => <RootFallback error={e} />}>
        <PaneBoundary name="x" report={() => { throw new Error('reporter broke'); }}>
          <Bomb armed={() => true} />
        </PaneBoundary>
      </ErrorBoundary>
    ));
    expect(screen.getByText('oinbox hit a problem and needs to reload.')).toBeInTheDocument();
  });
});
