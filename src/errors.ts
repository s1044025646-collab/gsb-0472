export type ErrorCode =
  | "INVALID_PATTERN"
  | "CONSECUTIVE_DIGITS"
  | "NO_LETTERS"
  | "MISPLACED_DOT"
  | "INVALID_WORD"
  | "INVALID_BOUNDS"
  | "NOT_FOUND"
  | "DUPLICATE_EXCEPTION"
  | "LIMIT_EXCEEDED"
  | "BAD_REQUEST";

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status = 400
  ) {
    super(message);
  }
}
