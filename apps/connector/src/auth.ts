import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";

export function tokensMatch(presented: string, expected: string): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

export function bearerToken(header: string | undefined): string {
  if (!header?.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length).trim();
}

export function authMiddleware(expectedToken: string, allowedOrigins: string[]) {
  return async (c: Context, next: Next) => {
    if (c.req.path === "/health") return next();
    const origin = c.req.header("origin");
    if (origin && !allowedOrigins.includes(origin)) {
      return c.json(
        {
          error: {
            code: "ORIGIN_REJECTED",
            message: "This runtime only accepts the local Prentice UI.",
            retryable: false,
          },
        },
        403,
      );
    }
    if (!tokensMatch(bearerToken(c.req.header("authorization")), expectedToken)) {
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "The local runtime session is missing or expired. Restart Prentice and reload the UI.",
            retryable: true,
          },
        },
        401,
      );
    }
    return next();
  };
}
