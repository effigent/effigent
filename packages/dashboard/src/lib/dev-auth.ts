/**
 * Local-dev auth bypass. The live Clerk keys in .env.local refuse localhost,
 * so `EFFIGENT_DEV_NOAUTH=1 NEXT_PUBLIC_EFFIGENT_DEV_NOAUTH=1 npm run dev` renders the console without Clerk
 * (fake "Jane Doe · Admin" + a visible "DEV — auth bypassed" badge).
 *
 * The server decides (middleware + layouts) and hands the result to the client
 * shell as a prop, so the client never makes its own auth decision.
 *
 * Impossible in production: Next inlines `process.env.NODE_ENV` at build time,
 * so in `next build` output this is the literal `false && …` and the bypass
 * branch is dead code — no runtime env var can turn it back on.
 */
export const devNoAuth: boolean =
  process.env.NODE_ENV !== 'production' &&
  (process.env.EFFIGENT_DEV_NOAUTH === '1' || process.env.NEXT_PUBLIC_EFFIGENT_DEV_NOAUTH === '1');
