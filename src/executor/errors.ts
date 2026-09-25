/** Executor-owned failure. Messages are fixed text and never carry secret material. */
export class LocalExecutorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LocalExecutorError";
    this.code = code;
  }
}
