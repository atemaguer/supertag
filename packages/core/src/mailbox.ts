export class TagMessagingError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "TagMessagingError";
  }
}
