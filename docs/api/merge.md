# Merge

`merge_simulation_files` combines multiple scene JSON files that share the same
bodies/terrain into one scene with extra batches, resampling every file but the
first onto the first file's timeline by nearest timestamp. See
[Comparing multiple runs](../usage/cli.md#comparing-multiple-runs-eg-real-world-vs-simulated)
for the CLI-facing version of this.

::: simview.merge.merge_simulation_files
