const MAX_DISPLAY_NAME_LENGTH = 100;

export function validateDisplayName(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('Display name must be a string');
  const displayName = value.trim();
  if (!displayName) return null;
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new Error(`Display name must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(displayName)) {
    throw new Error('Display name contains invalid control characters');
  }
  return displayName;
}

export function formatFromHeader(address: string, displayName: string | null): string {
  return displayName ? `${displayName} <${address}>` : address;
}
