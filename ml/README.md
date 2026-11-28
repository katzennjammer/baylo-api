# Baylo in-house models

Small models trained on Baylo's own listings, to stand in for the paid AI calls:

- **A. Photo → category**: MobileNetV3-Large, transfer learning. Exported as `baylo-classifier.onnx` (about 14 MB), with two outputs: category logits and a 960-d photo embedding.
- **B. Value estimate**: Ridge regression on title words, category, condition and (optionally) the photo embedding. Exported as `value-model.json`, plain weights the server can run in TypeScript. It is compared against Baylo's current rule-based estimate.
- **C. Duplicate check**: cosine similarity of photo embeddings, with a threshold chosen on an ROC curve. Exported as `dup-threshold.json`.

## Run it

1. Export the training data (read-only, from `D:\BAYLO\baylo` or wherever the API repo is):
   ```
   npx tsx --tsconfig tsconfig.json --env-file=.env scripts/export-training-data.ts
   ```
   This writes `ml-data/items.csv` (git-ignored) and prints listings and photos per category.
2. Open `ml/baylo_models.ipynb` in Google Colab (File → Upload notebook).
3. Runtime → Change runtime type → **T4 GPU**, then Runtime → **Run all**. Upload `items.csv` when asked.
4. At the end `baylo-models.zip` downloads. It holds the three model files, `summary.json` and the charts (confusion matrix, duplicate ROC curve, value bracket accuracy) for the manuscript.

Nothing here changes the live app. Wiring the models into the API comes after the numbers have been reviewed, behind an `AI_PROVIDER=local` flag that is off by default.
