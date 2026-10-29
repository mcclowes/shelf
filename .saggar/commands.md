# Commands

- Test: `npm run test` — CLI and isolated release-packaging regressions #quick #safe #ci
- Typecheck: `npm run check` #quick #safe #ci
- Lint: `npm run lint` #quick #safe #ci
- Build: `npm run build` #quick #safe #ci
- Release notes: `node scripts/release-notes.mjs 0.4.0` — Extract this version's changelog notes; rejects missing or empty sections #quick #safe
- Check version: `node scripts/check-version.mjs` — Compare the exported contract version with package.json #quick #safe #ci
- Inspect schema: `node dist/main.js schema` — Print the built CLI's offline contract; run Build first #quick #safe #ci
- Package release: `node scripts/package-release.mjs` — Create or replace the local release archive and checksum; run Build first #quick #writes #ci

Run these commands from the repository root with Node.js 24 or later. Build
requires the development dependencies to be installed. Build generates `dist/`,
which must exist before inspecting the built schema or packaging. Packaging
also requires `tar`.

Packaging stages the archive and computes its checksum before replacing
`release/shelf-VERSION.tar.gz` and `release/shelf-VERSION.tar.gz.sha256`. These
are local generated outputs. Saved repository configuration and index data live
separately in `~/.config/shelf` (or `SHELF_HOME`).

- Coverage gate: `npm run test:coverage` - Run source and script tests and enforce coverage floors for loaded CLI source. #quick #safe #ci
