export declare function release(
  args: string[],
  dependencies?: {
    run?: (command: string, args: string[]) => string;
    pause?: (ms: number) => Promise<void>;
    now?: () => number;
    registry?: (name: string, version: string) => Promise<boolean>;
    log?: (message: string) => void;
  },
): Promise<void>;
