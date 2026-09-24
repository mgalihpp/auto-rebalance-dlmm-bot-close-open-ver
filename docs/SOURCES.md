# Sources

Local vendor files (do not delete):

- `docs/meteora-llms-full.txt`, Meteora DLMM SDK reference used for grounding.
- `docs/jupiter-llms-full.txt`, kept for the unbuilt Jupiter swap leg.

Installed SDK version verified against:

- `@meteora-ag/dlmm` 1.9.14 (`node_modules/@meteora-ag/dlmm/dist/index.d.ts`).
  Method signatures were read from that file, not guessed from prose docs.
  One packaging quirk found there: the package has no `"type"` field, so
  under `moduleResolution: NodeNext` tsc models its default export as the
  module namespace. `src/pool.ts` binds the class through a narrow
  structural interface instead.
