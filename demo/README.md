# Demo data

Place the simulation data file for the live GitHub Pages demo here:

- `demo.json.gz` (gzipped JSON) **or** `demo.json` (plain JSON)

The [`demo.yml`](../.github/workflows/demo.yml) GitHub Actions workflow reads
whichever file is present, starts a local `SimViewServer`, dumps the
`/model`, `/states`, and `/blob/*` responses as static files, then deploys
the result to `gh-pages` under `demo/`.

On every subsequent push that touches `simview/**` or `demo/**` the demo is
rebuilt automatically, so the live demo always reflects the current state of
the code.
