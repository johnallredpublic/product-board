import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { generateKeyPair, exportJWK, SignJWT, type KeyLike } from 'jose'
import { resolveAuth } from '../src/auth.js'

// Verifies the JWKS signature path (ADR 0020). Stands up a tiny local HTTP server
// that serves the public JWKS, signs tokens with the matching private key, and drives
// resolveAuth in the non-dev branch. No AWS, no network beyond localhost.

const KID = 'test-key-1'
const ISSUER = 'https://issuer.test/'
const AUDIENCE = 'assortment'

let priv: KeyLike
let jwksServer: Server
let jwksUrl: string
const savedEnv = { ...process.env }

const req = (auth?: string) =>
  ({ headers: auth ? { authorization: auth } : {} }) as any

const sign = (claims: Record<string, unknown>, key: KeyLike = priv) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('5m')
    .sign(key)

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  priv = pair.privateKey
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' }

  jwksServer = createServer((_r, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ keys: [jwk] }))
  })
  await new Promise<void>(r => jwksServer.listen(0, '127.0.0.1', r))
  const addr = jwksServer.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  jwksUrl = `http://127.0.0.1:${port}/.well-known/jwks.json`
})

afterAll(() => {
  jwksServer?.close()
})

// Each test drives the prod (non-dev) path: LOCAL is set globally by vitest.config,
// so remove it here and restore afterward.
afterEach(() => {
  process.env = { ...savedEnv }
})

function prodAuthEnv() {
  delete process.env.LOCAL
  delete process.env.AUTH_MODE
  process.env.JWKS_URI = jwksUrl
  process.env.JWT_ISSUER = ISSUER
  process.env.JWT_AUDIENCE = AUDIENCE
}

describe('resolveAuth — JWKS verification', () => {
  it('accepts a properly signed token and maps its claims', async () => {
    prodAuthEnv()
    const token = await sign({ 'custom:tenantId': 'acme', sub: 'user-42' })
    const ctx = await resolveAuth(req(`Bearer ${token}`))
    expect(ctx).toEqual({ tenantId: 'acme', userId: 'user-42' })
  })

  it('rejects a token signed by a different (attacker) key', async () => {
    prodAuthEnv()
    const attacker = (await generateKeyPair('RS256')).privateKey
    const forged = await sign({ 'custom:tenantId': 'acme', sub: 'evil' }, attacker)
    await expect(resolveAuth(req(`Bearer ${forged}`))).rejects.toThrow(/invalid token/)
  })

  it('rejects a tampered payload (signature no longer matches)', async () => {
    prodAuthEnv()
    const token = await sign({ 'custom:tenantId': 'acme', sub: 'user-42' })
    const [h, , s] = token.split('.')
    const evilPayload = Buffer.from(JSON.stringify({ 'custom:tenantId': 'victim', sub: 'evil' })).toString('base64url')
    await expect(resolveAuth(req(`Bearer ${h}.${evilPayload}.${s}`))).rejects.toThrow(/invalid token/)
  })

  it('rejects the wrong audience', async () => {
    prodAuthEnv()
    const token = await new SignJWT({ 'custom:tenantId': 'acme', sub: 'u' })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuedAt().setIssuer(ISSUER).setAudience('some-other-app').setExpirationTime('5m')
      .sign(priv)
    await expect(resolveAuth(req(`Bearer ${token}`))).rejects.toThrow(/invalid token/)
  })

  it('rejects a request with no bearer token', async () => {
    prodAuthEnv()
    await expect(resolveAuth(req())).rejects.toThrow(/missing bearer token/)
  })

  it('fails closed when JWKS is not configured', async () => {
    delete process.env.LOCAL
    delete process.env.AUTH_MODE
    delete process.env.JWKS_URI
    const token = await sign({ 'custom:tenantId': 'acme', sub: 'u' })
    await expect(resolveAuth(req(`Bearer ${token}`))).rejects.toThrow(/not configured/)
  })

  it('accepts a token missing tenant/user claims as unauthorized', async () => {
    prodAuthEnv()
    const token = await sign({ sub: 'u-only' }) // no tenantId
    await expect(resolveAuth(req(`Bearer ${token}`))).rejects.toThrow(/missing tenant\/user/)
  })

  it('dev mode still trusts headers (no token needed)', async () => {
    process.env.LOCAL = '1'
    const ctx = await resolveAuth({ headers: { 'x-tenant-id': 't', 'x-user-id': 'u' } } as any)
    expect(ctx).toEqual({ tenantId: 't', userId: 'u' })
  })
})
