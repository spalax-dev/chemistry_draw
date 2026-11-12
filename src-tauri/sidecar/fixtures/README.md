# Classifier test fixtures

Small images copied verbatim from the upstream
[DECIMER Image Classifier](https://github.com/Iagea/DECIMER-Image-Classifier)
repository, plus one WebP re-encode derived from `caffeine.png`. They feed the
model-gated tests for `POST /v2/filter/classify`; they are never bundled with
the application and are not used at runtime.

Upstream license: **MIT** (see `NOTICE` at the repository root for
attribution).

| File                            | Bytes  | Source                                                                                                                | Expected category |
| ------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `caffeine.png`                  | 24,609 | <https://raw.githubusercontent.com/Iagea/DECIMER-Image-Classifier/main/tests/caffeine.png>                            | `structure`       |
| `caffeine.webp`                 | 8,752  | Lossy WebP re-encode of `caffeine.png` (quality 90)                                                                   | `structure`       |
| `chinese_character.jpg`         | 1,962  | <https://raw.githubusercontent.com/Iagea/DECIMER-Image-Classifier/main/tests/chinese_character.jpg>                   | `no-structure`    |
| `random_scatter_plot_64933.png` | 37,999 | <https://raw.githubusercontent.com/Iagea/DECIMER-Image-Classifier/main/examples/images/random_scatter_plot_64933.png> | `no-structure`    |

The ONNX model itself is never committed; see `docs/architecture.md` section 6
and `models/manifest.json` for how to provide it locally.
