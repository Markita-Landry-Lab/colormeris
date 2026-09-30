# Colormeris: notes for Claude sessions

Colormeris is a static web app (Landry lab, UC Berkeley) that turns colors in scientific figures back into numbers. It has two tools: **heatmap** (one value per grid cell) and **IVIS** (signal inside regions on in vivo luminescence images). It also has an **agent layer**: a typed API plus an LLM + decision-model (Jev) agent that calibrates heatmaps by itself. Start with [README.md](README.md) for users and [docs/agent.md](docs/agent.md) for the agent. [docs/research.md](docs/research.md) has the literature, novelty and experiment plan.

## Commands

```bash
npm test          # node:test unit tests, no dependencies (must pass before commits)
npm run serve     # python3 -m http.server 8000 → http://localhost:8000/app.html#heatmap
npm run proxy     # OpenRouter proxy on :8787 that adds the key from .env
npm run docs      # regenerate docs/agent.md (a test fails if it is stale)
node scripts/bundle-openrouter.mjs   # rebuild the vendored OpenRouter SDK bundle
node scripts/embed-pdfjs.mjs         # rebuild the pdf.js embed after updating pdf.js
```

`.claude/launch.json` has the preview configs `colormeris` (port 8000) and `openrouter-proxy` (port 8787). Start them with preview_start, not Bash.

## Secrets: read first

- The user's OpenRouter key is in `.env` as `OPENROUTER_API_KEY`. `.env` and `.env.*` are git-ignored, and the key has never been committed.
- Never print, `cat` or echo `.env`. To see which variables it has, use `sed -E 's/=.*/=<redacted>/' .env`.
- Never type the key into the browser, a URL or a tool call. For real agent runs, start the `openrouter-proxy` preview and set the Agent card's *API base URL* to `http://localhost:8787/api/v1`, leaving the key field empty. The proxy (`scripts/openrouter-proxy.mjs`) adds the key itself. It refuses non-localhost Origins, `Origin: null` (sandboxed iframes) and non-localhost Host headers (DNS rebinding).
- Before every commit: `git diff --cached | grep -E "sk-or-[A-Za-z0-9]{20,}"` must print nothing.
- Real runs cost the user money: about $0.2–0.8 per page with Claude Sonnet 5.5. Use small `Max. steps` and a single page.

## Architecture

There is no build step. Pages load plain classic scripts (not modules, so `file://` works) that register on `globalThis.Colormeris` (`CM`) with the pattern `(function (CM) { … Object.assign(CM, {…}); })((globalThis.Colormeris ??= {}));`. Load order is in `app.html` and matters. Pure files are also imported by the Node tests through `tests/load.js`.

| Layer | Files |
| --- | --- |
| Color, geometry, sampling (pure) | `color.js`, `grid.js` (bilinear grid, `detectGridSize`), `colormap.js`, `extract.js`, `roi.js`, `quantify.js` |
| Project model and files (pure) | `state.js` (`project.json` schema v2, panels incl. `review`), `export.js` (CSV, zip) |
| UI shell | `workspace.js` (pages, panels, grid/colorbar placement, undo, zip, tool switching; `ws` object with hooks), `viewer.js`, `loader.js` (pdf.js) |
| Tools | `heatmap.js`, `ivis.js`, registered with `ws.addTool` (see TOOL_HOOKS at the top of `workspace.js`) |
| Agent API | `agent-schema.js` (pure: action catalogue as JSON Schema, `validate`, `normalizeArgs`, state snapshot, typed questions `openQuestions`, `resultKeyHash`) and `agent.js` (binds it to the workspace as `window.colormeris`: `run`, `batch`, `tools`, `policy`, `log`) |
| Heatmap agent | `agent-llm.js` (pure: system prompt, LLM tool list, question ↔ decision-model mapping, `decisionAdvice`, `createRetryGuard`, limits), `agent-runner.js` (chat loop via the OpenRouter SDK, page images with rulers and overlays, Jev calls), `agent-panel.js` (Agent card UI, Needs review) |
| Entry | `app.js` creates the workspace, both tools, `window.colormeris` and the agent panel |

Vendored in `assets/vendor/`: pdf.js 6.3.289, JSZip 3.10.2, and the OpenRouter SDK 1.4.10 as an IIFE bundle (`OpenRouterSDK.OpenRouter`, 834 KB, loaded lazily by the Agent card). `assets/img/` (which holds `example.pdf`, a 26-page paper on ionizable lipids for mRNA delivery, with heatmaps on pages 3 and 5) is git-ignored.

