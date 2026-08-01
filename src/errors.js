export class HttpError extends Error {
  constructor(status, message, code = "REQUEST_FAILED", details = undefined) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
