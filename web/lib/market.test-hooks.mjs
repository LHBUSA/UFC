/* `server-only` throws by design anywhere outside a React Server Component.
   market.ts is server-only for real reasons and should stay that way, but the
   price maths inside it is pure and worth testing, so the marker resolves to
   an empty module for the test run and only for the test run. */
export async function resolve(specifier, context, next) {
  if (specifier === 'server-only') return { url: 'data:text/javascript,export{}', shortCircuit: true };
  return next(specifier, context);
}