### Agent design decisions (and why)

- **Coordinates** are always page pixels of the rendered page image. The LLM gets images of regions with rulers on the **bottom and right**, so image pixel (0, 0) is the region's top-left corner, and each note states `page = x0 + image / scale`. Rulers on the left and top shifted every placement by the ruler width divided by the zoom; this was measured as (+18, +8) px at 2.56×.
- **Decisions**: `get_questions` produces typed questions (`confirm_grid_size`, `classify_flagged` for ≤ 3 flagged cells, `classify_flagged_cells` for more, `confirm_tick_order`, `confirm_extraction`). The runner sends each to the decision model (`/api/alpha/decisions`, `typesafe/jev-1.13`: choice, noul and score question types). `policy.minConfidence` (0.9) gates applying; lower answers are "escalated" to *Needs review*. `source: "human"` always applies.
- **Reviews** (`panel.review`) are stored with the `resultHash` of the values they judged. They are `stale` once the values change; rejected panels get a red dot and Redo / Accept anyway in *Needs review*.
- **Forgiving arguments**: `normalizeArgs` drops `null` optionals, and `add_tick` with both `at` and `t` uses `at`. Models did send both, which caused endless "give exactly one of t or at" loops.
- **Retry guard**: 3 attempts per tool per panel, then blocked; 3 `resolve_questions` per panel; the run stops after 8 failures in a row.
- **Docs**: `docs/agent.md` is generated from the schemas, prompt and limits by `scripts/agent-docs.mjs`. After changing any action, prompt or limit, run `npm run docs`.

## Conventions

- Match the surrounding code: small functions, comments that explain *why*, and the existing naming. README and docs use short, plain sentences.
- Commit only when the user says "commit". Messages have a short title and a body explaining why, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The branch is `main`; nothing has been pushed by Claude.
- Add a unit test for pure logic (`tests/*.test.js`); browser behaviour is checked in the preview.

## Browser testing tips (Claude's built-in browser)

- The dev server caches aggressively. After editing, `fetch('/assets/js/<file>', {cache: 'reload'})` for the changed files, then load `app.html?v=<n>#heatmap` with a new `n`.
- When the Browser pane is hidden, `requestAnimationFrame` is paused, so pdf.js page rendering (`open_url` of a PDF, `go_to_page`) stalls. Start the call without awaiting it, then take a `screenshot` (which advances frames) and poll.
- `javascript_tool` calls time out after 45 s. Start long agent runs with a click and poll in separate calls.
- Opening a file over an existing project calls `confirm()`; set `window.confirm = () => true` first.
- The agent can be exercised without cost by assigning a mock `globalThis.OpenRouterSDK = { OpenRouter: class { get chat() {…} get alpha() {…} get models() {…} } }` before pressing *Run agent* (scripted `toolCalls` and decision answers).
- Synthetic test figure with known truth: draw a viridis grid on a canvas (e.g. cells from (237,143) to (887,663), colorbar at x 960–985, y 150–650, ticks 0/50/100), pass `canvas.toDataURL()` to `open_url`, and compare the agent's `set_grid` / `set_colorbar` against it.

## Status (2026-09-30)

Done and committed (latest first): `e11c195` (forgiving `add_tick`, retry caps, generated docs), `3842612` (ruler offset fix, persistent reviews, proxy), `d5a8c89` (OpenRouter agent), `00b009b` (typed agent API), then the IVIS tool and earlier heatmap work.

Verified with real runs on `example.pdf` page 5 (Fig 2f, "Oxidative stress", 9 × 12): the grid and colorbar land on the figure at the first try; no `add_tick` errors. Jev answered `confirm_extraction` with only 56–64% confidence, so it went to *Needs review*.

### Open issues and next steps

1. *Redo with agent* (rejected panel → focused rerun) is implemented but not yet run for real.
2. Jev is unsure on `confirm_extraction`. It could get more evidence, e.g. reconstruction ΔE statistics, label/grid count agreement, or tick coverage of the value range.
3. The LLM can set rows/cols directly (`set_grid` with rows/cols, `set_grid_size`), which skips the Jev grid-size check.
4. Exclusions (`excluded` in results) are not applied to the CSV exports, and `agent/*.json` logs are not reloaded from a zip.
5. No typed questions yet for tick-label reading or colorbar direction (would need OCR/vision evidence).
6. The agent only handles heatmaps, not IVIS.
7. The research plan in [docs/research.md](docs/research.md) (synthetic benchmark, VLM baselines, IVIS validation, Jev calibration curves) has not been started.
