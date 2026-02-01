export {};

declare global {
  interface Window {
    openai?: {
      toolOutput?: unknown;
    };
  }
}
