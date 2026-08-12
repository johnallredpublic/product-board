import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { UnauthorizedError } from './errors.js'

// Who the caller is. The tenant ALWAYS comes from the VERIFIED identity, never from
// a request parameter — that's what prevents cross-tenant (BOLA) access (ADR 0015).
export interface AuthContext {
  tenantId: string
  userId: string
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext
  }
}

// Config is read lazily (per call) so tests can set env after import and so a
// misconfigured prod fails at request time with a clear message, not at boot.
const isDev = () => !!process.env.LOCAL || process.env.AUTH_MODE === 'dev'

// A remote JWKS set: jose fetches the IdP's public keys, caches them by `kid`, and
// refreshes on rotation. Cache by URI so a changed JWKS_URI (tests) rebuilds it.
let jwksCache: { uri: string; jwks: ReturnType<typeof createRemoteJWKSet> } | undefined
function getJwks() {
  const uri = process.env.JWKS_URI
  if (!uri) {
    // Fail CLOSED: a non-dev deployment with no JWKS configured must reject requests
    // rather than fall back to trusting unverified tokens.
    throw new UnauthorizedError('auth is not configured (JWKS_URI is required outside dev)')
  }
  if (jwksCache?.uri !== uri) jwksCache = { uri, jwks: createRemoteJWKSet(new URL(uri)) }
  return jwksCache.jwks
}

/**
 * Verify a bearer token's SIGNATURE against the IdP's JWKS (plus optional issuer /
 * audience checks), then return its claims. This is the hardening over the previous
 * decode-only path — an attacker can no longer forge a token by editing the payload.
 */
async function verifiedClaims(token: string): Promise<Record<string, unknown>> {
  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: process.env.JWT_ISSUER,     // undefined → check skipped
      audience: process.env.JWT_AUDIENCE, // undefined → check skipped
    })
    return payload as Record<string, unknown>
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err // config error — surface as-is
    throw new UnauthorizedError('invalid token')
  }
}

export async function resolveAuth(req: FastifyRequest): Promise<AuthContext> {
  // Local dev accepts headers (or defaults) so the app + seeds work without a real
  // IdP. Any non-dev environment requires a verified bearer token.
  if (isDev()) {
    return {
      tenantId: (req.headers['x-tenant-id'] as string | undefined) ?? 'dev-tenant',
      userId: (req.headers['x-user-id'] as string | undefined) ?? 'dev-user',
    }
  }

  const header = req.headers['authorization']
  if (!header?.startsWith('Bearer ')) throw new UnauthorizedError('missing bearer token')

  const claims = await verifiedClaims(header.slice('Bearer '.length))
  const tenantId = (claims['custom:tenantId'] ?? claims['tenantId']) as string | undefined
  const userId = claims['sub'] as string | undefined
  if (!tenantId || !userId) throw new UnauthorizedError('token missing tenant/user')

  return { tenantId, userId }
}

/** Resolve the caller's identity on every request and hang it on `req.auth`. */
export function registerAuth(app: FastifyInstance) {
  app.decorateRequest('auth', null as unknown as AuthContext)
  app.addHook('onRequest', async (req) => {
    req.auth = await resolveAuth(req)
  })
}
