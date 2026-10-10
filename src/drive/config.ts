/** Whether this installation has a Drive (an OpenCloud behind /drive), as the operator set it (docs/operating.md, "Drive"). */
export interface DriveConfig {
  enabled: boolean;
  /** Offer a link when a message's attachments pass this many megabytes. */
  linkOverMb: number;
}

export const NO_DRIVE: DriveConfig = { enabled: false, linkOverMb: 20 };

type Fetcher = (url: string) => Promise<Response>;

export function parseDriveConfig(raw: unknown): DriveConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return NO_DRIVE;
  const o = raw as Record<string, unknown>;
  // The server writes the operator's setting as text (deploy/routes.caddy), so that a slip in it costs the threshold and not Drive.
  const mb = typeof o.linkOverMb === 'string' && o.linkOverMb.trim() ? Number(o.linkOverMb) : o.linkOverMb;
  return {
    enabled: o.enabled === true,
    linkOverMb: typeof mb === 'number' && Number.isFinite(mb) && mb > 0 ? mb : NO_DRIVE.linkOverMb,
  };
}

/**
 * Read /drive.json. Anything but a readable answer means no Drive. Unlike the branding it is not
 * remembered between visits: a Drive that was switched off must disappear.
 */
export async function loadDriveConfig(fetcher: Fetcher): Promise<DriveConfig> {
  try {
    const res = await fetcher('/drive.json');
    return res.ok ? parseDriveConfig(await res.json()) : NO_DRIVE;
  } catch {
    return NO_DRIVE;
  }
}
