/**
 * The `snapshot://` URI set, in one place.
 *
 * Both the resource provider and the `describe` contract publish these, and `describe` must not
 * import the provider — the provider reads the manifest, and the contract has to be printable in a
 * repository that has never been generated. A leaf module keeps both honest without a cycle.
 */

/** Resources that exist regardless of what is on disk, in the order `resources/list` reports them. */
export const STATIC_RESOURCE_URIS: readonly string[] = [
  "snapshot://manifest",
  "snapshot://contract",
  "snapshot://skill",
  "snapshot://prompt",
];

/**
 * Report resources, listed only when the run wrote the file.
 *
 * They are not in {@link STATIC_RESOURCE_URIS} because a resource in `resources/list` has to be
 * readable, and `--include-diffs`, `--include-logs` and `--token-tree` are opt-in. The contract
 * publishes them separately so a client can know they exist without being promised one.
 */
export const REPORT_RESOURCE_URIS: readonly string[] = [
  "snapshot://reports/audit",
  "snapshot://reports/tree",
  "snapshot://reports/navigation",
  "snapshot://reports/diff",
  "snapshot://reports/log",
  "snapshot://reports/tokens",
];

/** Parameterised resource families, advertised through `resources/templates/list`. */
export const RESOURCE_TEMPLATE_URIS: readonly string[] = ["snapshot://parts/{index}"];
