export interface WsConnectionTracker {
  tryAcquire(ip: string, max: number): boolean;
  release(ip: string): void;
  count(ip: string): number;
}

export function createWsConnectionTracker(): WsConnectionTracker {
  const counts = new Map<string, number>();

  return {
    tryAcquire(ip: string, max: number): boolean {
      const current = counts.get(ip) ?? 0;
      if (current >= max) {
        return false;
      }
      counts.set(ip, current + 1);
      return true;
    },
    release(ip: string): void {
      const current = counts.get(ip);
      if (current === undefined) {
        return;
      }
      if (current <= 1) {
        counts.delete(ip);
        return;
      }
      counts.set(ip, current - 1);
    },
    count(ip: string): number {
      return counts.get(ip) ?? 0;
    },
  };
}
