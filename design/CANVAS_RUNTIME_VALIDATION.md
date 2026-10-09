# Real Canvas gameplay validation — 9 October 2026

Tested source fingerprint: `b567714cd925fcdc73def74b11725dce31e901abfb927e87ca49ff491eae0d7e`.

The isolated candidate passed real remote tile delivery, worker decoding and rendered Canvas gameplay in Chromium at 1188 × 761 CSS pixels, DPR 1, during 18:13–18:24 UTC. Normal keyboard/pointer input was used. The normal `stream=1` route also worked without test controls. No HUD fixture or injected simulation substituted for gameplay.

## Passed

- Selecting a real Pushkin-area 10 × 10 km square displayed roads, water/land context, building occupancy and the hole.
- Several kilometres of ordinary keyboard travel consumed 41,552 m² and grew the hole from 18 m to 53.08 m. Camera growth kept the hole diameter near 21% of the short viewport dimension. The first milestone advanced the goal from 10,000 to 50,000 m².
- Coverage residency reached its 36-chunk limit. The southern arena clamp matched `−5000 + radius` exactly.
- Pause, save, full page reload and same-square re-entry restored exact area, position and radius. Nearby geometry restarted at two resident chunks.
- A 234 m out-and-back trip on cleared ground gave no repeated reward. A real joystick drag moved 14.3 m and consumed 28 m²; reversing it added zero, and release stopped movement.
- Pause/resume, return-to-map, saved-square re-entry and Escape cancellation during renderer loading passed. Overview dragging did not select a square.
- No application errors were collected. All 261 project tests and 117 independent checks passed against the frozen candidate.

## Observed measurements

- Internal game-entry time: 1,174 ms. First observed playing state was within a 9,624 ms tool-round-trip upper bound from click. Browser caches were not forcibly cleared, so this is not a controlled cold-start benchmark.
- Initial gameplay/background source: 1 metadata + 4 native tiles, 431,331 response-payload bytes. The background reused a native tile. Initial overview separately: 1 metadata + 8 visual tiles, 811,160 bytes. Combined source payload: 1,242,491 bytes, excluding application/fonts/search assets and not compressed wire traffic.
- After long travel: 11 native tiles requested, 587,043 gameplay/background payload bytes, 36 coverage chunks and 10 visual bitmaps (10 MiB pixels).
- During movement, the app's rolling display was approximately 60 FPS on this desktop. Sampled last-120-frame mean JavaScript simulation/render-call CPU was 0.66–0.97 ms; maxima 1.1–4 ms, and one pointer sample reached 10.5 ms. Compositor/GPU time is excluded.
- Reload re-entry: 694 ms observed click-to-playing, 383 ms internally; one native tile plus metadata, 28,247 bytes. Persistent consumption was preserved.

## Not established

Physical-phone performance, a fresh narrow-viewport runtime test, live radius-500 gameplay, a controlled comparison against the earlier full-sector Luga import, forced live source failures and changed source revisions. Those bounds/errors have component tests, not equivalent real-device evidence. The 2 m building grid is visibly simplified, and magnified 512 px basemap tiles can look soft. Legacy whole-building/prepared modes still require WebGL2; this report covers Canvas streaming only.
