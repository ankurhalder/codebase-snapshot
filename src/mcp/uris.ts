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
  "snapshot://reports/audit",
  "snapshot://reports/tree",
  "snapshot://reports/navigation",
  // Written only when the matching flag is on; reading one of these from a snapshot that has no
  // such report is a not-found with the reason, which is a better answer than an empty document.
  "snapshot://reports/diff",
  "snapshot://reports/log",
  "snapshot://reports/tokens",
];

/** Parameterised resource families, advertised through `resources/templates/list`. */
export const RESOURCE_TEMPLATE_URIS: readonly string[] = ["snapshot://parts/{index}"];
