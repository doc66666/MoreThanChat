export {}

declare global {
  interface Window {
    moreThanChat: {
      loadState(): Promise<unknown | null>
      saveState(value: unknown): Promise<void>
      getAppInfo(): Promise<{ version: string; platform: string }>
    }
  }
}
