import { execFileSync } from 'node:child_process';

// Accounts of a test's own, made and removed with Stalwart's CLI as deploy/seed.sh does.
const cli = (args: string[], input?: string) =>
  execFileSync('docker', [
    'run', '--rm', '-i', '--network', 'oinbox_default',
    '-e', 'STALWART_URL=http://stalwart:8080', '-e', 'STALWART_USER=admin', '-e', 'STALWART_PASSWORD=oinbox-admin-pass',
    'stalwartlabs/cli:1.0.12', ...args,
  ], { input, encoding: 'utf8' });

/** A user at example.test with nothing in the mailbox. For tests that would break alice for the others. */
export function createAccount(name: string, password: string): void {
  const domain = { '@type': 'upsert', object: 'Domain', matchOn: ['name'], value: { 'dom-e2e': { name: 'example.test' } } };
  const account = {
    '@type': 'upsert', object: 'Account', matchOn: ['name', 'domainId'],
    value: {
      'acct-e2e': {
        '@type': 'User', name, domainId: '#dom-e2e', description: 'e2e throwaway',
        credentials: { 0: { '@type': 'Password', secret: password } },
        roles: { '@type': 'User' }, permissions: { '@type': 'Inherit' }, encryptionAtRest: { '@type': 'Disabled' },
      },
    },
  };
  cli(['apply', '--stdin', '--quiet'], `${JSON.stringify(domain)}\n${JSON.stringify(account)}\n`);
}

export function deleteAccount(name: string): void {
  const line = cli(['query', 'Account', '--json']).split('\n').find((l) => l.includes(`"emailAddress":"${name}@example.test"`));
  const id = line?.match(/"id":"([^"]*)"/)?.[1];
  if (id) cli(['delete', 'Account', '--ids', id]);
}
