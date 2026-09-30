# Research notes: prior work, novelty and experiments

Working notes from the 2026-09 planning sessions. Items marked † were recalled from memory and not re-checked; verify them before citing.

## Prior work

### Colormap inversion (recovering values from colors)

- **Poco, Mayhua & Heer, "Extracting and Retargeting Color Mappings from Bitmap Images of Visualizations"** (IEEE VIS 2017 / TVCG 2018). This is the standard method precedent: it classifies the legend, extracts legend text with OCR and recovers the value↔color mapping. [UW IDL](https://idl.uw.edu/papers/extracting-color-mappings)
- **Yuan et al., "Deep Colormap Extraction from Visualizations"** (TVCG ~2022)†. A CNN recovers the colormap without a clean legend.
- **"Data Extraction of Circular-Shaped and Grid-like Chart Images"** (J. Imaging 2022). [PMC](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9147858/)
- **"Learning to extract data from the geospatial heatmap visualizations"** (J. Visualization 2026). GAN layer decoupling plus SLIC color decoding. [Springer](https://link.springer.com/article/10.1007/s12650-026-01120-w)
- **"Interactive Extraction of High-Frequency Aesthetically-Coherent Colormaps"** (arXiv 2607.26025). [arXiv](https://arxiv.org/pdf/2607.26025)
- Informal and commercial: Shape of Code blog post (2015, RGB → legend lookup), AI Graph Reader (palette-calibrated heatmap digitizer), and WebPlotDigitizer† (no colormap mode).

### Chart-understanding benchmarks with heatmaps

- **ChartX / ChartVLM** (arXiv 2402.12185): 18 chart types including heatmaps, with a chart-to-CSV "structural extraction" task.
- **ChartBench** (arXiv 2312.15915): mostly unannotated charts, where values must be read from the visual encoding.
- **OneChart** (arXiv 2404.09987), **Self-Ensembling VLMs for chart data extraction** (arXiv 2605.27298), CharXiv† and ChartMimic† (real scientific figures). ChartQA (arXiv 2203.10244) has few heatmaps.

### Agents, LLM-native interfaces and verified actions

- **"Figures as Interfaces: Toward LLM-Native Artifacts" (Nexus)**, arXiv 2604.08491. This is the closest prior work: figure↔data mappings for LLMs.
- **"Exploring LLM Agent Designs … for Scientific Visualization"**, arXiv 2604.27996: GUI agents compared with agents that call an API directly.
- **"Every Software as an Agent"** (arXiv 2502.04747), UFO, OmniParser V2, and the survey of LLM GUI agents (arXiv 2411.18279).
- **VeriSafe Agent** (MobiCom '25, arXiv 2503.18492), which checks each action logically before it runs, and **VeriGuard** (arXiv 2510.05156). These are rule-based, not calibrated confidence.

### Decision models (Jev and similar)

- **Jev** (TypeSafe AI, released 2026-09-15): a non-autoregressive "System 1" model that returns typed, calibrated decisions (choice with probabilities, noul = probability a statement is true, score) instead of text. On OpenRouter it is served at `POST /api/alpha/decisions` with `{model, state, questions}` → `{answers, usage}`; the SDK call is `client.alpha.decisions.create({ decisionsRequest })`. Models: `typesafe/jev-1.13`, `~typesafe/jev-latest`. [OpenRouter tutorial](https://openrouter.ai/blog/tutorials/how-to-use-jev/), [TypeSafe docs](https://docs.typesafe.ai/introduction)
- Other OpenRouter decision models (`output_modalities=decisions`): `upstage/solar-decide`, `respan/span-01(-lite)`, `jaredpalmer/kev-4b`.

## What is novel in Colormeris

Not novel: inverting a colormap through its legend (Poco et al. 2017).

Likely novel or underserved:

1. **Quantifying published IVIS (bioluminescence) figures**: separating the overlay from the photo by CIELAB chroma, ROI totals like total flux and radiance, regions copied into every animal box, and a scale bar. Chart work covers statistical charts, not luminescence overlays. Before claiming "first", run a targeted prior-art search ("IVIS figure re-quantification", "bioluminescence image digitization").
2. **Verifiable extraction**: a CIEDE2000 ΔE and flag for every cell, a reconstruction overlay, and the sampled RGB kept with each value. This contrasts with VLM extraction, which gives no per-value confidence.
3. **Reproducible project archives**: source, page images, calibration, data, and now the agent's action and decision logs.
4. **Agent contribution**: calibrated, typed decisions (Jev) decide when the agent acts on its own and when it hands off to a human, with an audit trail. This is a human-in-the-loop design where people review only the uncertain steps. Pair it with a typed action API rather than pixel clicking, and keep the decision layer model-agnostic (Jev is one backend) to avoid tying the paper to a new commercial model.

Suggested framing: "a human-in-the-loop, auditable tool for recovering quantitative data from color-encoded figures in the biomedical literature, including (to our knowledge) the first workflow for ROI quantification of published IVIS images."

## Experiment plan (not started)

1. **Ground-truth benchmark**: synthetic heatmaps from matplotlib, seaborn and ggplot, varying the colormap (viridis, jet, RdBu, log), grid size, DPI, JPEG quality and in-cell annotations. Add real figures that have Source Data. Metrics: MAE / max error as a fraction of the colorbar range, Spearman correlation, and whether ΔE flags catch the bad cells. Include a colormap failure analysis (jet and non-monotonic maps).
2. **Head-to-head comparison**: Colormeris (manual), Colormeris agent, GPT/Claude/Gemini zero-shot "extract the matrix", ChartVLM/OneChart, and reading by eye. Compare accuracy and time per figure.
3. **IVIS validation**: raw Living Image data against figure extraction (total flux and radiance correlation, Bland–Altman plots, preservation of group ranking and fold-change), after JPEG, downsampling and PDF degradation.
4. **Reproducibility across users**: 3–5 users, measuring ICC and time.
5. **Agent-specific**:
   - A reliability diagram of Jev confidence against actual error.
   - A curve of human effort against accuracy as the escalation threshold varies.
   - A four-way comparison: VLM computer use, LLM + typed API, LLM + Jev, and a human.
   - Success rate on the first attempt.
6. **Scientific use case**: a meta-analysis that pools IVIS data or heatmap values across published delivery studies (LNP, AAV and so on).

Minimum package for a methods paper: experiments 1–3 plus a small version of 6. Candidate venues: Nature Methods, PLOS Comp Bio (software), Bioinformatics.
