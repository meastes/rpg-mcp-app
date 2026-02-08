export {};

declare global {
  interface Window {
    openai?: {
      toolOutput?: unknown;
      sendFollowUpMessage?: (
        args: { prompt: string } | string
      ) => Promise<unknown> | unknown;
    };
  }
}
