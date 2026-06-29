type Resolver = (accessToken: string) => void;

const pending = new Map<string, Resolver>();

export function waitForOAuth(
  discordId: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(discordId);
      reject(new Error('Authorization timed out'));
    }, timeoutMs);

    pending.set(discordId, (accessToken) => {
      clearTimeout(timer);
      resolve(accessToken);
    });
  });
}

export function resolveOAuth(
  discordId: string,
  accessToken: string,
): boolean {
  const resolve = pending.get(discordId);
  if (resolve) {
    pending.delete(discordId);
    resolve(accessToken);
    return true;
  }
  return false;
}
