/** Domain errors the route layer maps to HTTP status codes. */

export class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}
