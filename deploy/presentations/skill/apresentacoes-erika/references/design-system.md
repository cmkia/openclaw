# Erika dark v1

This presentation system is derived from the supplied chapter 21, 22, and 23 decks and their inspected renders. It is a slide composition guide, separate from the web UI reference in the original `DESIGN.md`. The renderer owns executable theme and geometry; this document explains how to choose content and layouts.

## Canvas and hierarchy

- Widescreen 16:9; compose for 13.333 × 7.5 inches.
- Near-black canvas `08090A`; optional panels `0F1011` and `161718`; restrained dividers `23252A`.
- Primary text `FFFFFF`; secondary text `D0D6E0`; metadata `8A8F98`. Avoid using low-contrast metadata colors for main teaching content.
- Main accent blue `2F81F7`; secondary violet `6366F1`; cyan `02B8CC`. Maintain the same color meaning across slides and label distinctions in words as well as color.
- Use Inter. The container includes a compatible fallback; verify final line breaks when substituting fonts. Titles around 30–36 pt, body at least 20 pt, table text at least 18 pt. References can be smaller when they are secondary to complete speaker-note citations. Do not shrink text to force a crowded slide to fit.
- Generous outside margins, a clear title zone, consistent content baseline, restrained footer and slide number. Body copy should fit at presentation distance. The original decks' tiny footer is metadata, not a model for body text.

## Layout selection

- **Cover:** short title and topic label on the left; a single conceptual biomedical image on the right when useful. Use `cover`, optionally with `image`.
- **Section:** one clear change of topic. Use only when the roteiro permits an extra slide.
- **Bullets:** one argument supported by three to five short points; six is the hard maximum. Long explanations belong in speaker notes.
- **Image:** a clean figure with concise explanatory copy. Keep labels native and verify anatomy/mechanism against the source. Conceptual imagery cannot replace a diagram required by the roteiro.
- **Comparison:** parallel left and right headings and short points. Use blue/violet to reinforce a textual distinction, with equivalent visual weight.
- **Table:** native cells, explicit column units, compact wording, few rows. Do not paste a screenshot of a readable table when native cells are possible.
- **Chart:** native data series, readable labels and units, source and limitations. Use a bar chart for category comparisons and a line chart for an ordered quantitative axis. Never draw a clinical curve from image-generation output.
- **Conclusion:** concise takeaways, faithful to the source. Avoid introducing a new claim in the last slide.

The fixed engine implements these reusable layouts. It does not promise a pixel-for-pixel reproduction of every legacy composition. Complex molecular diagrams in the old decks are visual references, not an additional unsupported layout.

## Inspected visual examples

All assets are supplied presentation renders, retained for composition reference. They are flattened examples and must not be used as finished slides or clinical evidence in a new deck.

- `assets/reference-cover.png`: chapter 21, slide 1. Split cover, strong title hierarchy, restrained accent, right-side illustration.
- `assets/reference-diagram.png`: chapter 22, slide 13. Spacious relationships, editable-looking labels, blue/violet distinction. A new mechanism still needs scientific verification.
- `assets/reference-comparison.png`: chapter 23, slide 2. Parallel concepts and a dark illustration behind the content zone; legibility takes priority over background detail.
- `assets/reference-table.png`: chapter 23, slide 15. Structured native table, limited colors, clear takeaway.
- `assets/reference-chart.png`: chapter 23, slide 18. Native bars and direct labels; the displayed clinical values require their original references if reused. This PNG supplies style only.

Inspect the reference matching the intended layout before composing. The example assets total approximately 1.9 MiB and contain no patient records.
