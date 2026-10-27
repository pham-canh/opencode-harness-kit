# Contributing

Run `npm run check` before pushing. Driver changes need `npm test`; loop
behaviour changes also need `npm run gate:loop`. V2 changes need
`npm run gate:v2` on a 2.x binary.

Do not add runtime dependencies. Keep `.space/` writes atomic and redacted.
