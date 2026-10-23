import { fireEvent, render } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';
import { EmailLinksSection } from './EmailLinksSection';

describe('EmailLinksSection', () => {
  it('asks the browser to send email links to /compose', () => {
    const calls: [string, string][] = [];
    const { getByRole } = render(() => <EmailLinksSection nav={{ registerProtocolHandler: (s, u) => calls.push([s, u]) }} />);
    fireEvent.click(getByRole('button', { name: 'Open email links in oinbox' }));
    expect(calls).toEqual([['mailto', `${location.origin}/compose?mailto=%s`]]);
    expect(getByRole('status')).toHaveTextContent('Your browser should now ask you to allow it');
  });
  it('says so when the browser refuses', () => {
    const nav = {
      registerProtocolHandler: () => {
        throw new DOMException('insecure', 'SecurityError');
      },
    };
    const { getByRole } = render(() => <EmailLinksSection nav={nav} />);
    fireEvent.click(getByRole('button'));
    expect(getByRole('alert')).toHaveTextContent('Your browser refused');
  });
  it('offers no button where the browser cannot do it', () => {
    const { queryByRole, getByText } = render(() => <EmailLinksSection nav={{}} />);
    expect(queryByRole('button')).toBeNull();
    expect(getByText("This browser can't open email links in oinbox.")).toBeInTheDocument();
  });
});
