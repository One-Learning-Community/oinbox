# Security

oinbox displays mail, which is content written by strangers. Reports of ways that content, or another website, can get at a user's mail or session are very welcome.

## Reporting a vulnerability

Please report privately through GitHub: **Security › Report a vulnerability** on this repository. Do not open a public issue for a suspected vulnerability.

Say what you found, how to reproduce it (a sample message is ideal), and the version shown at the bottom of Settings. You should hear back within a week.

## Supported versions

The latest release. While oinbox is in beta there are no maintained older versions.

## In scope

- Getting script to run, or data to leave, from a displayed message: the HTML sanitizer, the message frame and its Content-Security-Policy, remote-image blocking, links and attachments.
- The sign-in flow and how tokens are stored and renewed.
- Anything that lets another origin read from or act on a user's session.
- The proxy and server configuration shipped in `deploy/` (the routing, the headers, the production template).

## Out of scope

- Stalwart itself: report those to [Stalwart](https://github.com/stalwartlabs/stalwart/security).
- The development stack in `deploy/` (plain HTTP, fixed test passwords, permissive CORS). It is for local testing only.
- Attacks that need a compromised browser, operating system or mail server.

## How oinbox protects a message's reader

- **Sanitizing.** Message HTML goes through DOMPurify with a restricted set of elements and attributes before it is shown.
- **A frame that runs nothing.** The result is rendered in a sandboxed `<iframe srcdoc>` without `allow-scripts`, so even markup the sanitizer missed cannot execute. The frame carries its own Content-Security-Policy on top of the page's.
- **No remote content by default.** Images and other remote resources are blocked until the reader allows them for that message or that sender, so opening a message tells its sender nothing.
- **A strict page policy.** The app is served with `default-src 'self'`, `script-src 'self'`, `connect-src 'self'`, `object-src 'none'`, `base-uri 'none'` and `frame-ancestors 'none'`. It loads nothing from third parties.
- **Sign-in.** OAuth 2 authorization code with PKCE as a public client; client and redirect URI must be registered in Stalwart. Access and refresh tokens are kept in the browser's `localStorage` for the origin, which the policy above is there to protect.
- **One origin.** oinbox is served from Stalwart's origin, and Stalwart's CORS stays off.
- **No telemetry.** Errors are shown to the user and written to the browser console. Nothing is sent anywhere but your mail server.
